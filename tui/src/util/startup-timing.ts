export const startupMarks = ["entry", "renderer", "first-frame", "session-usable", "plugins-settled"] as const
export type StartupMark = (typeof startupMarks)[number]

export type StartupSnapshot = {
  totalMs: number
  marks: Partial<Record<StartupMark, number>>
  /** Milliseconds elapsed from process entry to each mark, in startup order. */
  elapsed: Partial<Record<StartupMark, number>>
}

/** Tiny, allocation-free timing ledger. Never used on a render path except at explicit boundaries. */
export function createStartupTiming(now: () => number = () => performance.now()) {
  const origin = now()
  const marks = new Map<StartupMark, number>()
  return {
    mark(name: StartupMark) {
      if (!marks.has(name)) marks.set(name, now())
    },
    snapshot(): StartupSnapshot {
      const result: StartupSnapshot = { totalMs: now() - origin, marks: {}, elapsed: {} }
      for (const name of startupMarks) {
        const at = marks.get(name)
        if (at === undefined) continue
        result.marks[name] = at
        result.elapsed[name] = at - origin
      }
      return result
    },
  }
}

/** Process-entry origin is captured when this module is first imported. */
export const startupTiming = createStartupTiming()
