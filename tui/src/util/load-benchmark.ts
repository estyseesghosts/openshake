import type { SessionMessageInfo } from "@opencode/client"
import { MessageWindow, defaultWindowBudgets, messageBytes } from "../context/message-window"
import { StreamCoalescer, type StreamEntry } from "../context/stream-coalescer"
import { PartIndex } from "../routes/session/rows-index"
import { createMediaCache } from "./media"

export type LoadScale = {
  sessions: number
  messagesPerSession: number
  assistants: number
  deltaRounds: number
  screenshotBytes: number
  diffLines: number
}

export const defaultLoadScale: LoadScale = {
  sessions: 40,
  messagesPerSession: 400,
  assistants: 12,
  deltaRounds: 200,
  screenshotBytes: 64 * 1024,
  diffLines: 25_000,
}

export type LoadFixture = {
  sessionIDs: readonly string[]
  messages: readonly SessionMessageInfo[]
  diff: string
  screenshots: readonly string[]
}

/** Deterministic linear congruential generator; a fixed seed keeps fixtures reproducible. */
function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const toolNames = ["read", "glob", "grep", "shell", "edit", "apply_patch"] as const

export function createLoadFixture(scale: LoadScale = defaultLoadScale): LoadFixture {
  const random = generator(0x5e3d)
  const sessionIDs = Array.from({ length: scale.sessions }, (_, index) => `session-${index}`)
  const messages: SessionMessageInfo[] = []

  for (const sessionID of sessionIDs) {
    for (let index = 0; index < scale.messagesPerSession; index++) {
      const agent = index % Math.max(1, scale.assistants)
      const tool = toolNames[Math.floor(random() * toolNames.length)] ?? "read"
      messages.push({
        type: "assistant",
        id: `${sessionID}-message-${index}`,
        agent: `agent-${agent}`,
        model: { id: "model", providerID: "provider" },
        time: { created: index, completed: index + 1 },
        content: [
          { type: "text", text: `step ${index} `.repeat(8) },
          {
            type: "tool",
            id: `${sessionID}-tool-${index}`,
            name: tool,
            time: { created: index, completed: index + 1 },
            state: {
              status: "completed",
              input: { path: `src/file-${index}.ts` },
              content: [{ type: "text", text: `result ${index}`.repeat(random() > 0.9 ? 200 : 2) }],
              metadata: {},
            },
          },
        ],
      })
      if (index % 50 === 0) {
        messages.push({
          id: `${sessionID}-idle-${index}`,
          type: "idle",
          outcome: "succeeded",
          time: { created: index + 1 },
        })
      }
    }
  }

  const diff = Array.from({ length: scale.diffLines }, (_, index) => `+line-${index} ${"x".repeat(index % 97)}`).join(
    "\n",
  )
  const hash = (index: number) => index.toString(16).padStart(64, "0")
  const screenshots = Array.from({ length: scale.sessions }, (_, index) => `media:${hash(index + 1)}`)

  return { sessionIDs, messages, diff, screenshots }
}

export type BenchmarkReport = {
  scale: LoadScale
  events: number
  publications: number
  rowMutations: number
  terminalPayload: string
  firstFrameLatencyMs: number
  residentTranscriptBytes: number
  residentMediaBytes: number
  retainedBytes: number
}

/**
 * Opt-in local profiler. It counts events, publications and row mutations instead
 * of asserting wall-clock thresholds, so the same fixture can run in CI without
 * becoming flaky. Interleaved agents, history loading during streaming, reconnect
 * and compaction all exercise the reconciliation paths being measured.
 */
export async function runLoadBenchmark(scale: LoadScale = defaultLoadScale): Promise<BenchmarkReport> {
  const fixture = createLoadFixture(scale)
  const sessions = fixture.sessionIDs
  const primary = sessions[0]
  if (!primary) throw new Error("Load benchmark needs at least one session")

  let events = 0
  let publications = 0
  let rowMutations = 0
  const scheduled: Array<() => void> = []
  const publishedParts = new Map<string, string>()
  const partIndex = new PartIndex()

  const apply = (entry: StreamEntry) => {
    publications++
    const key = `${entry.sessionID}:${entry.messageID}:${entry.partID}`
    publishedParts.set(key, `${publishedParts.get(key) ?? ""}${entry.text ?? ""}`)
  }
  const coalescer = new StreamCoalescer(apply, (flush) => scheduled.push(flush))

  // Materialize one row per streaming part; the remaining deltas must early-exit.
  for (let agent = 0; agent < scale.assistants; agent++) {
    const ref = { messageID: `${primary}-agent-${agent}`, partID: `text:${agent}` }
    partIndex.materialize(ref, () => rowMutations++)
  }

  const start = performance.now()
  let firstFrameLatencyMs = 0
  for (let round = 0; round < scale.deltaRounds; round++) {
    for (let agent = 0; agent < scale.assistants; agent++) {
      // Several network deltas per part per frame; coalescing must publish one each.
      for (let delta = 0; delta < 4; delta++) {
        coalescer.text(primary, `${primary}-agent-${agent}`, `x`)
        events++
      }
    }
    // Drain one publication per round, modelling a render frame rather than a network event.
    const due = scheduled.splice(0, scheduled.length)
    for (const flush of due) flush()
    if (round === 0) firstFrameLatencyMs = performance.now() - start

    // History loading continues while streaming; eviction must not drop the cursor.
    if (round % 50 === 0) {
      const page = fixture.messages.slice(round, round + 25)
      page.forEach((message) => {
        events++
        if (message.type === "assistant") {
          message.content.forEach((part, index) => {
            if (part.type !== "text") return
            const ref = { messageID: message.id, partID: `text:${index}` }
            partIndex.materialize(ref, () => rowMutations++)
          })
        }
      })
    }
    if (round === Math.floor(scale.deltaRounds / 2)) {
      // A reconnect drops buffered deltas without publishing stale content.
      coalescer.dispose()
      scheduled.length = 0
    }
  }
  // A terminal event flushes the final payload synchronously.
  coalescer.text(primary, `${primary}-agent-0`, "final")
  events++
  coalescer.flush()

  const window = new MessageWindow()
  window.set(primary, fixture.messages.slice(-100), "newest")
  for (let index = 0; index < Math.min(4, sessions.length - 1); index++) {
    const offset = index * 25
    window.prepend(primary, fixture.messages.slice(offset, offset + 25), `page-${index}`, `next-${index}`)
  }
  const resident = window.trim(primary, new Set(), false, defaultWindowBudgets)

  const media = createMediaCache(
    () => ({
      experimental: {
        media: {
          get: async ({ hash }) => {
            const index = Number.parseInt(hash, 16)
            return new Uint8Array(Number.isFinite(index) ? scale.screenshotBytes : 0)
          },
        },
      },
    }),
    { budget: scale.screenshotBytes * 2 },
  )
  for (const uri of fixture.screenshots) await media.read(uri)

  const residentTranscriptBytes = messageBytesOf(resident.messages)
  const residentMediaBytes = media.stats().bytes
  return {
    scale,
    events,
    publications,
    rowMutations,
    terminalPayload: publishedParts.get(`${primary}:${primary}-agent-0:text`) ?? "",
    firstFrameLatencyMs,
    residentTranscriptBytes,
    residentMediaBytes,
    retainedBytes: residentTranscriptBytes + residentMediaBytes,
  }
}

function messageBytesOf(messages: readonly SessionMessageInfo[]) {
  return messages.reduce((sum, message) => sum + messageBytes(message), 0)
}
