import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { activitySummary, busyLabel, summarizeActivity } from "../../../src/routes/session/activity-summary"
import {
  append,
  groupRefs,
  messagePath,
  partitionPending,
  partPath,
  type PartRef,
  type SessionEntry,
  type SessionRow,
} from "../../../src/routes/session/grouping/session"
import { reduceSessionRows, resolvePart } from "../../../src/routes/session/rows"
import { mediumActivitySummary, mediumEditsSummary } from "../../../src/routes/session/medium-activity-summary"

const model = { id: "model", providerID: "provider" }
const tool = (
  id: string,
  name: string,
  status: "completed" | "running" | "error" = "completed",
): SessionMessageAssistantTool => ({
  type: "tool",
  id,
  name,
  time: { created: 1, ...(status === "running" ? {} : { completed: 2 }) },
  state:
    status === "running"
      ? { status, input: {}, metadata: {} }
      : status === "error"
        ? { status, input: {}, error: { type: "Fixture", message: "failed" } }
        : { status, input: {}, content: [{ type: "text", text: "ok" }], metadata: {} },
})
const assistant = (
  id: string,
  content: SessionMessageAssistant["content"],
  finish?: "stop",
): SessionMessageAssistant => ({
  type: "assistant",
  id,
  agent: "build",
  model,
  time: { created: 1, completed: 2 },
  ...(finish ? { finish } : {}),
  content,
})
const instruction = (id: string, paths: string[]): SessionMessageInfo => ({
  type: "synthetic",
  id,
  text: "Instructions",
  description: `Loaded ${paths.join(", ")}`,
  metadata: { instruction: { paths } },
  time: { created: 1 },
})

test("high keeps reasoning and exploration grouping; other tools stand alone", () => {
  expect(partPath({ type: "reasoning" }, "high")).toEqual(["reasoning"])
  expect(partPath({ type: "tool", name: "read" }, "high")).toEqual(["exploration"])
  expect(partPath({ type: "tool", name: "webfetch" }, "high")).toEqual(["exploration"])
  expect(partPath({ type: "tool", name: "websearch" }, "high")).toEqual(["exploration"])
  expect(partPath({ type: "tool", name: "shell" }, "high")).toEqual([])
  expect(messagePath(instruction("i", ["AGENTS.md"]), "high")).toEqual(["instructions"])
})

test("medium folds repeatable work into semantic groups and leaves prose and instructions alone", () => {
  expect(partPath({ type: "reasoning" }, "medium")).toEqual(["reasoning"])
  expect(partPath({ type: "tool", name: "read" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "glob" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "grep" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "webfetch" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "websearch" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "shell" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "bash" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "execute" }, "medium")).toEqual(["medium-activity"])
  expect(partPath({ type: "tool", name: "edit" }, "medium")).toEqual(["medium-edits"])
  expect(partPath({ type: "tool", name: "write" }, "medium")).toEqual(["medium-edits"])
  expect(partPath({ type: "tool", name: "patch" }, "medium")).toEqual(["medium-edits"])
  expect(partPath({ type: "tool", name: "apply_patch" }, "medium")).toEqual(["medium-edits"])
  expect(partPath({ type: "text" }, "medium")).toEqual([])
  expect(messagePath(instruction("i", ["AGENTS.md"]), "medium")).toEqual(["instructions"])
})

test("medium leaves interactive, unknown and failed tools standalone", () => {
  expect(partPath({ type: "tool", name: "question" }, "medium")).toEqual([])
  expect(partPath({ type: "tool", name: "subagent" }, "medium")).toEqual([])
  expect(partPath({ type: "tool", name: "task" }, "medium")).toEqual([])
  expect(partPath({ type: "tool", name: "custom.plugin" }, "medium")).toEqual([])
  expect(partPath({ type: "tool", name: "read", error: true }, "medium")).toEqual([])
})

test("low wraps tools, thoughts and instruction loads in activity; text and other messages break it", () => {
  expect(partPath({ type: "reasoning" }, "low")).toEqual(["activity", "reasoning"])
  expect(partPath({ type: "tool", name: "read" }, "low")).toEqual(["activity", "exploration"])
  expect(partPath({ type: "tool", name: "shell" }, "low")).toEqual(["activity"])
  expect(partPath({ type: "text" }, "low")).toEqual([])
  expect(messagePath(instruction("i", ["AGENTS.md"]), "low")).toEqual(["activity", "instructions"])
  expect(messagePath({ type: "user", id: "u", text: "hi", time: { created: 1 } }, "low")).toEqual([])
  // Shell/subagent completion notices are ordinary synthetic messages without instruction metadata.
  expect(
    messagePath(
      {
        type: "synthetic",
        id: "s",
        text: "done",
        description: "bun test",
        metadata: { source: "shell" },
        time: { created: 1 },
      },
      "low",
    ),
  ).toEqual([])
})

test("low hydration nests subgroups inside one activity group per run", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "u", text: "Go", time: { created: 0 } },
    assistant("a", [
      { type: "reasoning", text: "Plan", time: { created: 1, completed: 2 } },
      tool("r1", "read"),
      tool("r2", "grep"),
    ]),
    instruction("i", ["AGENTS.md"]),
    assistant("b", [tool("sh", "shell"), tool("r3", "read"), { type: "text", text: "Done" }], "stop"),
  ]
  const rows = reduceSessionRows(messages, new Set(), false, "low")
  expect(rows.map((row) => (row.type === "group" ? `${row.kind}:${row.size}` : row.type))).toEqual([
    "message",
    "activity:6",
    "part",
    "assistant-footer",
  ])
  const activity = rows[1]
  if (activity.type !== "group") throw new Error("Expected activity")
  expect(activity.children.map((child) => (child.type === "group" ? child.kind : child.entry.type))).toEqual([
    "reasoning",
    "exploration",
    "instructions",
    "part",
    "exploration",
  ])
  expect(activity.completed).toBe(true)
})

test("medium hydration folds repeatable work and keeps instruction groups", () => {
  const messages: SessionMessageInfo[] = [
    assistant("a", [tool("r1", "read"), tool("w1", "webfetch")]),
    instruction("i1", ["AGENTS.md"]),
    instruction("i2", ["packages/tui/AGENTS.md"]),
    assistant("b", [tool("sh", "shell")]),
  ]
  const rows = reduceSessionRows(messages, new Set(), false, "medium")
  expect(rows.map((row) => (row.type === "group" ? `${row.kind}:${row.size}` : row.type))).toEqual([
    "medium-activity:2",
    "instructions:2",
    "medium-activity:1",
  ])
})

test("medium keeps low and high projections byte-for-byte unchanged", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "u", text: "Go", time: { created: 0 } },
    assistant("a", [
      { type: "reasoning", text: "Plan", time: { created: 1, completed: 2 } },
      tool("r1", "read"),
      tool("e1", "edit"),
      tool("q", "question"),
    ]),
    instruction("i", ["AGENTS.md"]),
    assistant("b", [tool("sh", "shell"), tool("r2", "read"), { type: "text", text: "Done" }], "stop"),
  ]
  const message = (id: string) => messages.find((item) => item.id === id)
  const detail = (ref: PartRef) => {
    const item = message(ref.messageID)
    if (item?.type !== "assistant") return ref.partID
    const part = resolvePart(item, ref.partID)
    if (!part) return ref.partID
    return part.type === "tool" ? `${ref.partID}=${part.name}/${part.state.status}` : `${ref.partID}=${part.text}`
  }
  type Node = {
    type: string
    kind?: string
    size?: number
    completed?: boolean
    pending?: readonly PartRef[]
    children?: readonly Node[]
    entry?: SessionEntry
    ref?: PartRef
    messageID?: string
  }
  const payload = (entry: SessionEntry) =>
    entry.type === "part"
      ? detail(entry.ref)
      : entry.type === "message"
        ? `${entry.messageID}:${message(entry.messageID)?.type}`
        : entry.type
  const groupText = (node: Node) => {
    const pending = node.pending?.length ?? 0
    const children = renderRows(node.children ?? [], ",")
    return `${node.kind}:${node.size}:${node.completed}:pending=${pending}[${children}]`
  }
  // Include refs, lifecycle state and the text/tool content that actually renders,
  // so a change to low or high content fails even when row kinds and sizes stay put.
  const renderRows = (nodes: readonly Node[], separator: string): string =>
    nodes
      .map((node) => {
        if (node.type === "group") return groupText(node)
        if (node.type === "part" && node.ref) return `part(${detail(node.ref)})`
        if (node.type === "entry" && node.entry) return `entry(${payload(node.entry)})`
        if (node.type === "message" && node.messageID)
          return `message(${node.messageID}:${message(node.messageID)?.type})`
        return node.type
      })
      .join(separator)
  const rendered = (verbosity: "low" | "high") =>
    renderRows(reduceSessionRows(messages, new Set(), false, verbosity), " | ")

  expect(rendered("low")).toBe(
    "message(u:user) | activity:3:true:pending=0[reasoning:1:undefined:pending=0[entry(reasoning:0=Plan)]," +
      "exploration:1:undefined:pending=0[entry(r1=read/completed)],entry(e1=edit/completed)] | " +
      "part(q=question/completed) | activity:3:true:pending=0[instructions:1:undefined:pending=0[entry(i:synthetic)]," +
      "entry(sh=shell/completed),exploration:1:undefined:pending=0[entry(r2=read/completed)]] | " +
      "part(text:0=Done) | assistant-footer",
  )
  expect(rendered("high")).toBe(
    "message(u:user) | reasoning:1:true:pending=0[entry(reasoning:0=Plan)] | " +
      "exploration:1:true:pending=0[entry(r1=read/completed)] | part(e1=edit/completed) | " +
      "part(q=question/completed) | instructions:1:true:pending=0[entry(i:synthetic)] | " +
      "part(sh=shell/completed) | exploration:1:true:pending=0[entry(r2=read/completed)] | " +
      "part(text:0=Done) | assistant-footer",
  )
})

test("live appends under low merge into the open activity group", () => {
  const rows: SessionRow[] = []
  append(rows, { messageID: "a", partID: "reasoning:0" }, { type: "reasoning" }, rows.length, "low")
  append(rows, { messageID: "a", partID: "r1" }, { type: "tool", name: "read" }, rows.length, "low")
  append(rows, { messageID: "b", partID: "sh" }, { type: "tool", name: "shell" }, rows.length, "low")
  append(rows, { messageID: "b", partID: "r2" }, { type: "tool", name: "read" }, rows.length, "low")
  expect(rows).toHaveLength(1)
  const activity = rows[0]
  if (activity.type !== "group") throw new Error("Expected activity")
  expect(activity.kind).toBe("activity")
  expect(activity.size).toBe(4)
  expect(groupRefs(activity).map((ref) => ref.partID)).toEqual(["reasoning:0", "r1", "sh", "r2"])
  append(rows, { messageID: "b", partID: "text:0" }, { type: "text" }, rows.length, "low")
  expect(rows).toHaveLength(2)
  expect(activity.completed).toBe(true)
})

test("permission-blocked tools inside an activity group are tracked as pending without reordering", () => {
  const rows = reduceSessionRows(
    [assistant("a", [tool("r1", "read"), tool("sh", "shell", "running"), tool("r2", "read")])],
    new Set(),
    false,
    "low",
  )
  partitionPending(rows, new Set(["sh"]))
  const activity = rows[0]
  if (activity.type !== "group" || activity.kind !== "activity") throw new Error("Expected activity")
  expect(activity.pending).toEqual([{ messageID: "a", partID: "sh" }])
  expect(groupRefs(activity).map((ref) => ref.partID)).toEqual(["r1", "r2"])
  expect(groupRefs(activity, true).map((ref) => ref.partID)).toEqual(["r1", "sh", "r2"])
})

test("activity summary counts finished work by category", () => {
  const message = assistant("a", [])
  const items = [
    { message, part: { type: "reasoning" as const, text: "t", time: { created: 1, completed: 2 } } },
    { message, part: tool("s1", "shell") },
    { message, part: tool("s2", "bash") },
    { message, part: tool("e1", "edit") },
    { message, part: tool("p1", "apply_patch") },
    { message, part: tool("r1", "read") },
    { message, part: tool("g1", "grep") },
  ]
  expect(activitySummary(items, 2)).toEqual({
    label: "2 commands, 2 edits, 1 thought, 1 read, 1 tool, 2 instructions",
    active: false,
  })
})

test("running work is active but not counted, and failed tools are counted", () => {
  const open = { ...assistant("a", []), time: { created: 1 } }
  const summary = activitySummary(
    [
      { message: open, part: { type: "reasoning" as const, text: "t", time: { created: 1 } } },
      { message: open, part: tool("r1", "read", "running") },
      { message: open, part: tool("r2", "read") },
      { message: open, part: tool("x", "custom.check", "error") },
    ],
    0,
  )
  expect(summary).toEqual({ label: "1 read, 1 tool", active: true })
})

test("execute counts its finished nested calls instead of itself", () => {
  const message = assistant("a", [])
  const execute: SessionMessageAssistantTool = {
    ...tool("x", "execute"),
    state: {
      status: "completed",
      input: {},
      content: [{ type: "text", text: "done" }],
      metadata: {
        toolCalls: [
          { tool: "read", status: "completed" },
          { tool: "read", status: "completed" },
          { tool: "custom.lookup", status: "error" },
          { tool: "custom.slow", status: "running" },
        ],
      },
    },
  }
  expect(activitySummary([{ message, part: execute }], 0)).toEqual({
    label: "2 reads, 1 tool",
    active: false,
  })
})

test("activity summary counts distinct instruction files and skips redacted thoughts", () => {
  const messages: SessionMessageInfo[] = [
    assistant("a", [
      { type: "reasoning", text: "[REDACTED]", time: { created: 1, completed: 2 } },
      { type: "reasoning", text: "Plan", time: { created: 1, completed: 2 } },
      tool("r1", "read"),
    ]),
    instruction("i1", ["AGENTS.md", "src/AGENTS.md"]),
    instruction("i2", ["src/AGENTS.md", "docs/AGENTS.md"]),
  ]
  const activity = reduceSessionRows(messages, new Set(), false, "low")[0]
  if (activity.type !== "group") throw new Error("Expected activity")
  const message = (id: string) => messages.find((item) => item.id === id)
  expect(summarizeActivity(activity, message, [], true).label).toBe("1 thought, 1 read, 3 instructions")
})

test("questions stand alone at every level and end an activity run", () => {
  for (const verbosity of ["low", "medium", "high"] as const)
    expect(partPath({ type: "tool", name: "question" }, verbosity)).toEqual([])
  const rows = reduceSessionRows(
    [assistant("a", [tool("r1", "read"), tool("q", "question", "running"), tool("r2", "read")])],
    new Set(),
    false,
    "low",
  )
  expect(rows.map((row) => (row.type === "group" ? row.kind : row.type))).toEqual(["activity", "part", "activity"])
})

test("a thought still streaming counts as finished once a later row closes its group", () => {
  const open = { ...assistant("a", []), time: { created: 1 } }
  const items = [
    { message: open, part: { type: "reasoning" as const, text: "Planning", time: { created: 1 } } },
    { message: open, part: tool("r1", "read") },
  ]
  expect(activitySummary(items, 0)).toEqual({ label: "1 read", active: true })
  expect(activitySummary(items, 0, true)).toEqual({ label: "1 thought, 1 read", active: false })
})

test("until something finishes, the label is the first running item's status", () => {
  const open = {
    ...assistant("a", [tool("e1", "edit", "running"), tool("s1", "shell", "running")]),
    time: { created: 1 },
  }
  const activity = reduceSessionRows([open], new Set(), false, "low")[0]
  if (activity.type !== "group") throw new Error("Expected activity")
  expect(summarizeActivity(activity, () => open, [], false)).toEqual({
    label: "Running edit…",
    active: true,
  })
})

test("busy labels depend only on the tool and whether it is still being prepared", () => {
  const streaming: SessionMessageAssistantTool = {
    ...tool("s", "bash", "running"),
    state: { status: "streaming", input: "" },
  }
  expect(busyLabel(streaming)).toBe("Preparing command…")
  expect(busyLabel(tool("s", "shell", "running"))).toBe("Running command…")
  expect(busyLabel(tool("r", "read", "running"))).toBe("Running read…")
  expect(busyLabel(tool("x", "execute", "running"))).toBe("Running code…")
  expect(busyLabel({ type: "reasoning", text: "", time: { created: 1 } })).toBe("Thinking…")
})

test("a finished execute with no nested calls counts as one tool", () => {
  const message = assistant("a", [])
  expect(activitySummary([{ message, part: tool("x", "execute") }], 0).label).toBe("1 tool")
})

test("a failed nested call pulls its completed execute tool out of the medium group", () => {
  const failedExecute: SessionMessageAssistantTool = {
    ...tool("exec", "execute"),
    state: {
      status: "completed",
      input: {},
      content: [],
      metadata: { toolCalls: [{ tool: "read", status: "error", input: { path: "src/a.ts" } }] },
    },
  }
  const rows = reduceSessionRows(
    [assistant("a", [tool("r1", "read"), failedExecute, tool("r2", "read")])],
    new Set(),
    false,
    "medium",
  )
  expect(rows.map((row) => (row.type === "group" ? `${row.kind}:${row.size}` : row.type))).toEqual([
    "medium-activity:1",
    "part",
    "medium-activity:1",
  ])
})

test("medium failed tools leave their group and stay standalone", () => {
  const rows = reduceSessionRows(
    [
      assistant("a", [
        tool("r1", "read"),
        tool("bad", "read", "error"),
        tool("r2", "read"),
      ]),
    ],
    new Set(),
    false,
    "medium",
  )
  expect(rows.map((row) => (row.type === "group" ? `${row.kind}:${row.size}` : row.type))).toEqual([
    "medium-activity:1",
    "part",
    "medium-activity:1",
  ])
})

test("medium hydration and live append converge on the same projected tree", () => {
  // Prose in the middle of a tool run must break grouping rather than be swallowed.
  const message = assistant("a", [
    { type: "text", text: "Now looking" },
    tool("r1", "read"),
    tool("r2", "read"),
    tool("g1", "grep"),
    tool("s1", "shell"),
    tool("s2", "bash"),
    { type: "text", text: "Mid-flight note" },
    tool("e1", "edit"),
    tool("r3", "read"),
    tool("e2", "edit"),
    tool("w1", "write"),
    tool("bad", "read", "error"),
    tool("q", "question"),
    { type: "text", text: "Done" },
  ])
  const hydrated = reduceSessionRows([message], new Set(), false, "medium")
  const live: SessionRow[] = []
  const add = (partID: string, part: Parameters<typeof append>[2]) =>
    append(live, { messageID: "a", partID }, part, live.length, "medium")
  add("text:0", { type: "text" })
  for (const id of ["r1", "r2", "g1"]) add(id, { type: "tool", name: id === "g1" ? "grep" : "read" })
  add("s1", { type: "tool", name: "shell" })
  add("s2", { type: "tool", name: "bash" })
  add("text:1", { type: "text" })
  add("e1", { type: "tool", name: "edit" })
  add("r3", { type: "tool", name: "read" })
  add("e2", { type: "tool", name: "edit" })
  add("w1", { type: "tool", name: "write" })
  add("bad", { type: "tool", name: "read", error: true })
  add("q", { type: "tool", name: "question" })
  add("text:2", { type: "text" })

  const shape = (rows: SessionRow[]) =>
    rows.map((row) => (row.type === "group" ? `${row.kind}:${row.size}` : row.type))
  expect(shape(hydrated)).toEqual([
    "part",
    "medium-activity:5",
    "part",
    "medium-edits:1",
    "medium-activity:1",
    "medium-edits:2",
    "part",
    "part",
    "part",
  ])
  expect(shape(live)).toEqual(shape(hydrated))

  // The group headers are derived from these labels; assert them explicitly so a
  // summary regression cannot hide behind an unchanged row shape.
  const label = (row: SessionRow) => {
    if (row.type !== "group") return ""
    const actions = groupRefs(row, true).flatMap((ref) => {
      const part = message.content.find((item) => item.type === "tool" && item.id === ref.partID)
      return part?.type === "tool" ? [{ name: part.name }] : []
    })
    return row.kind === "medium-edits" ? mediumEditsSummary(actions) : mediumActivitySummary(actions)
  }
  expect(hydrated.filter((row) => row.type === "group").map(label)).toEqual([
    "Read 2 files, searched 1 time, ran 2 commands",
    "Edited 1 file",
    "Read 1 file",
    "Edited 2 files",
  ])
})

test("a running script's changes fold into its activity at low and show under it at medium and high", () => {
  const script: SessionMessageAssistantTool = {
    ...tool("x", "execute", "running"),
    state: {
      status: "running",
      input: {},
      metadata: { toolCalls: [{ tool: "patch", status: "completed" }], files: [{ file: "a.ts", status: "modified" }] },
    },
  }
  const open = { ...assistant("a", [tool("r1", "read"), script]), time: { created: 1 } }
  const shape = (verbosity: "low" | "medium" | "high") =>
    reduceSessionRows([open], new Set(), false, verbosity).map((row) => (row.type === "group" ? row.kind : row.type))
  expect(shape("low")).toEqual(["activity"])
  expect(shape("medium")).toEqual(["medium-activity"])
  expect(shape("high")).toEqual(["exploration", "part"])
})
