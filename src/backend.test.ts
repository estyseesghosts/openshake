import { expect, test } from "bun:test"
import { parseArgs, resolveBackend } from "./backend"

test("parses remote backend flags", () => {
  expect(parseArgs(["--server", "http://host:4096/", "--username", "u", "--password", "p", "--local"])).toEqual({
    server: "http://host:4096/",
    username: "u",
    password: "p",
    local: true,
    channel: "local",
    help: false,
    directory: undefined,
  })
})

test("rejects unknown flags and missing values", () => {
  expect(() => parseArgs(["--nope"])).toThrow()
  expect(() => parseArgs(["--server"])).toThrow()
})

test("builds a remote endpoint with basic auth", async () => {
  const backend = await resolveBackend({ server: "https://host:4096/", username: "u", password: "p" })
  expect(backend.local).toBe(false)
  expect(backend.endpoint.url).toBe("https://host:4096")
  expect(backend.endpoint.auth).toEqual({ type: "basic", username: "u", password: "p" })
})

test("rejects non-http servers", async () => {
  expect(resolveBackend({ server: "ftp://host" })).rejects.toThrow()
})
