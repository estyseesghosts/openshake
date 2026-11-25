import type { SessionMessageInfo } from "@opencode/client"

/**
 * Presence of projected idle markers per session. Turn-boundary logic previously
 * rescanned the whole loaded transcript on every reduction; tracking marker IDs as
 * messages are admitted and removed makes `has` a constant-time lookup.
 */
export class IdleMarkerIndex {
  private readonly ids = new Map<string, Set<string>>()

  observe(sessionID: string, messages: readonly SessionMessageInfo[]) {
    const present = new Set<string>()
    for (const message of messages) {
      if (message.type === "idle") present.add(message.id)
    }
    this.ids.set(sessionID, present)
  }

  add(sessionID: string, message: SessionMessageInfo) {
    if (message.type !== "idle") return
    const present = this.ids.get(sessionID) ?? new Set<string>()
    present.add(message.id)
    this.ids.set(sessionID, present)
  }

  remove(sessionID: string, messageID: string) {
    const present = this.ids.get(sessionID)
    if (!present) return
    present.delete(messageID)
  }

  has(sessionID: string) {
    return (this.ids.get(sessionID)?.size ?? 0) > 0
  }

  forget(sessionID: string) {
    this.ids.delete(sessionID)
  }
}
