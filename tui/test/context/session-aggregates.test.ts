import { expect, test } from "bun:test"
import {
  FamilyAggregates,
  type FamilyObservation,
} from "../../src/context/session-aggregates"

const counts = (running: number, pending: number, forms: number, permissions: number) => ({
  running,
  pending,
  forms,
  permissions,
})

const observe = (sessionID: string, root: string, value = counts(0, 0, 0, 0)): FamilyObservation => ({
  sessionID,
  root,
  counts: value,
})

test("aggregates sum members under their root without rescanning a family", () => {
  const aggregates = new FamilyAggregates()
  aggregates.sync([
    observe("root", "root", counts(1, 0, 0, 0)),
    observe("child", "root", counts(0, 1, 1, 0)),
    observe("other", "other", counts(0, 0, 0, 1)),
  ])
  expect(aggregates.snapshot("root")).toEqual(counts(1, 1, 1, 0))
  expect(aggregates.snapshot("other")).toEqual(counts(0, 0, 0, 1))
  expect(aggregates.snapshot("missing")).toEqual(counts(0, 0, 0, 0))
  expect(aggregates.size).toBe(3)
})

test("reparenting transfers a member's counts to the new root", () => {
  const aggregates = new FamilyAggregates()
  aggregates.sync([
    observe("root", "root", counts(1, 0, 0, 0)),
    observe("child", "root", counts(0, 1, 0, 0)),
  ])
  aggregates.sync([observe("root", "root", counts(1, 0, 0, 0)), observe("child", "new", counts(0, 1, 0, 0))])
  expect(aggregates.snapshot("root")).toEqual(counts(1, 0, 0, 0))
  expect(aggregates.snapshot("new")).toEqual(counts(0, 1, 0, 0))
})

test("deletion removes a member and an empty root disappears", () => {
  const aggregates = new FamilyAggregates()
  aggregates.sync([observe("root", "root", counts(1, 0, 0, 0)), observe("child", "root")])
  aggregates.sync([observe("root", "root", counts(0, 0, 0, 0))])
  expect(aggregates.snapshot("root")).toEqual(counts(0, 0, 0, 0))
  expect(aggregates.size).toBe(1)
})

test("one member updates only its own family counters", () => {
  const aggregates = new FamilyAggregates()
  aggregates.update(observe("root", "root", counts(1, 0, 0, 0)))
  aggregates.update(observe("child", "root", counts(0, 1, 0, 0)))
  aggregates.update(observe("other", "other", counts(0, 0, 1, 0)))
  expect(aggregates.snapshot("root")).toEqual(counts(1, 1, 0, 0))

  // Only the child's permission state changes; no other member is re-observed.
  aggregates.update(observe("child", "root", counts(0, 1, 0, 1)))
  expect(aggregates.snapshot("root")).toEqual(counts(1, 1, 0, 1))
  expect(aggregates.snapshot("other")).toEqual(counts(0, 0, 1, 0))

  // Reparenting and deletion are explicit single-member operations.
  aggregates.update(observe("child", "new", counts(0, 1, 0, 1)))
  expect(aggregates.snapshot("root")).toEqual(counts(1, 0, 0, 0))
  expect(aggregates.snapshot("new")).toEqual(counts(0, 1, 0, 1))
  aggregates.remove("child")
  expect(aggregates.snapshot("new")).toEqual(counts(0, 0, 0, 0))
  expect(aggregates.size).toBe(2)
})

test("a reconnect snapshot rebuilds aggregates, including orphan families", () => {
  const aggregates = new FamilyAggregates()
  aggregates.sync([observe("orphan", "orphan", counts(1, 0, 0, 0))])
  expect(aggregates.snapshot("orphan")).toEqual(counts(1, 0, 0, 0))
  // A fresh snapshot replaces stale counts instead of accumulating them.
  aggregates.sync([observe("orphan", "orphan", counts(0, 0, 0, 0))])
  expect(aggregates.snapshot("orphan")).toEqual(counts(0, 0, 0, 0))
})
