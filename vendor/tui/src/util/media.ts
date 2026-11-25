import { mediaHashFromUri, type OpenCodeClient } from "@opencode/client"

export type MediaCache = ReturnType<typeof createMediaCache>

export type MediaCacheOptions = {
  /** Conservative default: decoded media is cheap to refetch but expensive to keep. */
  budget?: number
  /** Entries larger than this are streamed without becoming resident. */
  maxEntryBytes?: number
}

const defaultBudget = 64 * 1024 * 1024
const defaultMaxEntryBytes = 8 * 1024 * 1024

/** Local blobs from live events use a distinct scheme so they never hit the server. */
const liveRef = /^live:([0-9a-f]{1,32})$/

export function liveHashFromUri(uri: string | undefined) {
  if (!uri) return undefined
  return liveRef.exec(uri)?.[1]
}

/** Stable, synchronous hash of an inline URI. Two equal payloads share one cache entry. */
function localHash(uri: string) {
  let first = 0x811c9dc5
  let second = 0x01000193
  for (let index = 0; index < uri.length; index++) {
    const code = uri.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0
  }
  return `${first.toString(16)}${second.toString(16)}`
}

type Stored = { value: Uint8Array; local: boolean }

/**
 * Bytes for `media:<hash>` refs, read from the server the first time something shows or restores them. A hash names
 * its bytes, so entries stay valid across reconnects and eviction is transparent.
 *
 * Live tool events may also carry inline `data:` images. `register()` decodes those into a `live:<hash>` ref and
 * keeps the bytes here, in the same bounded LRU, so the transcript never retains a base64 payload. Local blobs are
 * counted separately from server blobs for resident-byte instrumentation.
 *
 * The byte map is insertion-ordered as an LRU: hits refresh recency by reinserting.
 * In-flight request deduplication is tracked separately so an eviction can never
 * cause a duplicate download for a request that is already on the wire.
 */
export function createMediaCache(
  api: () => { experimental: { media: Pick<OpenCodeClient["experimental"]["media"], "get"> } },
  options: MediaCacheOptions = {},
) {
  const budget = options.budget ?? defaultBudget
  const maxEntryBytes = options.maxEntryBytes ?? defaultMaxEntryBytes
  const bytes = new Map<string, Stored>()
  const inflight = new Map<string, Promise<Uint8Array>>()
  let resident = 0
  let localResident = 0

  function touch(hash: string, value: Stored) {
    bytes.delete(hash)
    bytes.set(hash, value)
  }

  function evict() {
    while (resident > budget) {
      const oldest = bytes.keys().next()
      if (oldest.done) break
      const value = bytes.get(oldest.value)
      bytes.delete(oldest.value)
      if (value) {
        resident -= value.value.byteLength
        if (value.local) localResident -= value.value.byteLength
      }
    }
  }

  function store(hash: string, value: Uint8Array, local: boolean) {
    if (value.byteLength > maxEntryBytes) return
    const previous = bytes.get(hash)
    touch(hash, { value, local })
    resident += value.byteLength - (previous?.value.byteLength ?? 0)
    localResident += (local ? value.byteLength : 0) - (previous?.local ? previous.value.byteLength : 0)
    evict()
  }

  function hit(hash: string) {
    const value = bytes.get(hash)
    if (value) touch(hash, value)
    return value?.value
  }

  return {
    peek: (uri: string) => {
      const hash = mediaHashFromUri(uri) ?? liveHashFromUri(uri)
      return hash ? hit(hash) : undefined
    },
    read: (uri: string) => {
      const hash = mediaHashFromUri(uri)
      if (hash) {
        const cached = hit(hash)
        if (cached) return Promise.resolve(cached)
        const pending =
          inflight.get(hash) ??
          api()
            .experimental.media.get({ hash })
            .then((result) => {
              store(hash, result, false)
              return result
            })
            .finally(() => inflight.delete(hash))
        inflight.set(hash, pending)
        return pending
      }
      const local = liveHashFromUri(uri)
      const cached = local ? hit(local) : undefined
      if (cached) return Promise.resolve(cached)
      // A local-only blob that was evicted cannot be refetched from the server.
      return Promise.reject(new Error("Live media blob is no longer resident"))
    },
    /**
     * Decode an inline `data:` URI into a bounded local blob and return its ref.
     * Re-registering an equal payload reuses the same hash without duplicating bytes.
     */
    register: (uri: string, value: Uint8Array) => {
      const hash = localHash(uri)
      if (!bytes.get(hash)) store(hash, value, true)
      return `live:${hash}`
    },
    /** Counters for the opt-in load benchmark and resident-byte instrumentation; never on a render path. */
    stats: () => {
      let localEntries = 0
      let remoteEntries = 0
      for (const entry of bytes.values()) {
        if (entry.local) localEntries++
        else remoteEntries++
      }
      return {
        entries: bytes.size,
        bytes: resident,
        inflight: inflight.size,
        localBytes: localResident,
        remoteBytes: resident - localResident,
        localEntries,
        remoteEntries,
      }
    },
  }
}

/** The server answered that the blob is gone (404), as opposed to a failure where it may still exist. */
export function isMissingMedia(error: unknown) {
  return error instanceof Error && error.name === "FileNotFoundError"
}
