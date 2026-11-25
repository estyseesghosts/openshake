/**
 * Open tab metadata (title, location, unread/busy) is intentionally cheap and is
 * kept for every tab. Heavy transcripts are only resident for the visible session
 * plus a small recency set; the rest refetch their recent tail when reopened.
 */
export function warmSessionIDs(
  current: string | undefined,
  tabs: readonly string[],
  recent: readonly string[],
  extra = 2,
) {
  const result: string[] = []
  if (current && tabs.includes(current)) result.push(current)
  for (let index = recent.length - 1; index >= 0 && result.length < 1 + extra; index--) {
    const id = recent[index]
    if (id && tabs.includes(id) && !result.includes(id)) result.push(id)
  }
  // Tabs restored without navigation history still need a deterministic warm set.
  for (const id of tabs) {
    if (result.length >= 1 + extra) break
    if (!result.includes(id)) result.push(id)
  }
  return result
}

/** Run async work with a small, bounded fan-out so restoring many tabs cannot flood the server. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
