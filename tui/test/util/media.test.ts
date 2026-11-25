import { describe, expect, test } from "bun:test"
import { createMediaCache } from "../../src/util/media"

const hash = "d".repeat(64)

function setup(get: (input: { hash: string }) => Promise<Uint8Array>) {
  const calls: string[] = []
  const cache = createMediaCache(() => ({
    experimental: {
      media: {
        get: (input: { hash: string }) => {
          calls.push(input.hash)
          return get(input)
        },
      },
    },
  }))
  return { cache, calls }
}

describe("media cache", () => {
  test("reads each hash once, sharing a request in flight", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const { cache, calls } = setup(async () => bytes)

    expect(cache.peek(`media:${hash}`)).toBeUndefined()
    const [first, second] = await Promise.all([cache.read(`media:${hash}`), cache.read(`media:${hash}`)])

    expect(first).toBe(bytes)
    expect(second).toBe(bytes)
    expect(await cache.read(`media:${hash}`)).toBe(bytes)
    expect(cache.peek(`media:${hash}`)).toBe(bytes)
    expect(calls).toEqual([hash])
  })

  test("retries a hash whose read failed", async () => {
    const results = [Promise.reject(new Error("offline")), Promise.resolve(new Uint8Array([4]))]
    const { cache, calls } = setup(() => results.shift()!)

    await expect(cache.read(`media:${hash}`)).rejects.toThrow("offline")
    expect(cache.peek(`media:${hash}`)).toBeUndefined()
    expect(await cache.read(`media:${hash}`)).toEqual(new Uint8Array([4]))
    expect(calls).toEqual([hash, hash])
  })

  test("never requests anything for a URI that is not a media ref", async () => {
    const { cache, calls } = setup(async () => new Uint8Array())

    expect(cache.peek("data:image/png;base64,AAA")).toBeUndefined()
    await expect(cache.read("data:image/png;base64,AAA")).rejects.toThrow("Not a media ref")
    await expect(cache.read(`media:${hash.toUpperCase()}`)).rejects.toThrow("Not a media ref")
    expect(calls).toEqual([])
  })

  test("evicts least-recently-used entries until the byte budget is respected", async () => {
    const a = "a".repeat(64)
    const b = "b".repeat(64)
    const sizes: Record<string, number> = { [a]: 6, [b]: 5 }
    const cache = createMediaCache(
      () => ({
        experimental: {
          media: { get: async ({ hash }) => new Uint8Array(sizes[hash]!) },
        },
      }),
      { budget: 10 },
    )
    await cache.read(`media:${a}`)
    await cache.read(`media:${b}`)
    expect(cache.stats().bytes).toBe(5)
    expect(cache.peek(`media:${a}`)).toBeUndefined()
    expect(cache.peek(`media:${b}`)).toBeDefined()
  })

  test("peek and read refresh recency so a hot entry survives a later eviction", async () => {
    const a = "a".repeat(64)
    const b = "b".repeat(64)
    const c = "c".repeat(64)
    const sizes: Record<string, number> = { [a]: 6, [b]: 4, [c]: 5 }
    let calls = 0
    const cache = createMediaCache(
      () => ({
        experimental: {
          media: {
            get: async ({ hash }) => {
              calls++
              return new Uint8Array(sizes[hash]!)
            },
          },
        },
      }),
      { budget: 11 },
    )
    await cache.read(`media:${a}`)
    await cache.read(`media:${b}`)
    expect(cache.peek(`media:${a}`)).toBeDefined()
    await cache.read(`media:${c}`)
    expect(cache.peek(`media:${a}`)).toBeDefined()
    expect(cache.peek(`media:${b}`)).toBeUndefined()
    expect(cache.stats()).toEqual({ entries: 2, bytes: 11, inflight: 0 })
    expect(calls).toBe(3)
  })

  test("oversized entries stream through without becoming resident", async () => {
    let calls = 0
    const cache = createMediaCache(
      () => ({
        experimental: { media: { get: async () => (calls++, new Uint8Array(10)) } },
      }),
      { maxEntryBytes: 4 },
    )
    expect((await cache.read(`media:${hash}`)).byteLength).toBe(10)
    expect(cache.stats().bytes).toBe(0)
    await cache.read(`media:${hash}`)
    expect(calls).toBe(2)
  })

  test("in-flight deduplication is independent of cached bytes and never evicts a pending request", async () => {
    let resolve!: (value: Uint8Array) => void
    let calls = 0
    const cache = createMediaCache(
      () => ({
        experimental: {
          media: {
            get: () => {
              calls++
              return new Promise<Uint8Array>((done) => (resolve = done))
            },
          },
        },
      }),
      { budget: 1 },
    )
    const first = cache.read(`media:${hash}`)
    const second = cache.read(`media:${hash}`)
    expect(cache.stats().inflight).toBe(1)
    expect(calls).toBe(1)
    resolve(new Uint8Array(2))
    expect(await Promise.all([first, second])).toHaveLength(2)
    expect(cache.stats().bytes).toBe(0)
    expect(cache.peek(`media:${hash}`)).toBeUndefined()
  })
})
