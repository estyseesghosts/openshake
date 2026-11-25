import { expect, test } from "bun:test"
import { createStartupTiming, startupMarks } from "../../src/util/startup-timing"

test("marks record elapsed time from process entry and never overwrite the first occurrence", () => {
  let clock = 100
  const timing = createStartupTiming(() => clock)
  timing.mark("entry")
  expect(timing.snapshot().elapsed.entry).toBe(0)
  clock = 140
  timing.mark("renderer")
  timing.mark("renderer")
  clock = 210
  timing.mark("first-frame")
  const snapshot = timing.snapshot()
  expect(snapshot.totalMs).toBe(110)
  expect(snapshot.elapsed).toEqual({ entry: 0, renderer: 40, "first-frame": 110 })
  expect(Object.keys(snapshot.elapsed)).toEqual(["entry", "renderer", "first-frame"])
})

test("only observed marks appear, in the canonical startup order", () => {
  const timing = createStartupTiming(() => 0)
  timing.mark("plugins-settled")
  timing.mark("first-frame")
  expect(Object.keys(timing.snapshot().elapsed)).toEqual(["first-frame", "plugins-settled"])
  expect(startupMarks).toEqual([
    "entry",
    "renderer",
    "first-frame",
    "session-usable",
    "plugins-settled",
  ])
})
