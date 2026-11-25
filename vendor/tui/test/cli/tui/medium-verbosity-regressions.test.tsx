import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { addDefaultParsers, DiffRenderable, type Renderable } from "@opentui/core"
import { PatchDiff } from "../../../src/component/patch-diff"
import parsers from "../../../src/parsers-config"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { SessionGroupView } from "../../../src/routes/session/group-view"
import { createTimelineAnchors, type AnchorTarget } from "../../../src/routes/session/anchors"
import { context } from "../../../src/routes/session/render-context"
import type { SessionEntry, SessionGroup } from "../../../src/routes/session/grouping/session"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const model = { providerID: "fixture", id: "fixture" }
const diff = ["--- a/file.ts", "+++ b/file.ts", "@@ -1 +1 @@", "-old", "+added"].join("\n")
const diffNode = () => (
  <PatchDiff
    diff={diff}
    hunkFg="#ffffff"
    lineNumberBg="#000000"
    fg="#ffffff"
    addedBg="#000000"
    removedBg="#000000"
    contextBg="#000000"
    addedSignColor="#00ff00"
    removedSignColor="#ff0000"
    lineNumberFg="#888888"
    addedLineNumberBg="#003300"
    removedLineNumberBg="#330000"
  />
)

function toolFixture(id: string, name: string, input: Record<string, unknown> = {}, running = false) {
  return {
    type: "tool" as const,
    id,
    name,
    time: { created: 0, ...(running ? {} : { completed: 1 }) },
    state: running
      ? { status: "running" as const, input, metadata: {} }
      : { status: "completed" as const, input, content: [], metadata: { files: [{ additions: 2, deletions: 1 }] } },
  } satisfies SessionMessageAssistantTool
}

function message(content: SessionMessageAssistantTool[], completed = true): SessionMessageAssistant {
  return {
    id: "a",
    type: "assistant",
    agent: "build",
    model,
    time: { created: 0, ...(completed ? { completed: 1 } : {}) },
    content,
  }
}

function entry(partID: string): SessionEntry {
  return { type: "part", ref: { messageID: "a", partID } }
}

function row(kind: "medium-activity" | "medium-edits", partIDs: string[], pending: string[] = [], done = true) {
  return {
    type: "group" as const,
    kind,
    size: partIDs.length,
    completed: done,
    pending: pending.map((partID) => ({ messageID: "a", partID })),
    children: partIDs.map((partID) => ({ type: "entry" as const, size: 1, entry: entry(partID) })),
  } satisfies SessionGroup
}

function mount(input: {
  row: SessionGroup
  anchors: ReturnType<typeof createTimelineAnchors>
  expanded: (id: string) => boolean
  setExpanded: (id: string, value: boolean) => void
  message: (id: string) => SessionMessageInfo | undefined
  entry: (entry: SessionEntry) => JSX.Element
}) {
  const config = createTuiResolvedConfig({ animations: false })
  return testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <context.Provider
              value={{
                width: 40,
                terminal: { width: 40, height: 24 },
                sessionID: "fixture",
                anchors: input.anchors,
                groupExpanded: input.expanded,
                setGroupExpanded: input.setExpanded,
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
              <box paddingTop={2}>
                <SessionGroupView
                  row={input.row}
                  message={input.message}
                  images={() => <text>Image previews</text>}
                  entry={input.entry}
                />
              </box>
            </context.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 24 },
  )
}

function findDiffs(root: Renderable): DiffRenderable[] {
  return root instanceof DiffRenderable ? [root] : root.getChildren().flatMap(findDiffs)
}

test("a shell and execute mixture renders one stable semantic header in either order", async () => {
  addDefaultParsers(parsers.parsers)
  const read = (order: string[]) => {
    const content = order.map((id) => toolFixture(id, id === "x1" ? "execute" : "shell"))
    return {
      row: row("medium-activity", order),
      message: () => message(content),
    }
  }
  const frames: string[] = []
  for (const order of [["s1", "x1"], ["x1", "s1"]]) {
    const fixture = read(order)
    const app = await mount({
      row: fixture.row,
      anchors: createTimelineAnchors(),
      expanded: () => false,
      setExpanded: () => {},
      message: fixture.message,
      entry: () => <text>child</text>,
    })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Ran 1 command"))
      frames.push(app.captureCharFrame())
    } finally {
      app.renderer.destroy()
    }
  }
  expect(frames[0]).toBe(frames[1])
  expect(frames[0]).toContain("Ran 1 command, ran 1 script")
})

test("a running tool is left to the live line instead of the past-tense header", async () => {
  const content = [toolFixture("r1", "read"), toolFixture("r2", "read", { path: "b.ts" }, true)]
  const app = await mount({
    row: row("medium-activity", ["r1", "r2"], [], false),
    anchors: createTimelineAnchors(),
    expanded: () => false,
    setExpanded: () => {},
    message: () => message(content, false),
    entry: () => <text>child</text>,
  })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Reading b.ts"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Read 1 file")
    expect(frame).not.toContain("Read 2 files")
    expect(frame).toContain("└ Reading b.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("one visible edit beside a blocked call keeps the singleton renderer", async () => {
  addDefaultParsers(parsers.parsers)
  const content = [toolFixture("e1", "edit"), toolFixture("e2", "edit")]
  const app = await mount({
    row: row("medium-edits", ["e1", "e2"], ["e2"]),
    anchors: createTimelineAnchors(),
    expanded: () => false,
    setExpanded: () => {},
    message: () => message(content),
    entry: (item) => (item.type === "part" && item.ref.partID === "e1" ? diffNode() : <text>blocked</text>),
  })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("added"))
    expect(findDiffs(app.renderer.root)).toHaveLength(1)
    expect(app.captureCharFrame()).not.toContain("Edited 2 files")
  } finally {
    app.renderer.destroy()
  }
})

test("a group whose children are all blocked shows only the blocked calls", async () => {
  const content = [toolFixture("e1", "edit"), toolFixture("e2", "edit")]
  const app = await mount({
    row: row("medium-edits", ["e1", "e2"], ["e1", "e2"]),
    anchors: createTimelineAnchors(),
    expanded: () => false,
    setExpanded: () => {},
    message: () => message(content),
    entry: (item) => <text>{item.type === "part" ? `Blocked ${item.ref.partID}` : "unexpected"}</text>,
  })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Blocked e2"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Blocked e1")
    expect(frame).not.toContain("Edited")
  } finally {
    app.renderer.destroy()
  }
})

test("a singleton edit and its collapsed header share the same part anchor position", async () => {
  addDefaultParsers(parsers.parsers)
  const target: AnchorTarget = { type: "part", ref: { messageID: "a", partID: "e1" } }
  const anchorY = async (partIDs: string[]) => {
    const anchors = createTimelineAnchors()
    const singleton = partIDs.length === 1
    const app = await mount({
      row: row("medium-edits", partIDs),
      anchors,
      expanded: () => false,
      setExpanded: () => {},
      message: () => message([toolFixture("e1", "edit"), toolFixture("e2", "edit")]),
      entry: () => diffNode(),
    })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(singleton ? "added" : "Edited 2 files"))
      expect(anchors.get(target)).toBeDefined()
      expect(findDiffs(app.renderer.root)).toHaveLength(singleton ? 1 : 0)
      return anchors.get(target)?.node.y
    } finally {
      app.renderer.destroy()
    }
  }
  expect(await anchorY(["e1"])).toBe(await anchorY(["e1", "e2"]))
})

test("a live second edit collapses a singleton in place without moving its anchor", async () => {
  addDefaultParsers(parsers.parsers)
  const anchors = createTimelineAnchors()
  const [current, setCurrent] = createStore<SessionGroup>(row("medium-edits", ["e1"]))
  const target: AnchorTarget = { type: "part", ref: { messageID: "a", partID: "e1" } }
  const app = await mount({
    row: current,
    anchors,
    expanded: () => false,
    setExpanded: () => {},
    message: () => message([toolFixture("e1", "edit"), toolFixture("e2", "edit")]),
    entry: () => diffNode(),
  })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("added"))
    const beforeY = anchors.get(target)?.node.y
    setCurrent(reconcile(row("medium-edits", ["e1", "e2"])))
    await app.waitForFrame((frame) => frame.includes("Edited 2 files"))
    expect(findDiffs(app.renderer.root)).toHaveLength(0)
    expect(anchors.get(target)).toBeDefined()
    expect(anchors.get(target)?.node.y).toBe(beforeY)
  } finally {
    app.renderer.destroy()
  }
})
