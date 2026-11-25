import { groupID } from "./anchors"
import { groupRefs, type PartRef, type SessionRow } from "./grouping/session"

function refKey(ref: PartRef) {
  return `${ref.messageID}\u0000${ref.partID}`
}

function rowKey(row: SessionRow) {
  return row.type === "group"
    ? groupID(row, 0)
    : row.type === "part"
      ? `part:${refKey(row.ref)}`
      : `${row.type}:${row.type === "message" || row.type === "assistant-footer" ? row.messageID : row.type === "compaction-queued" ? row.inboxID : row.messageIDs[0]}`
}

/**
 * Index of parts that already have a transcript row. Streaming text and reasoning
 * deltas arrive by the thousand for a part that was materialized long ago; this
 * makes the common case an O(1) membership check instead of a full `hasPart` walk
 * over every row and group. The index is rebuilt atomically with the row projection,
 * so rows remain the single source of truth.
 */
export class PartIndex {
  private readonly materialized = new Set<string>()
  private readonly owners = new Map<string, string>()

  /** Run `insert` only the first time a part becomes visible. */
  materialize(ref: PartRef, insert: () => void) {
    const key = refKey(ref)
    if (this.materialized.has(key)) return false
    insert()
    this.materialized.add(key)
    return true
  }

  has(ref: PartRef) {
    return this.materialized.has(refKey(ref))
  }

  /** Stable disclosure key of the reasoning group that owns a part, if any. */
  owner(ref: PartRef) {
    return this.owners.get(refKey(ref))
  }

  setOwner(ref: PartRef, groupKey: string) {
    this.owners.set(refKey(ref), groupKey)
  }

  /** Replace both maps from a freshly reduced row projection in one pass. */
  rebuild(rows: readonly SessionRow[]) {
    const next = new Set<string>()
    const nextOwners = new Map<string, string>()
    rows.forEach((row) => {
      if (row.type === "group") {
        const key = rowKey(row)
        groupRefs(row, true).forEach((ref) => {
          next.add(refKey(ref))
          if (row.kind === "reasoning") nextOwners.set(refKey(ref), key)
        })
        return
      }
      if (row.type === "part") next.add(refKey(row.ref))
    })
    this.materialized.clear()
    next.forEach((key) => this.materialized.add(key))
    this.owners.clear()
    nextOwners.forEach((value, key) => this.owners.set(key, value))
  }

  get size() {
    return this.materialized.size
  }
}
