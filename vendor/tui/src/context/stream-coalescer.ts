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
 * flush window. Lifecycle events call `flush()` synchronously, so the final payload
 * always wins. Progress metadata is last-write-wins within the same window.
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

  /** Publish everything accumulated so far. Safe to call repeatedly. */
  flush() {
    if (this.pending.size === 0) return
    const entries = [...this.pending.values()]
    this.pending.clear()
    this.scheduled = false
    entries.forEach((entry) => this.apply(entry))
  }

  /** Dispose must never publish stale buffered content into a new session generation. */
  dispose() {
    this.pending.clear()
    this.scheduled = false
  }
}
