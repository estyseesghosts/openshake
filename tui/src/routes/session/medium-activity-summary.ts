import type { SessionMessageAssistantTool } from "@opencode/client"
import { canonicalToolName, executeCalls, finiteNumber, type ExecuteCall } from "../../util/tool-display"

export type MediumAction = { name: string }

type Phrase = { verb: string; noun: (count: number) => string; count: number }

const activityPhrases: Record<string, Omit<Phrase, "count">> = {
  read: { verb: "Read", noun: (count) => `${count} ${count === 1 ? "file" : "files"}` },
  glob: { verb: "Searched", noun: (count) => `${count} ${count === 1 ? "time" : "times"}` },
  grep: { verb: "Searched", noun: (count) => `${count} ${count === 1 ? "time" : "times"}` },
  websearch: { verb: "Searched", noun: (count) => `${count} ${count === 1 ? "time" : "times"}` },
  webfetch: { verb: "Fetched", noun: (count) => `${count} ${count === 1 ? "page" : "pages"}` },
  shell: { verb: "Ran", noun: (count) => `${count} ${count === 1 ? "command" : "commands"}` },
  execute: { verb: "Ran", noun: (count) => `${count} ${count === 1 ? "script" : "scripts"}` },
}

const editPhrases: Record<string, Omit<Phrase, "count">> = {
  edit: { verb: "Edited", noun: (count) => `${count} ${count === 1 ? "file" : "files"}` },
  write: { verb: "Edited", noun: (count) => `${count} ${count === 1 ? "file" : "files"}` },
  patch: { verb: "Edited", noun: (count) => `${count} ${count === 1 ? "file" : "files"}` },
}

/** Count actions by verb, preserving the order in which each verb first appeared. */
function phrases(actions: readonly MediumAction[], table: Record<string, Omit<Phrase, "count">>): Phrase[] {
  const result: Phrase[] = []
  const byVerb = new Map<string, Phrase>()
  actions.forEach((action) => {
    const template = table[canonicalToolName(action.name.toLowerCase())]
    if (!template) return
    let phrase = byVerb.get(template.verb)
    if (!phrase) {
      phrase = { ...template, count: 0 }
      byVerb.set(template.verb, phrase)
      result.push(phrase)
    }
    phrase.count++
  })
  return result
}

function join(phrases: readonly Phrase[]) {
  return phrases
    .map((phrase, index) => {
      const text = `${phrase.verb} ${phrase.noun(phrase.count)}`
      return index === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`
    })
    .join(", ")
}

/** Medium activity summary, e.g. "Read 4 files, ran 2 commands". Pure and stable for hydration and live events. */
export function mediumActivitySummary(actions: readonly MediumAction[]) {
  return join(phrases(actions, activityPhrases))
}

/** Medium edit summary, e.g. "Edited 4 files · +31 −12". Counts come from parsed patch metadata. */
export function mediumEditsSummary(actions: readonly MediumAction[], additions = 0, deletions = 0) {
  const label = join(phrases(actions, editPhrases))
  const change = additions === 0 && deletions === 0 ? "" : ` · +${additions} −${deletions}`
  return `${label}${change}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A Code Mode call can end in failure while its own tool state stays completed. */
export function mediumExecuteFailed(part: SessionMessageAssistantTool) {
  if (canonicalToolName(part.name.toLowerCase()) !== "execute") return false
  const metadata = record(record(part.state)?.metadata)
  return executeCalls(metadata?.toolCalls).some((call) => call.status === "error")
}

/** Reuse the addition/deletion counts OpenCode already parsed rather than reparsing patches. */
export function mediumEditCounts(part: SessionMessageAssistantTool) {
  const metadata =
    part.state.status === "streaming" || part.state.status === "running" ? undefined : part.state.metadata
  const files = record(metadata)?.files
  let additions = 0
  let deletions = 0
  if (Array.isArray(files)) {
    files.forEach((file) => {
      const item = record(file)
      additions += finiteNumber(item?.additions) ?? 0
      deletions += finiteNumber(item?.deletions) ?? 0
    })
  }
  return { additions, deletions }
}

/** Keep a single line, bounded and free of control characters or raw tool output. */
function clamp(value: string, limit = 64) {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

function inputString(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ""
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim()) return clamp(value)
  }
  return ""
}

/** Identity line for a nested Code Mode call, matching Margarita's nested-call behavior. */
function nestedCallLine(call: ExecuteCall) {
  const name = canonicalToolName(call.tool.toLowerCase())
  const input: unknown = call.input
  if (name === "read") {
    const file = inputString(input, ["path", "filePath", "file"])
    return file ? `Reading ${file}` : "Reading…"
  }
  if (name === "shell") {
    const command = inputString(input, ["command", "cmd"])
    return command ? `$ ${command}` : "Running command…"
  }
  if (name === "grep" || name === "glob" || name === "websearch") {
    const query = inputString(input, ["pattern", "query", "regex"])
    return query ? `Searching "${query}"` : "Searching…"
  }
  return `Running ${name}…`
}

/** One identity line for a collapsed group's newest genuinely running child. */
export function mediumLiveLine(part: SessionMessageAssistantTool) {
  if (part.state.status !== "running" && part.state.status !== "streaming") return ""
  const name = canonicalToolName(part.name.toLowerCase())
  const input: unknown = part.state.input
  let line: string
  if (name === "shell") {
    const command = inputString(input, ["command", "cmd"])
    line = command ? `$ ${command}` : "Running command…"
  } else if (name === "read") {
    const file = inputString(input, ["path", "filePath", "file"])
    line = file ? `Reading ${file}` : "Reading…"
  } else if (name === "edit" || name === "write" || name === "patch") {
    const file = inputString(input, ["path", "filePath", "file"])
    line = file ? `Editing ${file}` : "Editing…"
  } else if (name === "glob" || name === "grep" || name === "websearch") {
    const query = inputString(input, ["pattern", "query", "regex"])
    line = query ? `Searching "${query}"` : "Searching…"
  } else if (name === "webfetch") {
    const url = inputString(input, ["url"])
    line = url ? `Fetching ${url}` : "Fetching…"
  } else if (name === "execute") {
    const metadata = part.state.status === "running" ? part.state.metadata : undefined
    const nested = executeCalls(metadata?.toolCalls).find((call) => call.status === "running")
    line = nested ? nestedCallLine(nested) : "Running code…"
  } else {
    line = `Running ${name}…`
  }
  return clamp(line)
}
