import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client"
import { OpenCode } from "@opencode/client"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot } from "solid-js"
import { createSessionRetention } from "@opencode/client/solid"
import { createData } from "../context/client-data"
import { createMediaCache } from "./media"
import { reduceSessionRows } from "../routes/session/rows"
import type { LoadFixture } from "./load-benchmark"

type OpenCodeEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export type RealPathCounters = {
  /** Messages materialized by real createData event/sync handling. */
  messages: number
  /** Rows produced by the real row projection. */
  rows: number
  /** Sessions evicted and reloaded while hidden. */
  evicted: number
  reloaded: number
  /** Transcripts resident after retention settles. */
  resident: number
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
}

function sessionInfo(sessionID: string): SessionInfo {
  return {
    id: sessionID,
    title: sessionID,
    projectID: "bench-project",
    location: { directory: "/bench" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  } as SessionInfo
}

/** A fetch stub serving the fixture's per-session messages through the real RPC client. */
function createBenchFetch(fixture: LoadFixture) {
  const info = sessionInfo
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const message = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (message) {
      const sessionID = decodeURIComponent(message[1] ?? "")
      const messages = fixture.messages.get(sessionID) ?? []
      const end = Number(url.searchParams.get("cursor") ?? messages.length)
      const limit = Number(url.searchParams.get("limit") ?? 20)
      const start = Math.max(0, end - limit)
      return json({
        data: messages.slice(start, end).toReversed(),
        cursor: start > 0 ? { next: String(start) } : {},
      })
    }
    if (url.pathname === "/api/session") return json({ data: fixture.sessionIDs.map(info), cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (/^\/api\/session\/[^/]+$/.test(url.pathname))
      return json({ data: info(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")) })
    if (/^\/api\/session\/[^/]+\/(inbox|permission|form)$/.test(url.pathname))
      return json({ data: [], location: { directory: "/bench" }, cursor: {} })
    if (url.pathname === "/api/experimental/media") return json({ data: new Uint8Array(0) })
    // Any remaining session read (e.g. a single-message revalidation) must still
    // answer with a real SessionInfo so event-driven refreshes cannot see undefined.
    if (url.pathname.startsWith("/api/session")) {
      const id = url.pathname.split("/")[3] ?? fixture.sessionIDs[0] ?? ""
      return json({ data: sessionInfo(decodeURIComponent(id)) })
    }
    return json({ data: [], cursor: {} })
  }
  fetch.preconnect = () => {}
  return fetch
}

/**
 * Drive the benchmark through the production data layer: a real OpenCode client
 * over a fixture fetch, real event emitter, createData, retention and the real
 * row projection. All counters are deterministic; no wall-clock assertions.
 */
export async function exerciseRealDataPath(
  fixture: LoadFixture,
  screenshotBytes: number,
): Promise<RealPathCounters> {
  const api: OpenCodeClient = OpenCode.make({ baseUrl: "http://bench.local", fetch: createBenchFetch(fixture) })
  const events = createGlobalEmitter<OpenCodeEventMap>()
  const media = createMediaCache(() => ({
    experimental: {
      media: {
        get: async () => new Uint8Array(screenshotBytes),
      },
    },
  }))

  let disposeRoot: (() => void) | undefined
  const scenario = async (): Promise<RealPathCounters> => {
    {
      const data = createData({
        api: () => api,
        directory: "/bench",
        event: { on: events.on, listen: events.listen },
        connection: { status: () => "connected" },
        media,
        initialMessageLimit: () => 20,
      })

      // Register sessions so retention sees the open tabs, then emit a small
      // interleaved burst per session and let createData's own coalescer and
      // window reconciliation publish through the Solid store.
      for (const sessionID of fixture.sessionIDs) data.session.remember(sessionInfo(sessionID))
      for (const sessionID of fixture.sessionIDs) {
        const messageID = `${sessionID}-message-0`
        const base = {
          id: messageID,
          created: 1,
          sessionID,
          assistantMessageID: messageID,
          ordinal: 0,
        }
        emit(events, "session.step.started", {
          ...base,
          agent: "bench",
          model: { providerID: "fixture", id: "fixture" },
          started: 1,
        })
        emit(events, "session.text.started", base)
        for (let index = 0; index < 4; index++)
          emit(events, "session.text.delta", { ...base, delta: `real ${index} ` })
        emit(events, "session.text.ended", { ...base, text: "real 0 real 1 real 2 real 3 " })
        emit(events, "session.step.ended", {
          ...base,
          finish: "stop",
          rawFinish: "stop",
          cost: 0,
          tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        emit(events, "session.execution.succeeded", { sessionID, reason: "stop" })
      }

      let messages = 0
      let rows = 0
      for (const sessionID of fixture.sessionIDs) {
        messages += data.session.message.list(sessionID).length
        // The production row projection consumes the store that createData owns.
        rows += reduceSessionRows(
          [...data.session.message.list(sessionID)],
          new Set(data.session.input.list(sessionID)),
          false,
          "medium",
          data.session.idle.has(sessionID),
        ).length
      }

      let current = fixture.sessionIDs[0]
      let evicted = 0
      let reloaded = 0
      createSessionRetention({
        session: data.session,
        current: () => current,
        keep: () => (current ? [current] : []),
        limit: 0,
      })
      // Simulate hidden tabs: walk away from the visible session (its transcript
      // becomes evictable), then return and re-read it through createData.
      for (const sessionID of fixture.sessionIDs.slice(1)) {
        current = sessionID
        // Solid queues effects on a microtask; yield so retention actually runs.
        await Promise.resolve()
        if (data.session.message.list(fixture.sessionIDs[0] ?? "").length === 0) evicted++
      }
      current = fixture.sessionIDs[0]
      await Promise.resolve()
      // Returning to a hidden tab re-reads its tail through createData, exactly
      // as the real route does when it becomes visible again.
      if (data.session.message.list(current ?? "").length === 0) {
        await data.session.message.sync(current ?? "")
        reloaded++
      }

      return {
        messages,
        rows,
        evicted,
        reloaded,
        resident: fixture.sessionIDs.filter((sessionID) => data.session.message.list(sessionID).length > 0).length,
      }
    }
  }
  const result = await createRoot((dispose) => {
    disposeRoot = dispose
    return scenario()
  })
  disposeRoot?.()
  events.clear()
  return result
}

// Event ids and session/message ids are branded at the type level but plain strings
// at runtime; the fixture constructs them from its own deterministic keys.
function emit(
  events: ReturnType<typeof createGlobalEmitter<OpenCodeEventMap>>,
  type: OpenCodeEvent["type"],
  data: Record<string, unknown>,
) {
  const event = { id: `evt_${type}`, created: 1, type, data } as OpenCodeEvent
  events.emit(event.type, event as never)
}
