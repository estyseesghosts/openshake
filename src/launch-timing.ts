/**
 * Host-level launch stopwatch. The origin is captured when this module is first
 * imported (the first import in main.tsx), so every mark is process-relative rather
 * than relative to the TUI's own module evaluation.
 */
export const launchMarks = ["entry", "plugins", "backend", "tui-import"] as const
export type LaunchMark = (typeof launchMarks)[number]

export type LaunchSnapshot = {
  totalMs: number
  elapsed: Partial<Record<LaunchMark, number>>
}

export function createLaunchTiming(now: () => number = () => performance.now()) {
  const origin = now()
  const marks = new Map<LaunchMark, number>()
  return {
    mark(name: LaunchMark) {
      if (!marks.has(name)) marks.set(name, now())
    },
    snapshot(): LaunchSnapshot {
      const elapsed: Partial<Record<LaunchMark, number>> = {}
      for (const name of launchMarks) {
        const at = marks.get(name)
        if (at !== undefined) elapsed[name] = at - origin
      }
      return { totalMs: now() - origin, elapsed }
    },
  }
}

export const launchTiming = createLaunchTiming()
