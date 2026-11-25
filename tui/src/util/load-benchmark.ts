import type { SessionMessageInfo } from "@opencode/client"
import { CliRenderEvents } from "@opentui/core"
import { MessageWindow, defaultWindowBudgets, messageBytes } from "../context/message-window"
import { StreamCoalescer, type StreamEntry } from "../context/stream-coalescer"
import { PartIndex } from "../routes/session/rows-index"
import { createMediaCache } from "./media"
import { splitLargePatch } from "./diff"
import { highlightBudgetExceeded } from "./diff-highlight"
import { exerciseRealDataPath, type RealPathCounters } from "./load-data-path"
import { renderGiantDiff, type DiffRenderStats } from "./load-diff-render"

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
  /** Messages are keyed per session; no flat cross-session pool. */
  messages: ReadonlyMap<string, readonly SessionMessageInfo[]>
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
  const messages = new Map<string, SessionMessageInfo[]>()

  for (const sessionID of sessionIDs) {
    const sessionMessages: SessionMessageInfo[] = []
    for (let index = 0; index < scale.messagesPerSession; index++) {
      const agent = index % Math.max(1, scale.assistants)
      const tool = toolNames[Math.floor(random() * toolNames.length)] ?? "read"
      sessionMessages.push({
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
        sessionMessages.push({
          id: `${sessionID}-idle-${index}`,
          type: "idle",
          outcome: "succeeded",
          time: { created: index + 1 },
        })
      }
    }
    messages.set(sessionID, sessionMessages)
  }

  const diff = Array.from({ length: scale.diffLines }, (_, index) => `+line-${index} ${"x".repeat(index % 97)}`).join(
    "\n",
  )
  const hash = (index: number) => index.toString(16).padStart(64, "0")
  const screenshots = Array.from({ length: scale.sessions }, (_, index) => `media:${hash(index + 1)}`)

  return { sessionIDs, messages, diff, screenshots }
}

export type BenchmarkOptions = {
  /**
   * Opt in to a real renderer and measure actual FRAME-event latency. Off by default:
   * ordinary CI runs only the deterministic counters and never depends on timing.
   */
  realFrames?: boolean
  width?: number
  height?: number
}

export type FrameTimings = {
  frames: number
  meanMs: number
  p95Ms: number
  maxMs: number
  /** Time from benchmark start to the first real frame. */
  firstFrameMs: number
}

export type BenchmarkReport = {
  scale: LoadScale
  events: number
  publications: number
  rowMutations: number
  compactions: number
  terminalPayload: string
  firstFrameLatencyMs: number
  residentTranscriptBytes: number
  residentMediaBytes: number
  liveBlobBytes: number
  retainedBytes: number
  /** Peak across the run, per session and globally. */
  peakResidentBytes: number
  residentBytesBySession: ReadonlyMap<string, number>
  /** Chunk count of the giant modified-file diff that was actually partitioned. */
  diffChunks: number
  /** Real createData event handling, retention and row projection counters. */
  realPath: RealPathCounters
  /** The giant diff was mounted and rendered through PatchDiff, not just partitioned. */
  diffRender: DiffRenderStats
  /** Present only with `realFrames: true`; wall-clock data is never asserted in CI. */
  frameTimings?: FrameTimings
}

/**
 * Opt-in local profiler. Several long sessions stream at once through the same
 * coalescer, window and row-index paths the TUI uses; history loads and compaction
 * overlap the stream. It counts events, publications and row mutations instead of
 * asserting wall-clock thresholds, so the same fixture can run in CI without
 * becoming flaky.
 */
export async function runLoadBenchmark(
  scale: LoadScale = defaultLoadScale,
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const fixture = createLoadFixture(scale)
  const sessions = fixture.sessionIDs
  const primary = sessions[0]
  if (!primary) throw new Error("Load benchmark needs at least one session")

  let events = 0
  let publications = 0
  let rowMutations = 0
  let compactions = 0
  let firstFrameLatencyMs = 0
  const scheduled: Array<() => void> = []

  // Real frames are opt-in and load the test renderer lazily, so ordinary CI never
  // pays for a terminal or depends on wall-clock timing.
  let rendererSetup: Awaited<ReturnType<typeof import("@opentui/core/testing")["createTestRenderer"]>> | undefined
  const frameDurations: number[] = []
  let firstFrameAt: number | undefined
  const benchmarkStart = performance.now()
  if (options.realFrames) {
    const { createTestRenderer } = await import("@opentui/core/testing")
    rendererSetup = await createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30 })
    rendererSetup.renderer.start()
    let lastFrameAt = 0
    rendererSetup.renderer.on(CliRenderEvents.FRAME, () => {
      const now = performance.now()
      if (lastFrameAt > 0) frameDurations.push(now - lastFrameAt)
      else firstFrameAt = now - benchmarkStart
      lastFrameAt = now
    })
  }
  const publishedParts = new Map<string, string>()
  const partIndex = new PartIndex()
  const windows = new Map<string, MessageWindow>()

  const apply = (entry: StreamEntry) => {
    publications++
    const key = `${entry.sessionID}:${entry.messageID}:${entry.partID}`
    publishedParts.set(key, `${publishedParts.get(key) ?? ""}${entry.text ?? ""}`)
  }
  const coalescer = new StreamCoalescer(apply, (flush) => scheduled.push(flush))

  for (const sessionID of sessions) {
    // Materialize one row per streaming part; the remaining deltas must early-exit.
    for (let agent = 0; agent < scale.assistants; agent++) {
      const ref = { messageID: `${sessionID}-agent-${agent}`, partID: `text:${agent}` }
      partIndex.materialize(ref, () => rowMutations++)
    }
    const window = new MessageWindow()
    window.set(sessionID, (fixture.messages.get(sessionID) ?? []).slice(-100), "newest")
    windows.set(sessionID, window)
  }

  const residentBytesBySession = new Map<string, number>()
  let peakResidentBytes = 0
  const trackResident = () => {
    let total = 0
    for (const [sessionID, window] of windows) {
      const bytes = window.residentBytes(sessionID)
      residentBytesBySession.set(sessionID, bytes)
      total += bytes
    }
    peakResidentBytes = Math.max(peakResidentBytes, total)
  }
  trackResident()

  const start = performance.now()
  for (let round = 0; round < scale.deltaRounds; round++) {
    for (let agent = 0; agent < scale.assistants; agent++) {
      // Spread agents over several sessions so live traffic is genuinely concurrent.
      const sessionID = sessions[agent % sessions.length] ?? primary
      for (let delta = 0; delta < 4; delta++) {
        coalescer.text(sessionID, `${sessionID}-agent-${agent}`, "x")
        events++
      }
    }
    // Drain one publication per round. In real-frame mode the renderer then paints
    // an actual frame, so the FRAME listener measures genuine paint latency.
    const due = scheduled.splice(0, scheduled.length)
    for (const flush of due) flush()
    if (rendererSetup) await rendererSetup.renderOnce()
    else if (round === 0) firstFrameLatencyMs = performance.now() - start
    trackResident()

    // History loading continues while streaming; eviction must not drop the cursor.
    if (round % 50 === 0) {
      const sessionID = sessions[Math.floor(round / 50) % sessions.length] ?? primary
      const page = (fixture.messages.get(sessionID) ?? []).slice(round, round + 25)
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
      windows.get(sessionID)?.prepend(sessionID, page, `page-${round}`, `next-${round}`)
    }
    if (round === Math.floor(scale.deltaRounds * 0.5)) {
      // A reconnect drops buffered deltas without publishing stale content.
      coalescer.dispose()
      scheduled.length = 0
    }
    if (round === Math.floor(scale.deltaRounds * 0.75)) {
      // Compaction replaces the resident tail and rebuilds derived indexes while
      // streaming continues, exercising the reconciliation path.
      windows.get(primary)?.set(primary, (fixture.messages.get(primary) ?? []).slice(-10), "post-compaction")
      partIndex.rebuild([])
      compactions++
      events++
    }
  }
  // A terminal event flushes the final payload synchronously.
  coalescer.text(primary, `${primary}-agent-0`, "final")
  events++
  coalescer.flush()

  for (let index = 0; index < Math.min(4, sessions.length - 1); index++) {
    const offset = index * 25
    windows.get(primary)?.prepend(primary, (fixture.messages.get(primary) ?? []).slice(offset, offset + 25), `page-${index}`, `next-${index}`)
  }
  const resident = windows.get(primary)?.trim(primary, new Set(), false, defaultWindowBudgets)
  trackResident()

  // Exercise the real large-modified-file path on the generated giant diff. Build
  // a mixed context/delete/add patch so the modified-file strategy is measured,
  // not only the new-file case.
  let oldCount = 0
  let newCount = 0
  const body = fixture.diff.split("\n").map((line, index) => {
    if (index % 3 === 0) {
      oldCount++
      newCount++
      return ` context ${index}`
    }
    if (index % 3 === 1) {
      oldCount++
      return `-old ${index}`
    }
    newCount++
    return line
  })
  const patch = `--- a/giant.ts\n+++ b/giant.ts\n@@ -1,${oldCount} +1,${newCount} @@\n${body.join("\n")}\n`
  const chunks = splitLargePatch(patch, 128) ?? []
  const overBudget = highlightBudgetExceeded(chunks.map((chunk) => chunk.patch), scale.diffLines)

  // Drive the production data path and actually mount the diff through PatchDiff.
  // These are deterministic counters; the diff renderer has its own renderer and is
  // disposed here, so CI never depends on terminal timing.
  const realPath = await exerciseRealDataPath(fixture, scale.screenshotBytes)
  const diffRender = await renderGiantDiff(patch, undefined)

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

  const residentTranscriptBytes = resident ? messageBytesOf(resident.messages) : 0
  const mediaStats = media.stats()
  const residentMediaBytes = mediaStats.bytes

  let frameTimings: FrameTimings | undefined
  if (rendererSetup) {
    await rendererSetup.dispose()
    const sorted = frameDurations.toSorted((left, right) => left - right)
    const total = sorted.reduce((sum, duration) => sum + duration, 0)
    frameTimings = {
      frames: sorted.length + (firstFrameAt === undefined ? 0 : 1),
      meanMs: sorted.length === 0 ? 0 : total / sorted.length,
      p95Ms: sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0),
      maxMs: sorted.at(-1) ?? 0,
      firstFrameMs: firstFrameAt ?? 0,
    }
    firstFrameLatencyMs = frameTimings.firstFrameMs
  }

  return {
    scale,
    events,
    publications,
    rowMutations,
    compactions,
    terminalPayload: publishedParts.get(`${primary}:${primary}-agent-0:text`) ?? "",
    firstFrameLatencyMs,
    residentTranscriptBytes,
    residentMediaBytes,
    liveBlobBytes: mediaStats.localBytes,
    retainedBytes: residentTranscriptBytes + residentMediaBytes,
    peakResidentBytes,
    residentBytesBySession,
    diffChunks: overBudget ? 0 : chunks.length,
    realPath,
    diffRender,
    ...(frameTimings ? { frameTimings } : {}),
  }
}

function messageBytesOf(messages: readonly SessionMessageInfo[]) {
  return messages.reduce((sum, message) => sum + messageBytes(message), 0)
}
