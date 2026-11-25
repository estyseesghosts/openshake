import type { SessionMessageInfo } from "@opencode/client"

export type MessagePage = {
  /** Server-ordered messages for this one page; never trimmed in the middle. */
  messages: SessionMessageInfo[]
  /** Cursor that refetches this page after it has been evicted. */
  refetchCursor?: string
}

export type WindowBudgets = {
  /** Resident bytes while the session is live and visible. */
  tailBytes: number
  /** Larger allowance while the user browses history. */
  historyBytes: number
}

export const defaultWindowBudgets: WindowBudgets = {
  tailBytes: 4 * 1024 * 1024,
  historyBytes: 16 * 1024 * 1024,
}

/** Approximate resident bytes without serializing whole tool payloads repeatedly. */
export function messageBytes(message: SessionMessageInfo) {
  let bytes = 128
  if ("text" in message && typeof message.text === "string") bytes += message.text.length * 2
  if (message.type === "assistant") {
    for (const part of message.content) {
      if ("text" in part && typeof part.text === "string") bytes += part.text.length * 2
      if (part.type === "tool" && part.state.status !== "streaming") {
        for (const item of part.state.content ?? []) {
          if ("text" in item && typeof item.text === "string") bytes += item.text.length * 2
        }
      }
    }
  }
  return bytes
}

function pageBytes(page: MessagePage) {
  return page.messages.reduce((sum, item) => sum + messageBytes(item), 0)
}

/**
 * Page-aware resident window. Whole server pages are evicted from the oldest end so
 * an opaque cursor can always refetch them; a fetched page is never cut in the middle.
 * Pending, outbox and currently streaming messages are pinned regardless of budget.
 */
export class MessageWindow {
  private readonly pages = new Map<string, MessagePage[]>()
  private readonly indexes = new Map<string, Map<string, number>>()
  private readonly bytes = new Map<string, number>()
  private readonly cursors = new Map<string, string | undefined>()

  private pagesFor(sessionID: string) {
    return this.pages.get(sessionID) ?? []
  }

  set(sessionID: string, messages: readonly SessionMessageInfo[], cursor: string | undefined) {
    this.pages.set(sessionID, [{ messages: [...messages] }])
    this.reindex(sessionID)
    this.cursors.set(sessionID, cursor)
    return this.view(sessionID)
  }

  /** Prepend one fetched server page; `refetchCursor` is the cursor that produced it. */
  prepend(sessionID: string, messages: readonly SessionMessageInfo[], refetchCursor: string, next: string | undefined) {
    const pages = [{ messages: [...messages], refetchCursor }, ...this.pagesFor(sessionID)]
    this.pages.set(sessionID, pages)
    this.reindex(sessionID)
    this.cursors.set(sessionID, next)
    return this.view(sessionID)
  }

  private reindex(sessionID: string) {
    const index = new Map<string, number>()
    let position = 0
    for (const page of this.pagesFor(sessionID)) {
      for (const message of page.messages) index.set(message.id, position++)
    }
    this.indexes.set(sessionID, index)
    this.bytes.set(
      sessionID,
      this.pagesFor(sessionID).reduce((sum, page) => sum + pageBytes(page), 0),
    )
  }

  index(sessionID: string) {
    return this.indexes.get(sessionID) ?? new Map<string, number>()
  }

  residentBytes(sessionID: string) {
    return this.bytes.get(sessionID) ?? 0
  }

  view(sessionID: string) {
    return { messages: this.pagesFor(sessionID).flatMap((page) => page.messages), cursor: this.cursors.get(sessionID) }
  }

  /**
   * Evict whole old pages until the resident window fits. `all: true` intentionally
   * uses the larger browsing budget; pages are still refetchable by cursor.
   */
  trim(sessionID: string, pinned: ReadonlySet<string>, all: boolean, budgets = defaultWindowBudgets) {
    const limit = all ? budgets.historyBytes : budgets.tailBytes
    const pages = [...this.pagesFor(sessionID)]
    while (pages.length > 1 && this.residentBytes(sessionID) > limit) {
      const oldest = pages[0]
      if (!oldest) break
      if (oldest.messages.some((message) => pinned.has(message.id))) break
      const evicted = pages.shift()
      this.pages.set(sessionID, pages)
      this.reindex(sessionID)
      // The evicted page stays reachable through the cursor that produced it.
      this.cursors.set(sessionID, evicted?.refetchCursor)
    }
    return this.view(sessionID)
  }

  forget(sessionID: string) {
    this.pages.delete(sessionID)
    this.indexes.delete(sessionID)
    this.bytes.delete(sessionID)
    this.cursors.delete(sessionID)
  }
}
