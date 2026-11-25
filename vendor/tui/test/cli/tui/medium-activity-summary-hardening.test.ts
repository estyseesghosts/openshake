import { expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client"
import {
  mediumActivitySummary,
  mediumExecuteFailed,
  mediumExecuteMetadataFailed,
  mediumEditsSummary,
} from "../../../src/routes/session/medium-activity-summary"

test("shell and execute keep distinct semantic counts regardless of arrival order", () => {
  const shellThenExecute = mediumActivitySummary([{ name: "shell" }, { name: "execute" }])
  const executeThenShell = mediumActivitySummary([{ name: "execute" }, { name: "shell" }])
  expect(shellThenExecute).toBe("Ran 1 command, ran 1 script")
  expect(executeThenShell).toBe(shellThenExecute)
  expect(mediumActivitySummary([{ name: "bash" }, { name: "execute" }, { name: "shell" }])).toBe(
    "Ran 2 commands, ran 1 script",
  )
})

test("semantic categories still aggregate searches and edits by their shared phrase", () => {
  expect(mediumActivitySummary([{ name: "glob" }, { name: "grep" }, { name: "websearch" }])).toBe(
    "Searched 3 times",
  )
  expect(mediumEditsSummary([{ name: "edit" }, { name: "write" }, { name: "patch" }])).toBe("Edited 3 files")
  expect(mediumActivitySummary([{ name: "read" }, { name: "shell" }, { name: "webfetch" }])).toBe(
    "Read 1 file, ran 1 command, fetched 1 page",
  )
})

test("nested execute failures are detected from progress or success metadata", () => {
  expect(mediumExecuteMetadataFailed({ toolCalls: [{ tool: "read", status: "error" }] })).toBe(true)
  expect(mediumExecuteMetadataFailed({ toolCalls: [{ tool: "read", status: "completed" }] })).toBe(false)
  expect(mediumExecuteMetadataFailed({ toolCalls: [{ tool: "read", status: "running" }] })).toBe(false)
  expect(mediumExecuteMetadataFailed(null)).toBe(false)
  expect(mediumExecuteMetadataFailed({ toolCalls: "broken" })).toBe(false)
})

test("a completed execute part still reports a nested failure while other tools do not", () => {
  const part = (name: string): SessionMessageAssistantTool => ({
    type: "tool",
    id: "t",
    name,
    time: { created: 1, completed: 2 },
    state: {
      status: "completed",
      input: {},
      content: [],
      metadata: { toolCalls: [{ tool: "read", status: "error" }] },
    },
  })
  expect(mediumExecuteFailed(part("execute"))).toBe(true)
  expect(mediumExecuteFailed(part("read"))).toBe(false)
})
