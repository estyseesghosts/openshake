import { expect, test } from "bun:test"
import { mapLimited, warmSessionIDs } from "../../src/context/session-tabs-thermal"

test("only the visible session and a small recency set stay warm", () => {
  const tabs = ["a", "b", "c", "d", "e"]
  expect(warmSessionIDs("c", tabs, ["a", "b", "c", "d"], 2)).toEqual(["c", "d", "b"])
  expect(warmSessionIDs(undefined, tabs, [], 2)).toEqual(["a", "b", "c"])
  expect(warmSessionIDs("z", tabs, ["a", "b"], 2)).toEqual(["b", "a", "c"])
})

test("background hydration is bounded to a small concurrency limit", async () => {
  let active = 0
  let peak = 0
  const items = Array.from({ length: 10 }, (_, index) => index)
  const results = await mapLimited(items, 3, async (item) => {
    active++
    peak = Math.max(peak, active)
    await Bun.sleep(1)
    active--
    return item * 2
  })
  expect(peak).toBeLessThanOrEqual(3)
  expect(results).toEqual(items.map((item) => item * 2))
  expect(await mapLimited([], 3, async () => 1)).toEqual([])
})
