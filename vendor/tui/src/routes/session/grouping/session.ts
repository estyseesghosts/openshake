import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { canonicalToolName } from "../../../util/tool-display"
import { groupEntries, mergeGroups, splitGroups, type GroupNode } from "./tree"

export type PartRef = {
  messageID: string
  partID: string
}

export type CacheUsage = {
  read: number
  model: SessionMessageAssistant["model"]
}

export type SessionEntry =
  | { type: "message"; messageID: string }
  | { type: "compaction-queued"; inboxID: string }
  | { type: "part"; ref: PartRef }
  | { type: "assistant-footer"; messageID: string }
  | { type: "turn-usage"; messageIDs: string[]; previousCache?: CacheUsage }

export type GroupKind =
  | "activity"
  | "reasoning"
  | "exploration"
  | "instructions"
  | "medium-activity"
  | "medium-edits"
export type SessionNode = GroupNode<SessionEntry, GroupKind>
export type SessionGroup = {
  type: "group"
  children: readonly GroupNode<SessionEntry, GroupKind>[]
  size: number
  completed: boolean
} & (
  | { kind: "reasoning" | "instructions" }
  | { kind: "exploration" | "activity" | "medium-activity" | "medium-edits"; pending: PartRef[] }
)

/** Group kinds that keep blocked tools outside their summary via `pending`. */
const pendingKinds = new Set<GroupKind>(["exploration", "activity", "medium-activity", "medium-edits"])
type PendingKind = "exploration" | "activity" | "medium-activity" | "medium-edits"

function isPendingKind(kind: GroupKind): kind is PendingKind {
  return pendingKinds.has(kind)
}

function pendingGroup(row: SessionGroup): row is Extract<SessionGroup, { kind: PendingKind }> {
  return isPendingKind(row.kind)
}

/** Experimental transcript detail; undefined selects the default production rules. */
export type Verbosity = "low" | "medium" | "high"
export const defaultVerbosity: Verbosity = "low"

export type SessionRow = SessionEntry | SessionGroup

export type AppendPart =
  | { type: "text" }
  | { type: "reasoning"; time?: { completed?: number } }
  | { type: "tool"; name: string; error?: boolean }

export type ProjectionEntry = {
  entry: SessionEntry
  part?: AppendPart
  path?: readonly GroupKind[]
  closesPrevious?: boolean
}

/** Hydrate a fresh history batch in one pass rather than merging one leaf at a time. */
export function projectEntries(entries: ProjectionEntry[]): SessionRow[] {
  const nodes = groupEntries(entries, (item) => item.path ?? [])
  return nodes.map((node, index) => {
    if (node.type === "entry") return node.entry.entry
    const next = nodes[index + 1]
    const completed =
      (next !== undefined && (next.type === "group" || next.entry.closesPrevious !== false)) ||
      (node.kind === "reasoning" &&
        node.children.every(
          (child) =>
            child.type === "entry" &&
            child.entry.part?.type === "reasoning" &&
            child.entry.part.time?.completed !== undefined,
        ))
    return sessionGroup({ ...node, children: node.children.map(unwrap) }, completed)
  })
}

function sessionGroup(node: Extract<SessionNode, { type: "group" }>, completed: boolean): SessionGroup {
  if (isPendingKind(node.kind)) return { ...node, kind: node.kind, pending: [], completed }
  return { ...node, kind: node.kind, completed }
}

function unwrap(node: GroupNode<ProjectionEntry, GroupKind>): GroupNode<SessionEntry, GroupKind> {
  if (node.type === "entry") return { ...node, entry: node.entry.entry }
  return { ...node, children: node.children.map(unwrap) }
}

const explorationTools = new Set(["read", "glob", "grep", "webfetch", "websearch"])
const mediumActivityTools = new Set(["read", "glob", "grep", "webfetch", "websearch", "shell", "execute"])
const mediumEditTools = new Set(["edit", "write", "patch"])
const mediumStandaloneTools = new Set(["question", "subagent", "task"])

function toolName(part: AppendPart & { type: "tool" }) {
  return canonicalToolName(part.name.toLowerCase())
}

/** Low is unchanged: one activity summary wraps every run of tools and thoughts. */
function lowPath(part: AppendPart): readonly GroupKind[] {
  if (part.type === "tool" && toolName(part) === "question") return []
  const activity: GroupKind[] = part.type !== "text" ? ["activity"] : []
  if (part.type === "reasoning") return [...activity, "reasoning"]
  if (part.type === "tool" && explorationTools.has(toolName(part))) return [...activity, "exploration"]
  return activity
}

/**
 * Medium folds only positively-classified repetitive work. Edits and other activity
 * each get their own semantic group; prose, instructions, interactive tools, unknown
 * tools and terminal failures remain standalone boundaries.
 */
function mediumPath(part: AppendPart): readonly GroupKind[] {
  if (part.type === "text") return []
  if (part.type === "reasoning") return ["reasoning"]
  if (part.type !== "tool" || part.error) return []
  const name = toolName(part)
  if (mediumStandaloneTools.has(name)) return []
  if (mediumEditTools.has(name)) return ["medium-edits"]
  if (mediumActivityTools.has(name)) return ["medium-activity"]
  return []
}

/** High keeps the original mostly-expanded shape; only reasoning and exploration group. */
function highPath(part: AppendPart): readonly GroupKind[] {
  if (part.type === "tool" && toolName(part) === "question") return []
  if (part.type === "reasoning") return ["reasoning"]
  if (part.type === "tool" && explorationTools.has(toolName(part))) return ["exploration"]
  return []
}

/**
 * Grouping path for an assistant part. Split by mode so a classification tweak in
 * Medium can never leak into Low's activity summary or High's projection.
 */
export function partPath(part: AppendPart, verbosity: Verbosity): readonly GroupKind[] {
  switch (verbosity) {
    case "low":
      return lowPath(part)
    case "medium":
      return mediumPath(part)
    case "high":
      return highPath(part)
  }
}

/** Instruction loads group; other messages stand alone. */
export function messagePath(message: SessionMessageInfo, verbosity: Verbosity): readonly GroupKind[] {
  if (instructionPaths(message).length === 0) return []
  return verbosity === "low" ? ["activity", "instructions"] : ["instructions"]
}

/** Files loaded by an instruction message; one load can carry several. */
export function instructionPaths(message: SessionMessageInfo | undefined): string[] {
  if (message?.type !== "synthetic") return []
  const instruction = message.metadata?.instruction
  if (typeof instruction !== "object" || instruction === null || Array.isArray(instruction)) return []
  return Array.isArray(instruction.paths)
    ? instruction.paths.filter((path): path is string => typeof path === "string")
    : []
}

/** Production rules only: keep lifecycle/status decisions outside the tree engine. */
export function append(
  rows: SessionRow[],
  ref: PartRef,
  part: AppendPart,
  index = rows.length,
  verbosity = defaultVerbosity,
) {
  const [node] = groupEntries<SessionEntry, GroupKind>([{ type: "part", ref }], () => partPath(part, verbosity))
  if (node.type === "entry") {
    completePrevious(rows, index)
    rows.splice(index, 0, node.entry)
    return
  }
  const previous = rows[index - 1]
  if (previous?.type === "group" && previous.kind === node.kind) {
    // Permission-blocked tools remain at the end, just as the former refs/pending
    // partition did. Inserting a new ref must precede those blocked tools.
    const pending = pendingGroup(previous) ? previous.pending.length : 0
    const [left, right] = splitGroups([previous], previous.size - pending)
    const [merged] = mergeGroups(mergeGroups(left, [node]), right)
    if (merged.type !== "group") throw new Error("Expected merged session group")
    previous.children = merged.children
    previous.size = merged.size
    if (part.type === "reasoning") previous.completed &&= part.time?.completed !== undefined
    return
  }
  completePrevious(rows, index)
  rows.splice(
    index,
    0,
    sessionGroup(node, node.kind === "reasoning" && part.type === "reasoning" && part.time?.completed !== undefined),
  )
}

export function completePrevious(rows: SessionRow[], index = rows.length) {
  const previous = rows[index - 1]
  if (previous?.type === "group") previous.completed = true
}

/** Part references for an existing production subgroup, not a flat timeline. */
export function groupRefs(row: SessionGroup, includePending = false): PartRef[] {
  const pending = !includePending && pendingGroup(row) ? row.pending : []
  const visit = (nodes: readonly GroupNode<SessionEntry, GroupKind>[]): PartRef[] =>
    nodes.flatMap((node) => {
      if (node.type === "group") return visit(node.children)
      if (node.entry.type !== "part") return []
      const ref = node.entry.ref
      if (pending.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)) return []
      return [ref]
    })
  return visit(row.children)
}

export function partitionPending(rows: SessionRow[], pending: Set<string>) {
  rows.forEach((row) => {
    if (row.type !== "group" || !pendingGroup(row)) return
    // The production exploration rule creates direct part children. Preserve the
    // existing stable partition order when permissions are admitted or dismissed.
    // Activity groups render blocked tools outside the summary without reordering.
    if (row.kind === "exploration") {
      const blocked = (node: GroupNode<SessionEntry, GroupKind>) =>
        node.type === "entry" && node.entry.type === "part" && pending.has(node.entry.ref.partID)
      row.children = [...row.children.filter((node) => !blocked(node)), ...row.children.filter(blocked)]
    }
    row.pending = groupRefs(row, true).filter((ref) => pending.has(ref.partID))
  })
}

export function hasPart(rows: SessionRow[], ref: PartRef) {
  return rows.some((row) => {
    if (row.type === "part") return row.ref.messageID === ref.messageID && row.ref.partID === ref.partID
    if (row.type !== "group") return false
    return groupRefs(row, true).some((item) => item.messageID === ref.messageID && item.partID === ref.partID)
  })
}
