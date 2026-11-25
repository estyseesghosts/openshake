import type { Endpoint } from "@opencode/client/effect/service"
import { Service } from "@opencode/client/service"

/** All @opencode/* packages and the server must move in lockstep with the vendored TUI. */
export const UPSTREAM_VERSION = "2.4.1"

export type Backend = {
  readonly endpoint: Endpoint
  readonly local: boolean
}

export type BackendOptions = {
  readonly server?: string
  readonly username?: string
  readonly password?: string
  readonly local?: boolean
}

export type CliOptions = BackendOptions & {
  readonly channel: string
  readonly help: boolean
  readonly directory?: string
}

const usage = `shake - vendored OpenCode TUI

Usage:
  shake [options] [directory]

Options:
  --server <url>      Connect to a remote OpenCode server (or OPEN_SHAKE_SERVER)
  --username <name>   Basic-auth username for --server (default: opencode)
  --password <pass>   Basic-auth password for --server (or OPEN_SHAKE_PASSWORD)
  --local             Ignore server env vars and use the local background service
  --channel <name>    Client state channel (default: local)
  --help              Show this help
`

export function parseArgs(argv: readonly string[]): CliOptions {
  let server: string | undefined
  let username: string | undefined
  let password: string | undefined
  let local = false
  let channel = process.env.OPEN_SHAKE_CHANNEL ?? "local"
  let help = false
  let directory: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === "--help" || flag === "-h") {
      help = true
      continue
    }
    if (flag === "--local") {
      local = true
      continue
    }
    if (flag === undefined) continue
    if (!flag.startsWith("--")) {
      directory = flag
      continue
    }
    const value = argv[++index]
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    if (flag === "--server") server = value
    else if (flag === "--username") username = value
    else if (flag === "--password") password = value
    else if (flag === "--channel") channel = value
    else throw new Error(`Unknown option: ${flag}`)
  }

  return { server, username, password, local, channel, help, directory }
}

export function printHelp() {
  process.stdout.write(usage)
}

/**
 * Remote mode is explicit (flag or env var); everything else reuses the local
 * background service, which is discovered or started by @opencode/client.
 */
export async function resolveBackend(options: BackendOptions): Promise<Backend> {
  const server = options.local ? undefined : (options.server ?? process.env.OPEN_SHAKE_SERVER)
  if (server) return { endpoint: remoteEndpoint(server, options), local: false }

  return { endpoint: await Service.ensure({ version: UPSTREAM_VERSION }), local: true }
}

function remoteEndpoint(server: string, options: BackendOptions): Endpoint {
  let parsed: URL
  try {
    parsed = new URL(server)
  } catch {
    throw new Error(`Invalid --server URL: ${server}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--server must use http or https, got: ${parsed.protocol}`)
  }
  const url = parsed.toString().replace(/\/+$/, "")
  const password = options.password ?? process.env.OPEN_SHAKE_PASSWORD ?? process.env.OPENCODE_PASSWORD
  if (password === undefined || password === "") return { url }

  return {
    url,
    auth: {
      type: "basic",
      username: options.username ?? process.env.OPEN_SHAKE_USERNAME ?? "opencode",
      password,
    },
  }
}
