import type { SimpleHighlight } from "@opentui/core"

export type HighlightThresholds = {
  /** Beyond this many bytes, Tree-sitter highlighting of a whole virtualized file is deferred. */
  maxBytes: number
  maxLines: number
}

export const defaultHighlightThresholds: HighlightThresholds = {
  maxBytes: 1_000_000,
  maxLines: 20_000,
}

/** Single O(n) pass; `all.slice(0,i).reduce(...)` made virtualization quadratic in chunk count. */
export function prefixOffsets(contents: readonly string[]): number[] {
  const offsets = new Array<number>(contents.length)
  let offset = 0
  for (let index = 0; index < contents.length; index++) {
    offsets[index] = offset
    offset += (contents[index]?.length ?? 0) + 1
  }
  return offsets
}

/**
 * A whole-file parse is only worth it while the file is still reasonably sized. `contents` is the list of chunk
 * sources, so the line count must be passed separately: `contents.length` counts chunks, not lines.
 */
export function highlightBudgetExceeded(
  contents: readonly string[],
  lineCount = contents.length,
  thresholds: HighlightThresholds = defaultHighlightThresholds,
) {
  if (lineCount > thresholds.maxLines) return true
  let bytes = lineCount
  for (const content of contents) {
    bytes += content.length
    if (bytes > thresholds.maxBytes) return true
  }
  return false
}

/**
 * Splits whole-file highlight ranges into per-chunk local ranges in a single pass. A range crossing a chunk
 * boundary is clipped into both chunks, so no chunk is ever parsed on its own with invented syntax state.
 */
export function partitionHighlights(
  highlights: readonly SimpleHighlight[],
  contents: readonly string[],
): SimpleHighlight[][] {
  const slices: SimpleHighlight[][] = contents.map(() => [])
  const offsets = prefixOffsets(contents)
  for (const highlight of highlights) {
    for (let index = 0; index < contents.length; index++) {
      const start = offsets[index]!
      const end = start + (contents[index]?.length ?? 0)
      if (highlight[0] < end && highlight[1] > start) {
        slices[index]!.push([
          Math.max(highlight[0], start) - start,
          Math.min(highlight[1], end) - start,
          highlight[2],
          highlight[3],
        ])
      }
    }
  }
  return slices
}

/**
 * Small content-addressed cache for immutable patch/file highlights. Keys are the
 * joined source itself, so hydration and live re-renders of the same file converge
 * on one parse instead of reparsing on every viewport change.
 */
export function createHighlightCache<T>(limit = 8) {
  const entries = new Map<string, T>()
  return {
    get(key: string, compute: () => T): T {
      const hit = entries.get(key)
      if (hit !== undefined) {
        // Refresh recency.
        entries.delete(key)
        entries.set(key, hit)
        return hit
      }
      const value = compute()
      entries.set(key, value)
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      return value
    },
    get size() {
      return entries.size
    },
  }
}
