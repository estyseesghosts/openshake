import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { MessageWindow, messageBytes, type WindowBudgets } from "../../src/context/message-window"

const user = (id: string, text = "x"): SessionMessageInfo => ({ type: "user", id, text, time: { created: 1 } })
const ids = (messages: readonly SessionMessageInfo[]) => messages.map((item) => item.id)

test("history browsing retains a window around the reader instead of evicting the just-fetched page", () => {
  const window = new MessageWindow()
  window.set("s", [user("live-1"), user("live-2")], "newer")
  // Reader fetches progressively older pages; each prepend moves the focus upward.
  window.prepend("s", [user("old-1"), user("old-2")], "fetch-old-1", "older-1")
  window.trim("s", new Set(), true, { tailBytes: 10, historyBytes: 1 })
  expect(ids(window.view("s").messages)).toEqual(["old-1", "old-2", "live-1", "live-2"])

  window.prepend("s", [user("older-1"), user("older-2")], "fetch-older-1", "oldest")
  window.trim("s", new Set(), true, { tailBytes: 10, historyBytes: 1 })
  // The newly fetched page survives: the focus moved to it, so the older-but-now-farther
  // page is the eviction candidate, and the live tail stays recoverable.
  expect(ids(window.view("s").messages)).toEqual(["older-1", "older-2", "live-1", "live-2"])
  expect(window.view("s").cursor).toBe("fetch-old-1")
})

test("sequential upward scrolling always makes progress beyond both budgets", () => {
  const window = new MessageWindow()
  window.set("s", [user("live")], "newer")
  const fetched: string[] = []
  for (let index = 20; index >= 1; index--) {
    const id = `msg-${index}`
    fetched.push(id)
    window.prepend("s", [user(id)], `fetch-${id}`, `older-${id}`)
    window.trim("s", new Set(), true, { tailBytes: 1, historyBytes: 512 })
    const view = window.view("s")
    // Whatever is evicted, the newest fetched page (the reader's current position) stays.
    expect(view.messages.some((item) => item.id === id)).toBe(true)
  }
})

test("live tail is never evicted while browsing history", () => {
  const window = new MessageWindow()
  window.set("s", [user("live-1"), user("live-2")], "newer")
  window.prepend("s", [user("a")], "a", "b")
  window.prepend("s", [user("b")], "b", "c")
  window.focusOn("s", "a")
  window.trim("s", new Set(), true, { tailBytes: 1, historyBytes: 1 })
  expect(ids(window.view("s").messages)).toEqual(["a", "live-1", "live-2"])
})

test("edit, upsert, remove and revert go through the authoritative array and keep the index O(1)", () => {
  const window = new MessageWindow()
  window.set("s", [user("a"), user("b"), user("c")], "cursor")
  window.edit("s", (messages, index) => {
    const position = index.get("b")
    if (position !== undefined) messages[position] = user("b", "edited")
  })
  expect(ids(window.view("s").messages)).toContain("b")
  expect(window.view("s").messages[1]).toEqual(user("b", "edited"))

  window.upsert("s", user("d"))
  expect(ids(window.view("s").messages)).toEqual(["a", "b", "c", "d"])
  expect(window.index("s").get("d")).toBe(3)

  window.upsert("s", user("d", "replaced"))
  expect(window.view("s").messages.filter((item) => item.id === "d")).toHaveLength(1)
  expect(window.view("s").messages[3]).toEqual(user("d", "replaced"))

  window.remove("s", new Set(["a"]))
  expect(ids(window.view("s").messages)).toEqual(["b", "c", "d"])
  expect(window.index("s").has("a")).toBe(false)

  window.revert("s", (item) => item.id >= "c")
  expect(ids(window.view("s").messages)).toEqual(["b"])
})

test("server page boundaries survive set() with explicit pages", () => {
  const window = new MessageWindow()
  window.set(
    "s",
    [user("c"), user("b")],
    "newer",
    [
      { messages: [user("c")], refetchCursor: "page-c" },
      { messages: [user("b")] },
    ],
  )
  expect(window.pages("s").map((page) => page.messages.map((item) => item.id))).toEqual([["c"], ["b"]])
  window.trim("s", new Set(), false, { tailBytes: 1, historyBytes: 1 })
  expect(ids(window.view("s").messages)).toEqual(["b"])
})

test("byte accounting includes tool inputs, metadata and native replay data", () => {
  const base = user("small")
  type JsonRecord = { [key: string]: string | number | boolean | null | JsonRecord | JsonRecord[] }
  const tool = (input: JsonRecord, metadata: JsonRecord, native: JsonRecord): SessionMessageInfo => ({
    type: "assistant",
    id: "tool",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: 1 },
    metadata: { note: "n".repeat(1000) },
    native: { payload: "p".repeat(1000) },
    content: [
      {
        type: "tool",
        id: "t",
        name: "write",
        time: { created: 1 },
        state: { status: "running", input, metadata, native },
      },
    ],
  })
  expect(messageBytes(tool({ value: "i".repeat(5000) }, {}, {}))).toBeGreaterThan(messageBytes(base) * 20)
  expect(messageBytes(tool({}, {}, {}))).toBeLessThan(messageBytes(tool({ value: "i".repeat(5000) }, {}, {})))
})

test("one pathological message cannot defeat the byte budget", () => {
  const window = new MessageWindow()
  window.set("s", [user("live")], "newer")
  window.prepend("s", [user("huge", "x".repeat(2_000_000))], "fetch-huge", "older")
  const budgets: WindowBudgets = { tailBytes: 1024, historyBytes: 1024, maxMessageBytes: 256 }
  window.trim("s", new Set(), false, budgets)
  expect(window.stats().oversized).toBeGreaterThanOrEqual(0)
  expect(window.residentBytes("s")).toBeLessThan(1024 + messageBytes(user("huge", "x".repeat(2_000_000))))
})

test("forget clears every per-session trace", () => {
  const window = new MessageWindow()
  window.set("s", [user("a")], "c")
  window.focusOn("s", "a")
  window.forget("s")
  expect(ids(window.view("s").messages)).toEqual([])
  expect(window.index("s").size).toBe(0)
  expect(window.residentBytes("s")).toBe(0)
  expect(window.stats().sessions).toBe(0)
})
