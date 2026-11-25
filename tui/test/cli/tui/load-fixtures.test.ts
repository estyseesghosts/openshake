import { expect, test } from "bun:test"
import { defaultWindowBudgets } from "../../../src/context/message-window"
import {
  createLoadFixture,
  runLoadBenchmark,
  type LoadScale,
} from "../../../src/util/load-benchmark"

const scale: LoadScale = {
  sessions: 12,
  messagesPerSession: 120,
  assistants: 4,
  deltaRounds: 40,
  screenshotBytes: 4096,
  diffLines: 3_000,
}

test("load fixtures are deterministic and model interleaved agents and tools", () => {
  const first = createLoadFixture(scale)
  const second = createLoadFixture(scale)
  expect([...first.messages.values()].flat().length).toBe(
    scale.sessions * (scale.messagesPerSession + Math.ceil(scale.messagesPerSession / 50)),
  )
  expect(first.messages.size).toBe(scale.sessions)
  expect(first.diff).toBe(second.diff)
  expect(first.diff.split("\n")).toHaveLength(scale.diffLines)
  expect(first.screenshots).toEqual(second.screenshots)

  const all = [...first.messages.values()].flat()
  const agents = new Set(all.flatMap((message) => (message.type === "assistant" ? [message.agent] : [])))
  expect(agents.size).toBe(scale.assistants)
  const tools = new Set(
    all.flatMap((message) =>
      message.type === "assistant" ? message.content.flatMap((part) => (part.type === "tool" ? [part.name] : [])) : [],
    ),
  )
  expect(tools.has("edit")).toBe(true)
  expect(tools.has("shell")).toBe(true)
  expect(all.some((message) => message.type === "idle")).toBe(true)
})

test("the benchmark coalesces events and keeps row mutations bounded", async () => {
  const report = await runLoadBenchmark(scale)
  expect(report.events).toBeGreaterThanOrEqual(scale.deltaRounds * scale.assistants * 4)
  // One publication per part per drained frame, not one per network delta.
  expect(report.publications).toBeLessThanOrEqual(scale.deltaRounds * scale.assistants + 1)
  expect(report.publications).toBeLessThan(report.events / 3)
  expect(report.rowMutations).toBeGreaterThanOrEqual(scale.assistants)
  expect(report.rowMutations).toBeLessThanOrEqual(
    scale.assistants * scale.sessions + Math.ceil(scale.deltaRounds / 50) * 25,
  )
  expect(report.compactions).toBe(1)
  expect(report.terminalPayload.endsWith("final")).toBe(true)
  expect(report.firstFrameLatencyMs).toBeGreaterThanOrEqual(0)
  expect(report.residentBytesBySession.size).toBe(scale.sessions)
  expect(report.peakResidentBytes).toBeGreaterThanOrEqual(report.residentTranscriptBytes)
  expect(report.diffChunks).toBeGreaterThan(0)
})

test("the benchmark exercises real createData handling, retention and rendered diffs", async () => {
  const report = await runLoadBenchmark(scale)
  // Real event handling and row projection, not just direct unit calls.
  expect(report.realPath.messages).toBeGreaterThan(0)
  expect(report.realPath.rows).toBeGreaterThan(0)
  expect(report.realPath.resident).toBeGreaterThan(0)
  // Hidden tabs: leaving sessions evicts their transcripts, returning reloads one.
  expect(report.realPath.evicted).toBeGreaterThan(0)
  expect(report.realPath.reloaded).toBeGreaterThan(0)
  // The giant diff is actually mounted through PatchDiff, not merely partitioned.
  expect(report.diffRender.chunks).toBeGreaterThan(0)
  expect(report.diffRender.mounted).toBeGreaterThan(0)
  expect(report.diffRender.diffNodes).toBeGreaterThan(0)
  // Wall-clock frames stay opt-in and out of ordinary CI assertions.
  expect(report.frameTimings).toBeUndefined()
})

test("resident transcript and media bytes stay under configured ceilings", async () => {
  const report = await runLoadBenchmark(scale)
  expect(report.residentTranscriptBytes).toBeLessThan(defaultWindowBudgets.tailBytes)
  expect(report.residentMediaBytes).toBeLessThanOrEqual(scale.screenshotBytes * 2)
  expect(report.retainedBytes).toBe(report.residentTranscriptBytes + report.residentMediaBytes)
})
