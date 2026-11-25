import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { SessionGroupView } from "../../../src/routes/session/group-view"
import { createTimelineAnchors } from "../../../src/routes/session/anchors"
import { context } from "../../../src/routes/session/render-context"
import type { SessionEntry, SessionRow } from "../../../src/routes/session/grouping/session"
import { reduceSessionRows, resolvePart } from "../../../src/routes/session/rows"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const model = { providerID: "fixture", id: "fixture" }
const tool = (id: string, name: string) => ({
  type: "tool" as const,
  id,
  name,
  time: { created: 0, completed: 1 },
  state: { status: "completed" as const, input: {}, content: [], metadata: {} },
})
const assistant = (id: string, content: SessionMessageAssistant["content"], finish?: "stop") => ({
  type: "assistant" as const,
  id,
  agent: "build",
  model,
  time: { created: 0, completed: 1 },
  ...(finish ? { finish } : {}),
  content,
})
const messages: SessionMessageInfo[] = [
  { type: "user", id: "u", text: "Go", time: { created: 0 } },
  assistant("a", [
    { type: "reasoning" as const, text: "Plan", time: { created: 0, completed: 1 } },
    tool("r1", "read"),
    tool("e1", "edit"),
    tool("q", "question"),
  ]),
  {
    type: "synthetic" as const,
    id: "i",
    text: "Instructions",
    description: "Loaded AGENTS.md",
    metadata: { instruction: { paths: ["AGENTS.md"] } },
    time: { created: 1 },
  },
  assistant("b", [tool("sh", "shell"), tool("r2", "read"), { type: "text" as const, text: "Done" }], "stop"),
]

/** Non-group rows have no group view; give them a stable, content-bearing line. */
function rowText(row: SessionRow): string {
  if (row.type === "message") {
    const message = messages.find((item) => item.id === row.messageID)
    return message?.type === "user" ? `User: ${message.text}` : "Message"
  }
  if (row.type === "part") {
    const message = messages.find((item) => item.id === row.ref.messageID)
    if (message?.type !== "assistant") return "Part"
    const part = resolvePart(message, row.ref.partID)
    if (!part) return "Part"
    if (part.type === "tool") return `Tool: ${part.name}`
    return part.type === "text" ? `Text: ${part.text}` : `Thought: ${part.text}`
  }
  if (row.type === "assistant-footer") return "Footer"
  return row.type
}

async function frame(verbosity: "low" | "high") {
  const rows = reduceSessionRows(messages, new Set(), false, verbosity)
  const config = createTuiResolvedConfig({ animations: false })
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <context.Provider
              value={{
                width: 60,
                terminal: { width: 60, height: 40 },
                sessionID: "fixture",
                anchors: createTimelineAnchors(),
                groupExpanded: () => false,
                setGroupExpanded: () => {},
                thinkingMode: () => "hide",
                markdownMode: () => "rendered",
                groupExploration: () => true,
                legacyTurns: () => false,
                diffWrapMode: () => "word",
                models: () => [],
                messageIndex: () => undefined,
                config,
                mutatePending: async () => true,
                pendingDelivery: () => undefined,
              }}
            >
              <box flexDirection="column" paddingTop={1}>
                {rows.map((row) =>
                  row.type === "group" ? (
                    <SessionGroupView
                      row={row}
                      message={(id) => messages.find((item) => item.id === id)}
                      images={() => <text>Image previews</text>}
                      entry={(item: SessionEntry) => <text>{rowText(item)}</text>}
                    />
                  ) : (
                    <text>{rowText(row)}</text>
                  ),
                )}
              </box>
            </context.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 40 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((value) => value.includes("Text: Done"))
    return app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n")
  } finally {
    app.renderer.destroy()
  }
}

test("low and high render their full transcript content unchanged", async () => {
  expect(await frame("low")).toBe(
    [
      "User: Go",
      "+ 1 edit, 1 thought, 1 read",
      "Tool: question",
      "+ 1 command, 1 read, 1 instruction",
      "Text: Done",
      "Footer",
    ].join("\n"),
  )
  expect(await frame("high")).toBe(
    [
      "User: Go",
      "+ Thought · 1ms",
      "→ Explored: 1 read",
      "Image previews",
      "Tool: edit",
      "Tool: question",
      "◈ Instructions: 1 file",
      "Tool: shell",
      "→ Explored: 1 read",
      "Image previews",
      "Text: Done",
      "Footer",
    ].join("\n"),
  )
})
