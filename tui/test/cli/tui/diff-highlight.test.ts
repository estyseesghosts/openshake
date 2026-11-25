import { expect, test } from "bun:test"
import {
  createHighlightCache,
  defaultHighlightThresholds,
  highlightBudgetExceeded,
  partitionHighlights,
  prefixOffsets,
} from "../../../src/util/diff-highlight"

test("prefix offsets are a single pass and match the naive calculation", () => {
  const contents = ["const a = 1", "", "const b = 2", "x".repeat(1_000)]
  const expected = contents.map((_, index) =>
    contents.slice(0, index).reduce((sum, content) => sum + content.length + 1, 0),
  )
  expect(prefixOffsets(contents)).toEqual(expected)
  expect(prefixOffsets([])).toEqual([])
})

test("a generated 20k-line diff has linear offsets without quadratic work", () => {
  const contents = Array.from({ length: 20_000 }, (_, index) => `  line(${index}): ${"x".repeat(40)}`)
  const offsets = prefixOffsets(contents)
  expect(offsets).toHaveLength(20_000)
  expect(offsets[19_999]! - offsets[19_998]!).toBe(contents[19_998]!.length + 1)
})

test("pathological files exceed the highlight budget by lines or by a single huge line", () => {
  const manyLines = Array.from({ length: defaultHighlightThresholds.maxLines + 1 }, () => "x")
  expect(highlightBudgetExceeded(manyLines)).toBe(true)
  const oneHugeLine = ["x".repeat(defaultHighlightThresholds.maxBytes + 1)]
  expect(highlightBudgetExceeded(oneHugeLine)).toBe(true)
  expect(highlightBudgetExceeded(["const a = 1", "const b = 2"])).toBe(false)
})

test("the line budget uses the real line count, not the number of chunk strings", () => {
  const chunks = ["x".repeat(10), "y".repeat(10), "z".repeat(10)]
  expect(highlightBudgetExceeded(chunks, defaultHighlightThresholds.maxLines + 1)).toBe(true)
  expect(highlightBudgetExceeded(chunks, chunks.length)).toBe(false)
  const thresholds = { maxBytes: 100, maxLines: 2 }
  expect(highlightBudgetExceeded(chunks, 3, thresholds)).toBe(true)
  expect(highlightBudgetExceeded(chunks, 2, thresholds)).toBe(false)
  // One megabyte line still trips the byte budget even though its line count is one.
  expect(highlightBudgetExceeded(["x".repeat(defaultHighlightThresholds.maxBytes + 1)], 1)).toBe(true)
})

test("a single whole-file partition clips multiline ranges into each chunk's local coordinates", () => {
  const contents = ["const a = {", "  value: 1,", "}"]
  const slices = partitionHighlights(
    [
      [0, 25, "node"],
      [5, 18, "string"],
      [30, 40, "outside"],
    ],
    contents,
  )
  expect(slices).toHaveLength(3)
  expect(slices[0]).toEqual([
    [0, 11, "node"],
    [5, 11, "string"],
  ])
  expect(slices[1]).toEqual([
    [0, 11, "node"],
    [0, 6, "string"],
  ])
  expect(slices[2]).toEqual([[0, 1, "node"]])
  expect(partitionHighlights([], contents)).toEqual([[], [], []])
  expect(partitionHighlights([[0, 3, "node"]], [])).toEqual([])
})

test("partitioning handles context and deletion lines in the chunk source", () => {
  const contents = [" old value", "-removed value", "+added value"]
  const slices = partitionHighlights([[0, 33, "token"]], contents)
  expect(slices[0]).toEqual([[0, 10, "token"]])
  expect(slices[1]).toEqual([[0, 14, "token"]])
  expect(slices[2]).toEqual([[0, 7, "token"]])
})

test("content-addressed highlight cache reuses parses and evicts cold entries", () => {
  const cache = createHighlightCache<number>(3)
  let computes = 0
  const compute = (key: string) => {
    computes++
    return key.length
  }
  cache.get("alpha", () => compute("alpha"))
  cache.get("beta", () => compute("beta"))
  cache.get("alpha", () => compute("alpha"))
  expect(computes).toBe(2)
  cache.get("gamma", () => compute("gamma"))
  cache.get("delta", () => compute("delta"))
  expect(cache.size).toBe(3)
  // alpha was refreshed most recently, so it survives; beta was the LRU entry.
  expect(cache.get("alpha", () => compute("alpha"))).toBe(5)
  expect(computes).toBe(4)
  expect(cache.get("beta", () => compute("beta"))).toBe(4)
  expect(computes).toBe(5)
})
