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

/**
 * Bytes for `media:<hash>` refs, read from the server the first time something shows or restores them. A hash names
 * its bytes, so entries stay valid across reconnects and eviction is transparent.
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
  const bytes = new Map<string, Uint8Array>()
  const inflight = new Map<string, Promise<Uint8Array>>()
  let resident = 0

  function touch(hash: string, value: Uint8Array) {
    bytes.delete(hash)
    bytes.set(hash, value)
  }

  function evict() {
    while (resident > budget) {
      const oldest = bytes.keys().next()
      if (oldest.done) break
      const value = bytes.get(oldest.value)
      bytes.delete(oldest.value)
      if (value) resident -= value.byteLength
    }
  }

  function cache(hash: string, value: Uint8Array) {
    if (value.byteLength > maxEntryBytes) return
    const previous = bytes.get(hash)
    touch(hash, value)
    resident += value.byteLength - (previous?.byteLength ?? 0)
    evict()
  }

  function hit(hash: string) {
    const value = bytes.get(hash)
    if (value) touch(hash, value)
    return value
  }

  return {
    peek: (uri: string) => {
      const hash = mediaHashFromUri(uri)
      return hash ? hit(hash) : undefined
    },
    read: (uri: string) => {
      const hash = mediaHashFromUri(uri)
      if (!hash) return Promise.reject(new Error(`Not a media ref: ${uri}`))
      const cached = hit(hash)
      if (cached) return Promise.resolve(cached)
      const pending =
        inflight.get(hash) ??
        api()
          .experimental.media.get({ hash })
          .then((result) => {
            cache(hash, result)
            return result
          })
          .finally(() => inflight.delete(hash))
      inflight.set(hash, pending)
      return pending
    },
    /** Counters for the opt-in load benchmark; never used on a render path. */
    stats: () => ({ entries: bytes.size, bytes: resident, inflight: inflight.size }),
  }
}

/** The server answered that the blob is gone (404), as opposed to a failure where it may still exist. */
export function isMissingMedia(error: unknown) {
  return error instanceof Error && error.name === "FileNotFoundError"
}
