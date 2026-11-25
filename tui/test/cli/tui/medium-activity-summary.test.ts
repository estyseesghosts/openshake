import { expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client"
import {
  mediumActivitySummary,
  mediumEditFileCount,
  mediumEditsSummary,
  mediumLiveLine,
} from "../../../src/routes/session/medium-activity-summary"

const running = (name: string, input: unknown = {}, metadata: Record<string, unknown> = {}) =>
  ({
    type: "tool",
    id: "t",
    name,
    time: { created: 1 },
    state: { status: "running", input, metadata },
  }) as SessionMessageAssistantTool

const completed = (name: string) =>
  ({
    ...running(name),
    time: { created: 1, completed: 2 },
    state: { status: "completed", input: {}, content: [], metadata: {} },
  }) as SessionMessageAssistantTool

test("medium activity summary uses semantic verb phrases ordered by first appearance", () => {
  expect(mediumActivitySummary([{ name: "read" }])).toBe("Read 1 file")
  expect(mediumActivitySummary(Array.from({ length: 4 }, () => ({ name: "read" })))).toBe("Read 4 files")
  expect(mediumActivitySummary(Array.from({ length: 3 }, () => ({ name: "grep" })))).toBe("Searched 3 times")
  expect(mediumActivitySummary(Array.from({ length: 2 }, () => ({ name: "bash" })))).toBe("Ran 2 commands")
  expect(
    mediumActivitySummary([
      { name: "read" },
      { name: "shell" },
      { name: "read" },
      { name: "shell" },
      { name: "webfetch" },
    ]),
  ).toBe("Read 2 files, ran 2 commands, fetched 1 page")
})

test("medium edit summary carries parsed additions and deletions", () => {
  expect(mediumEditsSummary(Array.from({ length: 4 }, () => ({ name: "edit" })), 31, 12)).toBe(
    "Edited 4 files · +31 −12",
  )
  expect(mediumEditsSummary([{ name: "apply_patch" }])).toBe("Edited 1 file")
})

test("one apply_patch call counts every file it changed, not one tool call", () => {
  const patch = {
    ...completed("apply_patch"),
    state: {
      status: "completed",
      input: {},
      content: [],
      metadata: {
        files: [
          { path: "a.ts", additions: 2 },
          { path: "b.ts", additions: 3 },
          { path: "c.ts", deletions: 1 },
        ],
      },
    },
  } as SessionMessageAssistantTool
  expect(mediumEditFileCount(patch)).toBe(3)
  expect(mediumEditFileCount(completed("edit"))).toBe(1)
  expect(mediumEditsSummary([{ name: "apply_patch", files: mediumEditFileCount(patch) }], 5, 1)).toBe(
    "Edited 3 files · +5 −1",
  )
  expect(mediumEditsSummary([{ name: "apply_patch", files: 3 }, { name: "edit" }])).toBe("Edited 4 files")
})

test("medium live line shows the running child's identity, not its output", () => {
  expect(mediumLiveLine(running("read", { path: "src/app.ts" }))).toBe("Reading src/app.ts")
  expect(mediumLiveLine(running("shell", { command: "bun test" }))).toBe("$ bun test")
  expect(mediumLiveLine(running("grep", { pattern: "SessionRow" }))).toBe('Searching "SessionRow"')
  expect(mediumLiveLine(running("execute", {}, { toolCalls: [{ tool: "read", status: "running", input: { path: "a.ts" } }] }))).toBe(
    "Reading a.ts",
  )
  expect(mediumLiveLine(completed("read"))).toBe("")
})

test("medium live line stays single-line and width-clamped", () => {
  const long = `src/${"x".repeat(120)}\nrm -rf /`
  expect(mediumLiveLine(running("read", { path: long }))).not.toContain("\n")
  expect(mediumLiveLine(running("read", { path: long })).length).toBeLessThanOrEqual(64)
})
