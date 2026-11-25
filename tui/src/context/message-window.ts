import type { SessionMessageInfo } from "@opencode/client"

/**
 * One opaque server page. Pages are never cut in the middle: an evicted page is
 * reachable again through `refetchCursor`. The newest page is the mutable live tail.
 */
export type MessagePage = {
  messages: SessionMessageInfo[]
  refetchCursor?: string
  /** Only the newest page is mutated by streaming and live events. */
  live?: boolean
}

/** A read that produced several server pages keeps each page's own boundary. */
export type FetchedPage = {
  messages: readonly SessionMessageInfo[]
  refetchCursor?: string
}

export type WindowBudgets = {
  /** Resident bytes while the session is live and visible. */
  tailBytes: number
  /** Larger allowance while the user browses history. */
  historyBytes: number
  /**
   * Cap on a single message's contribution. One pathological tool result must not
   * force every other page out of the window. Without this, one huge result makes
   * the byte budget meaningless.
   */
  maxMessageBytes?: number
}

export const defaultWindowBudgets: WindowBudgets = {
  tailBytes: 4 * 1024 * 1024,
  historyBytes: 16 * 1024 * 1024,
  maxMessageBytes: 4 * 1024 * 1024,
}

/** Which side of the transcript the reader is looking at. */
export type ResidencyMode = "tail" | "history-browsing"

export type WindowView = {
  messages: SessionMessageInfo[]
  index: Map<string, number>
  cursor: string | undefined
  focus: string | undefined
}

type Segment = {
  /** Index of this segment's first message in the authoritative array. */
  start: number
  length: number
  refetchCursor?: string
  live: boolean
}

type SessionWindow = {
  /** The single authoritative transcript array, shared with the Solid store on publish. */
  messages: SessionMessageInfo[]
  /** Server page boundaries, oldest first. The last segment is the live tail. */
  segments: Segment[]
  index: Map<string, number>
  bytes: number
  oversized: number
  cursor: string | undefined
  focus: string | undefined
  mode: ResidencyMode
}

const maxMessageBytesDefault = defaultWindowBudgets.maxMessageBytes!

// String values are counted as two bytes per UTF-16 code unit. Object overhead is
// estimated conservatively. Depth and per-field caps keep measurement bounded: a
// megabyte tool input is counted as a bounded read, never JSON-stringified whole.
const measurementDepth = 12
const perFieldCap = 256 * 1024

function valueBytes(value: unknown, depth: number, seen: WeakSet<object>): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return Math.min(value.length * 2, perFieldCap)
  if (typeof value === "number" || typeof value === "boolean") return 8
  if (depth > measurementDepth) return 64
  if (typeof value !== "object") return 32
  if (seen.has(value)) return 0
  seen.add(value)
  let bytes = 32
  if (Array.isArray(value)) {
    for (const item of value) bytes += Math.min(valueBytes(item, depth + 1, seen), perFieldCap)
    return Math.min(bytes, perFieldCap * 4)
  }
  for (const key of Object.keys(value)) {
    bytes += key.length * 2 + Math.min(valueBytes((value as Record<string, unknown>)[key], depth + 1, seen), perFieldCap)
  }
  return Math.min(bytes, perFieldCap * 4)
}

/**
 * Approximate resident bytes of one message without serializing whole tool payloads.
 * Counts prose, tool inputs, metadata, native replay data and string/file payloads.
 */
export function messageBytes(message: SessionMessageInfo) {
  return 128 + valueBytes(message, 0, new WeakSet())
}

/**
 * Authoritative, page-aware resident transcript. Live events, streaming, compaction,
 * revert and deletion all go through this store; the Solid array and its O(1) index
 * are derived from it in one publication step. Fetched pages keep their boundaries
 * so a whole old page can be evicted and refetched by cursor, never cut in the middle.
 */
export class MessageWindow {
  private readonly sessions = new Map<string, SessionWindow>()

  private state(sessionID: string): SessionWindow {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = {
        messages: [],
        segments: [],
        index: new Map(),
        bytes: 0,
        oversized: 0,
        cursor: undefined,
        focus: undefined,
        mode: "tail",
      }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  private reindex(state: SessionWindow, max: number) {
    const index = new Map<string, number>()
    let bytes = 0
    let oversized = 0
    for (let position = 0; position < state.messages.length; position++) {
      const message = state.messages[position]
      if (!message) continue
      index.set(message.id, position)
      const measured = messageBytes(message)
      if (measured > max) oversized++
      bytes += Math.min(measured, max)
    }
    state.index = index
    state.bytes = bytes
    state.oversized = oversized
  }

  private segmentsFrom(pages: readonly FetchedPage[]): Segment[] {
    const segments: Segment[] = []
    let start = 0
    pages.forEach((page, at) => {
      const length = page.messages.length
      if (length === 0) return
      segments.push({
        start,
        length,
        refetchCursor: page.refetchCursor,
        live: at === pages.length - 1,
      })
      start += length
    })
    return segments
  }

  /** Replace the whole transcript, preserving the boundaries of every fetched page. */
  set(sessionID: string, messages: readonly SessionMessageInfo[], cursor: string | undefined, pages?: readonly FetchedPage[]) {
    const state = this.state(sessionID)
    state.messages = pages ? pages.flatMap((page) => [...page.messages]) : [...messages]
    state.segments = pages ? this.segmentsFrom(pages) : [{ start: 0, length: state.messages.length, live: true }]
    state.cursor = cursor
    state.focus = undefined
    state.mode = "tail"
    this.reindex(state, maxMessageBytesDefault)
    return this.view(sessionID)
  }

  /** Prepend one fetched server page; `refetchCursor` is the cursor that produced it. */
  prepend(sessionID: string, messages: readonly SessionMessageInfo[], refetchCursor: string, next: string | undefined) {
    const state = this.state(sessionID)
    for (const segment of state.segments) segment.start += messages.length
    state.messages = [...messages, ...state.messages]
    state.segments.unshift({ start: 0, length: messages.length, refetchCursor, live: false })
    state.cursor = next
    // A prepend always means the reader moved to older history, even when the
    // browsing mode is only selected by the trim that follows this read.
    if (messages.length > 0) state.focus = messages[0]?.id
    this.reindex(state, maxMessageBytesDefault)
    return this.view(sessionID)
  }

  /** Append messages to the live tail page (outbox admission, delivered input, new events). */
  append(sessionID: string, messages: readonly SessionMessageInfo[]) {
    if (messages.length === 0) return this.view(sessionID)
    const state = this.state(sessionID)
    const tail = state.segments.at(-1)
    if (tail) tail.length += messages.length
    else state.segments.push({ start: 0, length: messages.length, live: true })
    state.messages.push(...messages)
    this.reindex(state, maxMessageBytesDefault)
    return this.view(sessionID)
  }

  /**
   * Mutate the authoritative array through the same `(messages, index)` contract the
   * store used before. Length changes are absorbed by the live tail segment: only
   * tail messages are inserted, reordered or removed by live events.
   */
  edit(sessionID: string, fn: (messages: SessionMessageInfo[], index: Map<string, number>) => void) {
    const state = this.state(sessionID)
    const before = state.messages.length
    fn(state.messages, state.index)
    const delta = state.messages.length - before
    const tail = state.segments.at(-1)
    if (tail) tail.length = Math.max(1, tail.length + delta)
    if (state.messages.length === 0) state.segments = []
    for (let position = 0, offset = 0; position < state.segments.length; position++) {
      const segment = state.segments[position]!
      segment.start = offset
      offset += segment.length
    }
    if (state.focus && !state.index.has(state.focus)) state.focus = undefined
    this.reindex(state, maxMessageBytesDefault)
    return this.view(sessionID)
  }

  /**
   * Adopt the array a store publication produced as the authoritative messages.
   * The window owns the index, byte accounting and page boundaries; the store owns
   * the reactive objects. This is the single hand-off between the two, so neither
   * side keeps an independent copy of the transcript.
   */
  adopt(sessionID: string, messages: readonly SessionMessageInfo[]) {
    const state = this.state(sessionID)
    const delta = messages.length - state.messages.length
    state.messages = [...messages]
    const tail = state.segments.at(-1)
    if (tail) tail.length = Math.max(1, tail.length + delta)
    else if (messages.length > 0) state.segments.push({ start: 0, length: messages.length, live: true })
    if (messages.length === 0) state.segments = []
    for (let position = 0, offset = 0; position < state.segments.length; position++) {
      const segment = state.segments[position]!
      segment.start = offset
      offset += segment.length
    }
    if (state.focus && !state.index.has(state.focus)) state.focus = undefined
    this.reindex(state, maxMessageBytesDefault)
    return this.view(sessionID)
  }

  /** Upsert one message: append when absent, replace in place when present. */
  upsert(sessionID: string, message: SessionMessageInfo) {
    return this.edit(sessionID, (messages, index) => {
      const position = index.get(message.id)
      if (position === undefined) {
        index.set(message.id, messages.length)
        messages.push(message)
      } else {
        messages[position] = message
      }
    })
  }

  /** Remove messages by id (retract, revert, deletion). */
  remove(sessionID: string, ids: ReadonlySet<string>) {
    if (ids.size === 0) return this.view(sessionID)
    return this.edit(sessionID, (messages, index) => {
      for (let position = messages.length - 1; position >= 0; position--) {
        const message = messages[position]
        if (!message || !ids.has(message.id)) continue
        messages.splice(position, 1)
        index.delete(message.id)
      }
    })
  }

  /** Delete from the first id at or after a revert boundary through the end. */
  revert(sessionID: string, boundary: (message: SessionMessageInfo) => boolean) {
    return this.edit(sessionID, (messages, index) => {
      const position = messages.findIndex(boundary)
      if (position === -1) return
      for (const item of messages.splice(position)) index.delete(item.id)
    })
  }

  /** Where the reader currently is in history; retained pages cluster around it. */
  focusOn(sessionID: string, messageID: string | undefined) {
    this.state(sessionID).focus = messageID
  }

  modeOf(sessionID: string) {
    return this.state(sessionID).mode
  }

  index(sessionID: string) {
    return this.sessions.get(sessionID)?.index ?? new Map<string, number>()
  }

  residentBytes(sessionID: string) {
    return this.sessions.get(sessionID)?.bytes ?? 0
  }

  pages(sessionID: string) {
    const state = this.sessions.get(sessionID)
    if (!state) return []
    return state.segments.map((segment) => ({
      messages: stateMessages(state, segment),
      refetchCursor: segment.refetchCursor,
      live: segment.live,
    }))
  }

  view(sessionID: string): WindowView {
    const state = this.sessions.get(sessionID)
    return {
      messages: state?.messages ?? [],
      index: state?.index ?? new Map<string, number>(),
      cursor: state?.cursor,
      focus: state?.focus,
    }
  }

  /**
   * Evict whole pages until the resident window fits the active residency mode.
   * `tail` evicts oldest first. `history-browsing` keeps a bounded window around the
   * reader's focus (plus the live tail) and evicts the page farthest from it first,
   * so sequential upward scrolling always makes progress instead of immediately
   * refetching a page that was just evicted.
   */
  trim(
    sessionID: string,
    pinned: ReadonlySet<string>,
    all: boolean,
    budgets: WindowBudgets = defaultWindowBudgets,
  ): WindowView {
    const state = this.state(sessionID)
    const mode: ResidencyMode = all ? "history-browsing" : state.mode
    state.mode = mode
    const limit = mode === "history-browsing" ? budgets.historyBytes : budgets.tailBytes
    const max = budgets.maxMessageBytes ?? maxMessageBytesDefault
    while (state.bytes > limit && state.segments.length > 1) {
      const focusPage = mode === "history-browsing" && state.focus ? state.index.get(state.focus) : undefined
      const candidates = state.segments
        .map((segment, at) => ({ segment, at }))
        .filter(({ segment }) =>
          !segment.live &&
          !segmentPinned(state, segment, pinned) &&
          (focusPage === undefined ||
            focusPage < segment.start ||
            focusPage >= segment.start + segment.length))
      if (candidates.length === 0) break
      const focusPosition = state.focus ? state.index.get(state.focus) : undefined
      candidates.sort((a, b) => {
        if (mode === "history-browsing" && focusPosition !== undefined) {
          const distance = (entry: typeof a) =>
            Math.abs((entry.segment.start + entry.segment.length - 1) - focusPosition)
          return distance(b) - distance(a)
        }
        return a.at - b.at
      })
      const victim = candidates[0]!
      const removed = state.messages.splice(victim.segment.start, victim.segment.length)
      for (const message of removed) state.index.delete(message.id)
      state.segments = state.segments.filter((segment) => segment !== victim.segment)
      for (const segment of state.segments) {
        if (segment.start > victim.segment.start) segment.start -= victim.segment.length
      }
      state.cursor = victim.segment.refetchCursor
      if (state.focus && !state.index.has(state.focus)) state.focus = undefined
      this.reindex(state, max)
    }
    return this.view(sessionID)
  }

  /** Counters for the load benchmark and resident-byte instrumentation. */
  stats() {
    let messages = 0
    let bytes = 0
    let pages = 0
    let oversized = 0
    for (const state of this.sessions.values()) {
      messages += state.messages.length
      bytes += state.bytes
      pages += state.segments.length
      oversized += state.oversized
    }
    return { sessions: this.sessions.size, messages, bytes, pages, oversized }
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
  }
}

function stateMessages(state: SessionWindow, segment: Segment) {
  return state.messages.slice(segment.start, segment.start + segment.length)
}

function segmentPinned(state: SessionWindow, segment: Segment, pinned: ReadonlySet<string>) {
  const end = segment.start + segment.length
  for (let position = segment.start; position < end; position++) {
    const message = state.messages[position]
    if (message && pinned.has(message.id)) return true
  }
  return false
}
