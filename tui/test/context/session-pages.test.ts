import { expect, test } from "bun:test"
import { collectPages } from "../../src/context/session-pages"

test("collects every page in order without recursion", async () => {
  const pages = [
    { data: ["c", "b"], next: "p2" },
    { data: ["a"], next: undefined },
  ]
  const requested: Array<string | undefined> = []
  const result = await collectPages(async (cursor) => {
    requested.push(cursor)
    return pages[requested.length - 1]!
  })
  expect(result).toEqual(["c", "b", "a"])
  expect(requested).toEqual([undefined, "p2"])
})

test("a single page needs no follow-up request", async () => {
  let calls = 0
  const result = await collectPages(async () => {
    calls++
    return { data: ["only"] }
  })
  expect(result).toEqual(["only"])
  expect(calls).toBe(1)
})

test("a repeated cursor is rejected instead of looping forever", async () => {
  await expect(
    collectPages(async () => ({ data: ["x"], next: "same" })),
  ).rejects.toThrow("Repeated page cursor")
})
