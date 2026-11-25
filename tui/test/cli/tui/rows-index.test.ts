import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { groupID } from "../../../src/routes/session/anchors"
import { append, type PartRef, type SessionRow } from "../../../src/routes/session/grouping/session"
import { PartIndex } from "../../../src/routes/session/rows-index"
import { reduceSessionRows } from "../../../src/routes/session/rows"

const model = { id: "model", providerID: "provider" }
const assistant = (id: string, content: SessionMessageAssistant["content"]): SessionMessageAssistant => ({
  type: "assistant",
  id,
  agent: "build",
  model,
  time: { created: 1, completed: 2 },
  content,
})

test("10,000 deltas to one materialized part cause exactly one structural insert", () => {
  const rows: SessionRow[] = []
  const index = new PartIndex()
  const ref: PartRef = { messageID: "a", partID: "text:0" }
  let mutations = 0
  for (let i = 0; i < 10_000; i++) {
    index.materialize(ref, () => {
      mutations++
      append(rows, ref, { type: "text" }, rows.length, "high")
    })
  }
  expect(mutations).toBe(1)
  expect(rows).toHaveLength(1)
  expect(index.size).toBe(1)
  expect(index.has(ref)).toBe(true)
})

test("a new part after rebuild is indexed while old refs stay materialized", () => {
  const messages: SessionMessageInfo[] = [
    assistant("a", [
      { type: "reasoning", text: "Plan", time: { created: 1, completed: 2 } },
      { type: "text", text: "Done" },
    ]),
  ]
  const index = new PartIndex()
  const first = reduceSessionRows(messages, new Set(), false, "high")
  index.rebuild(first)
  expect(index.size).toBe(2)
  const reasoning: PartRef = { messageID: "a", partID: "reasoning:0" }
  const text: PartRef = { messageID: "a", partID: "text:0" }
  expect(index.has(reasoning)).toBe(true)
  expect(index.has(text)).toBe(true)

  // A prepended page replaces the projection; the indexes follow it atomically.
  const prepended = [
    { type: "user", id: "u", text: "Go", time: { created: 0 } } as SessionMessageInfo,
    ...messages,
  ]
  index.rebuild(reduceSessionRows(prepended, new Set(), false, "high"))
  expect(index.has(reasoning)).toBe(true)
  let inserts = 0
  index.materialize({ messageID: "b", partID: "text:0" }, () => inserts++)
  expect(inserts).toBe(1)
  expect(index.size).toBe(3)
})

test("reasoning group ownership is rebuilt and resolves without scanning rows", () => {
  const messages: SessionMessageInfo[] = [
    assistant("a", [
      { type: "reasoning", text: "Plan", time: { created: 1, completed: 2 } },
      { type: "text", text: "Done" },
    ]),
  ]
  const rows = reduceSessionRows(messages, new Set(), false, "high")
  const index = new PartIndex()
  index.rebuild(rows)
  const ref: PartRef = { messageID: "a", partID: "reasoning:0" }
  const owner = index.owner(ref)
  expect(owner).toBeTruthy()
  expect(rows.some((row) => row.type === "group" && groupID(row, 0) === owner)).toBe(true)
  expect(index.owner({ messageID: "a", partID: "text:0" })).toBeUndefined()
})
