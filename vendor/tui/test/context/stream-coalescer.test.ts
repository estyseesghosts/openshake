import { expect, test } from "bun:test"
import { StreamCoalescer, type StreamEntry } from "../../src/context/stream-coalescer"

function setup() {
  const applied: StreamEntry[] = []
  const scheduled: Array<() => void> = []
  const coalescer = new StreamCoalescer((entry) => applied.push(entry), (flush) => scheduled.push(flush))
  return { coalescer, applied, scheduled }
}

test("many deltas to one part publish one Byte-for-byte identical string", () => {
  const { coalescer, applied, scheduled } = setup()
  const pieces = ["a", "b", "c", "d", "e"]
  for (const piece of pieces) coalescer.text("s", "m", piece)
  expect(applied).toHaveLength(0)
  expect(scheduled).toHaveLength(1)
  scheduled[0]!()
  expect(applied).toHaveLength(1)
  expect(applied[0]!.text).toBe(pieces.join(""))
  expect(scheduled).toHaveLength(1)
})

test("interleaved text, reasoning and tool streams stay independent", () => {
  const { coalescer, applied, scheduled } = setup()
  coalescer.text("s", "m", "hello ")
  coalescer.reasoning("s", "m", "plan")
  coalescer.toolInput("s", "m", "t1", '{"pa')
  coalescer.text("s", "m", "world")
  coalescer.reasoning("s", "m", "!")
  coalescer.toolInput("s", "m", "t1", 'th":"a"}')
  coalescer.toolProgress("s", "m", "t2", { step: 1 })
  coalescer.toolProgress("s", "m", "t2", { step: 2 })
  coalescer.flush()
  expect(applied.map((entry) => [entry.kind, entry.partID, entry.text ?? entry.metadata])).toEqual([
    ["text", "text", "hello world"],
    ["reasoning", "reasoning", "plan!"],
    ["tool-input", "t1", '{"path":"a"}'],
    ["tool-progress", "t2", { step: 2 }],
  ])
})

test("flush before a lifecycle event makes the final payload win", () => {
  const { coalescer, applied } = setup()
  coalescer.text("s", "m", "partial")
  coalescer.flush()
  expect(applied.at(-1)?.text).toBe("partial")
  coalescer.flush()
  expect(applied).toHaveLength(1)
})

test("dispose drops buffered data so a reconnect cannot publish stale content", () => {
  const { coalescer, applied, scheduled } = setup()
  coalescer.text("old", "m", "stale")
  coalescer.dispose()
  scheduled[0]!()
  expect(applied).toHaveLength(0)
  coalescer.text("new", "m", "fresh")
  coalescer.flush()
  expect(applied).toEqual([
    { sessionID: "new", messageID: "m", partID: "text", kind: "text", text: "fresh" },
  ])
})
