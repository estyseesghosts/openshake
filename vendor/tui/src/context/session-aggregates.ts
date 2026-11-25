export type FamilyCounts = {
  running: number
  pending: number
  forms: number
  permissions: number
}

export const emptyFamilyCounts = (): FamilyCounts => ({ running: 0, pending: 0, forms: 0, permissions: 0 })

export type FamilyObservation = {
  sessionID: string
  root: string
  counts: FamilyCounts
}

const fields: readonly (keyof FamilyCounts)[] = ["running", "pending", "forms", "permissions"]

/**
 * Root/family counters maintained by reconciliation rather than by scanning every
 * family member each time a tab is drawn. Each observation owns exactly one member;
 * reparenting transfers that member between roots and deletion removes it entirely.
 * `sync` is also the reconnect rebuild path: a fresh snapshot replaces all state.
 */
export class FamilyAggregates {
  private readonly members = new Map<string, { root: string; counts: FamilyCounts }>()
  private readonly roots = new Map<string, FamilyCounts>()

  private adjust(root: string, counts: FamilyCounts, sign: 1 | -1) {
    const current = this.roots.get(root) ?? emptyFamilyCounts()
    for (const field of fields) current[field] += sign * counts[field]
    const empty = fields.every((field) => current[field] === 0)
    if (empty) this.roots.delete(root)
    else this.roots.set(root, current)
  }

  /**
   * Apply one member's observation. This is the incremental path: a tab only
   * updates its own member when its active/pending/form/permission state changes,
   * instead of rebuilding observations for every open family.
   */
  update(observation: FamilyObservation) {
    const { sessionID, root, counts } = observation
    if (!root) return
    const previous = this.members.get(sessionID)
    if (previous?.root === root && fields.every((field) => previous.counts[field] === counts[field])) return
    if (previous) this.adjust(previous.root, previous.counts, -1)
    this.adjust(root, counts, 1)
    this.members.set(sessionID, { root, counts: { ...counts } })
  }

  /** Forget a member that left every open family, or was deleted. */
  remove(sessionID: string) {
    const previous = this.members.get(sessionID)
    if (!previous) return
    this.adjust(previous.root, previous.counts, -1)
    this.members.delete(sessionID)
  }

  /** Reconcile a full snapshot on reconnect. Absent members are removed. */
  sync(observations: Iterable<FamilyObservation>) {
    const present = new Set<string>()
    for (const observation of observations) {
      present.add(observation.sessionID)
      this.update(observation)
    }
    for (const sessionID of [...this.members.keys()]) {
      if (!present.has(sessionID)) this.remove(sessionID)
    }
  }

  snapshot(root: string): FamilyCounts {
    return { ...(this.roots.get(root) ?? emptyFamilyCounts()) }
  }

  get size() {
    return this.members.size
  }
}
