import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { MessageWindow, messageBytes, type WindowBudgets } from "../../src/context/message-window"

const user = (id: string, text = "x"): SessionMessageInfo => ({
  type: "user",
  id,
  text,
  time: { created: 1 },
})

test("page boundaries and cursors survive prepend and eviction", () => {
  const window = new MessageWindow()
  window.set("s", [user("c"), user("b")], "newer-cursor")
  window.prepend("s", [user("a1"), user("a2")], "fetch-a", "older-cursor")
  expect(window.view("s").messages.map((item) => item.id)).toEqual(["a1", "a2", "c", "b"])
  expect(window.view("s").cursor).toBe("older-cursor")
  expect(window.index("s").get("c")).toBe(2)

  const tiny: WindowBudgets = { tailBytes: 1, historyBytes: 1_000_000 }
  const kept = window.trim("s", new Set(), false, tiny)
  expect(kept.messages.map((item) => item.id)).toEqual(["c", "b"])
  // The evicted page can be refetched through its own cursor, not skipped.
  expect(kept.cursor).toBe("fetch-a")
  expect(window.index("s").get("b")).toBe(1)
})

test("pinned messages prevent eviction of the page that owns them", () => {
  const window = new MessageWindow()
  window.set("s", [user("new")], "n")
  window.prepend("s", [user("outbox"), user("old")], "fetch-old", "o")
  const tiny: WindowBudgets = { tailBytes: 1, historyBytes: 1 }
  const kept = window.trim("s", new Set(["outbox"]), false, tiny)
  expect(kept.messages.map((item) => item.id)).toEqual(["outbox", "old", "new"])
})

test("one giant tool result dominates bytes more than many small messages", () => {
  const small = user("small")
  const huge: SessionMessageInfo = {
    type: "assistant",
    id: "huge",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "t",
        name: "read",
        time: { created: 1 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "x".repeat(20_000) }],
          metadata: {},
        },
      },
    ],
  }
  expect(messageBytes(huge)).toBeGreaterThan(messageBytes(small) * 100)
})
