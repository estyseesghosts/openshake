export type StreamKind = "text" | "reasoning" | "tool-input" | "tool-progress"

export type StreamEntry = {
  sessionID: string
  messageID: string
  partID: string
  kind: StreamKind
  text?: string
  metadata?: unknown
}

function key(sessionID: string, messageID: string, partID: string, kind: StreamKind) {
  return `${sessionID}\u0000${messageID}\u0000${partID}\u0000${kind}`
}

/**
 * Accumulates high-frequency streaming deltas per part and publishes them once per
 * flush window. Terminal lifecycle events flush only the part, message or session
 * they belong to, so a busy session's lifecycle traffic never publishes another
 * session's buffered deltas. A single insertion-ordered pending map means scoped
 * flushes cannot reorder delta and completion events.
 */
export class StreamCoalescer {
  private readonly pending = new Map<string, StreamEntry>()
  private scheduled = false

  constructor(
    private readonly apply: (entry: StreamEntry) => void,
    private readonly schedule: (flush: () => void) => void = queueMicrotask,
  ) {}

  private add(entry: StreamEntry) {
    const id = key(entry.sessionID, entry.messageID, entry.partID, entry.kind)
    const previous = this.pending.get(id)
    if (previous && entry.kind !== "tool-progress") {
      previous.text = `${previous.text ?? ""}${entry.text ?? ""}`
    } else {
      this.pending.set(id, { ...entry })
    }
    if (!this.scheduled) {
      this.scheduled = true
      this.schedule(() => this.flush())
    }
  }

  text(sessionID: string, messageID: string, delta: string) {
    this.add({ sessionID, messageID, partID: "text", kind: "text", text: delta })
  }

  reasoning(sessionID: string, messageID: string, delta: string) {
    this.add({ sessionID, messageID, partID: "reasoning", kind: "reasoning", text: delta })
  }

  toolInput(sessionID: string, messageID: string, toolID: string, delta: string) {
    this.add({ sessionID, messageID, partID: toolID, kind: "tool-input", text: delta })
  }

  toolProgress(sessionID: string, messageID: string, toolID: string, metadata: unknown) {
    this.add({ sessionID, messageID, partID: toolID, kind: "tool-progress", metadata })
  }

  /** Publish one part's buffered entries before its terminal event. */
  flushPart(sessionID: string, messageID: string, partID: string) {
    this.flushWhere(
      (entry) =>
        entry.sessionID === sessionID && entry.messageID === messageID && entry.partID === partID,
    )
  }

  /** Publish every buffered part of one message at a step boundary. */
  flushMessage(sessionID: string, messageID: string) {
    this.flushWhere((entry) => entry.sessionID === sessionID && entry.messageID === messageID)
  }

  /** Publish one session's buffered content at an execution boundary. */
  flushSession(sessionID: string) {
    this.flushWhere((entry) => entry.sessionID === sessionID)
  }

  /** Publish everything accumulated so far. Reserved for true global barriers. */
  flush() {
    this.flushWhere(() => true)
  }

  private flushWhere(match: (entry: StreamEntry) => boolean) {
    this.scheduled = false
    const entries: StreamEntry[] = []
    for (const [id, entry] of this.pending) {
      if (!match(entry)) continue
      entries.push(entry)
      this.pending.delete(id)
    }
    entries.forEach((entry) => this.apply(entry))
  }

  /** Counters for tests and instrumentation; never used on a render path. */
  pendingCount() {
    return this.pending.size
  }

  /** Dispose must never publish stale buffered content into a new session generation. */
  dispose() {
    this.pending.clear()
    this.scheduled = false
  }
}
