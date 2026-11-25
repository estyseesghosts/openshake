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

  /** Reconcile all observations in one pass. Absent members are removed. */
  sync(observations: Iterable<FamilyObservation>) {
    const next = new Map<string, { root: string; counts: FamilyCounts }>()
    for (const observation of observations) {
      if (observation.root) next.set(observation.sessionID, { root: observation.root, counts: observation.counts })
    }
    for (const [sessionID, previous] of this.members) {
      if (!next.has(sessionID)) {
        this.adjust(previous.root, previous.counts, -1)
        this.members.delete(sessionID)
      }
    }
    for (const [sessionID, current] of next) {
      const previous = this.members.get(sessionID)
      if (previous?.root === current.root && fields.every((field) => previous.counts[field] === current.counts[field]))
        continue
      if (previous) this.adjust(previous.root, previous.counts, -1)
      this.adjust(current.root, current.counts, 1)
      this.members.set(sessionID, { root: current.root, counts: { ...current.counts } })
    }
  }

  snapshot(root: string): FamilyCounts {
    return { ...(this.roots.get(root) ?? emptyFamilyCounts()) }
  }

  get size() {
    return this.members.size
  }
}
