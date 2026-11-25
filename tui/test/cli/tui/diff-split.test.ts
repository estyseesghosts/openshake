import { expect, test } from "bun:test"
import { defaultHighlightThresholds, highlightBudgetExceeded } from "../../../src/util/diff-highlight"
import { splitAddedPatch, splitLargePatch } from "../../../src/util/diff"

function headers(chunks: { patch: string }[]) {
  return chunks.map((chunk) => chunk.patch.match(/^@@ -(\d+,\d+) \+(\d+,\d+) @@/m)?.slice(1))
}

test("a modified patch is chunked with recomputed old and new line numbers", () => {
  const patch = [
    "diff --git a/file.ts b/file.ts",
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -10,3 +10,4 @@",
    " context before",
    "-old",
    "+new one",
    "+new two",
    " context after",
  ].join("\n")
  const chunks = splitLargePatch(patch, 2)!
  expect(chunks.map((chunk) => chunk.rows)).toEqual([2, 2, 1])
  expect(chunks.map((chunk) => chunk.lines)).toEqual([
    [" context before", "-old"],
    ["+new one", "+new two"],
    [" context after"],
  ])
  expect(headers(chunks)).toEqual([
    ["10,2", "10,1"],
    ["12,0", "11,2"],
    ["12,1", "13,1"],
  ])
  expect(chunks.every((chunk) => chunk.patch.startsWith("diff --git a/file.ts b/file.ts"))).toBe(true)
  expect(chunks.every((chunk) => chunk.patch.includes("+++ b/file.ts"))).toBe(true)
})

test("chunk headers consume exactly the original old and new ranges", () => {
  const patch = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -10,3 +10,4 @@",
    " context before",
    "-old",
    "+new one",
    "+new two",
    " context after",
  ].join("\n")
  const chunks = splitLargePatch(patch, 2)!
  const last = chunks.at(-1)!
  const [oldStart, oldCount] = last.patch.match(/@@ -(\d+),(\d+)/)!.slice(1).map(Number)
  const [newStart, newCount] = last.patch.match(/ \+(\d+),(\d+)/)!.slice(1).map(Number)
  expect(oldStart! + oldCount! - 1).toBe(12)
  expect(newStart! + newCount! - 1).toBe(13)
})

test("multiple hunks stay separate and each one is chunked independently", () => {
  const patch = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,2 +1,2 @@",
    "-a",
    "+b",
    " context",
    "@@ -20,2 +20,2 @@",
    "-c",
    "+d",
    " tail",
  ].join("\n")
  const chunks = splitLargePatch(patch, 2)!
  expect(chunks.map((chunk) => chunk.rows)).toEqual([1, 1, 1, 1])
  expect(headers(chunks)).toEqual([
    ["1,1", "1,1"],
    ["2,1", "2,1"],
    ["20,1", "20,1"],
    ["21,1", "21,1"],
  ])
  expect(chunks[2].patch).toContain("@@ -20,1 +20,1 @@")
})

test("a new-file patch keeps the existing added-patch splitting behavior", () => {
  const patch = ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,5 @@", "+one", "+two", "+three", "+four", "+five"].join(
    "\n",
  )
  expect(splitLargePatch(patch, 2)).toEqual(splitAddedPatch(patch, 2))
})

test("deletion-only hunks keep their new-side offset on every chunk", () => {
  const patch = ["--- a/file.ts", "+++ b/file.ts", "@@ -5,3 +4,0 @@", "-old1", "-old2", "-old3"].join("\n")
  const chunks = splitLargePatch(patch, 2)!
  expect(chunks.map((chunk) => chunk.rows)).toEqual([2, 1])
  expect(headers(chunks)).toEqual([
    ["5,2", "4,0"],
    ["7,1", "4,0"],
  ])
})

test("a missing-final-newline marker stays only on the last chunk", () => {
  const patch = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,1 +1,4 @@",
    "-a",
    "+b",
    "+c",
    "+d",
    "\\ No newline at end of file",
  ].join("\n")
  const chunks = splitLargePatch(patch, 2)!
  expect(chunks).toHaveLength(2)
  expect(chunks[0].patch).not.toContain("No newline")
  expect(chunks[1].patch).toContain("+d\n\\ No newline at end of file")
  expect(chunks.map((chunk) => chunk.rows)).toEqual([1, 2])
})

test("a one-line megabyte edit is bounded by rows and stays over the syntax budget", () => {
  const patch = [
    "--- a/huge.txt",
    "+++ b/huge.txt",
    "@@ -1 +1 @@",
    `-${"x".repeat(1_000_000)}`,
    `+${"y".repeat(1_000_000)}`,
  ].join("\n")
  const chunks = splitLargePatch(patch, 128)!
  expect(chunks).toHaveLength(1)
  expect(chunks[0].lines).toHaveLength(2)
  expect(chunks[0].rows).toBe(1)
  expect(highlightBudgetExceeded(["x".repeat(1_000_000), "y".repeat(1_000_000)], 2)).toBe(true)
  expect(highlightBudgetExceeded(["short"], 1, defaultHighlightThresholds)).toBe(false)
})

test("patches without a parseable hunk are left unsplit", () => {
  expect(splitLargePatch("not a patch", 2)).toBeUndefined()
})
