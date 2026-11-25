import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { IdleMarkerIndex } from "../../src/context/idle-markers"

const idle = (id: string): SessionMessageInfo => ({
  id,
  type: "idle",
  outcome: "succeeded",
  time: { created: 1 },
})
const user = (id: string): SessionMessageInfo => ({ id, type: "user", text: "Go", time: { created: 0 } })

test("idle presence is tracked from observed history and incremental inserts", () => {
  const index = new IdleMarkerIndex()
  index.observe("s", [user("u"), idle("idle-1")])
  expect(index.has("s")).toBe(true)
  index.remove("s", "idle-1")
  expect(index.has("s")).toBe(false)
  index.add("s", idle("idle-2"))
  expect(index.has("s")).toBe(true)
  index.add("s", user("u2"))
  expect(index.has("s")).toBe(true)
})

test("forgetting a session clears its marker metadata", () => {
  const index = new IdleMarkerIndex()
  index.observe("s", [idle("idle-1")])
  index.forget("s")
  expect(index.has("s")).toBe(false)
})
