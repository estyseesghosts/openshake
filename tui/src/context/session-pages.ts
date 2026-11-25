export type Page<T> = {
  data: readonly T[]
  next?: string
}

/**
 * Iteratively follow opaque page cursors. Recursion made a deep child list allocate
 * one intermediate array per page and risked stack growth; this keeps one result
 * array and a seen set so a malformed cursor cycle fails loudly instead of looping.
 */
export async function collectPages<T>(fetch: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await fetch(cursor)
    result.push(...page.data)
    if (!page.next) return result
    if (seen.has(page.next)) throw new Error(`Repeated page cursor: ${page.next}`)
    seen.add(page.next)
    cursor = page.next
  }
}
