import { launchTiming } from "./launch-timing"
import { NodeServices } from "@effect/platform-node"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { AppProcess } from "@opencode/util/process"
import { parseArgs, printHelp, resolveBackend } from "./backend"
import { createConfigService } from "./config"

ensurePluginRuntime()

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  // Location-sensitive initialization must see the requested working directory.
  if (options.directory) process.chdir(options.directory)

  const timing = process.env.OPEN_SHAKE_TIMING === "1"
  if (timing) process.env.OPENCODE_STARTUP_TIMING = "1"

  // Backend discovery/start and vendor-plugin imports are independent: overlap them
  // so a cold launch does not pay both serially. Neither runs for --help.
  const [, backend] = await Promise.all([
    (async () => {
      const [latex, merman] = await Promise.all([
        import("../vendor/latex/src/plugin"),
        import("../vendor/merman/src/plugin"),
      ])
      Bun.plugin({
        name: "openshake-vendor-bindings",
        setup(build) {
          build.module("@opencode/latex/plugin", () => ({ loader: "object", exports: { default: latex.default } }))
          build.module("@opencode/merman/plugin", () => ({ loader: "object", exports: { default: merman.default } }))
        },
      })
      launchTiming.mark("plugins")
    })(),
    resolveBackend(options).then((resolved) => {
      launchTiming.mark("backend")
      return resolved
    }),
  ])

  const { run } = await import("../vendor/tui/src/index")
  launchTiming.mark("tui-import")
  const layer = LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node, EffectFlock.node]))

  const prepare = (spec: string, install = true) =>
    Effect.runPromise(
      Effect.provide(
        Effect.provide(
          Effect.gen(function* () {
            const npm = yield* Npm.Service
            return install ? yield* npm.add(spec) : yield* npm.resolve(spec)
          }),
          layer,
        ),
        NodeServices.layer,
      ),
    )

  // The TUI owns the terminal. Writing log lines during a frame paints over the
  // renderer, so buffer them and emit after shutdown; routine debug/info output is
  // opt-in. Warnings and errors are always preserved. Startup timing is captured
  // through the same sink and merged with the host stopwatch after shutdown.
  const pendingLogs: string[] = []
  const verbose = process.env.OPEN_SHAKE_DEBUG === "1"
  let tuiTiming: Record<string, number> | undefined
  const record = (level: string, message: string, fields?: Record<string, unknown>) => {
    if (message === "startup timing" && fields) {
      tuiTiming = fields as Record<string, number>
      return
    }
    if ((level === "debug" || level === "info") && !verbose) return
    pendingLogs.push(`[shake] ${level}: ${message}`)
  }

  const tui = run({
    app: { name: "openshake", version: "0.1.0", channel: options.channel },
    server: { endpoint: backend.endpoint, local: backend.local },
    args: {},
    config: createConfigService(),
    packages: { prepare },
    log: record,
    displayCommand: process.env.OPEN_SHAKE_COMMAND ?? "shake",
  })

  try {
    await Effect.runPromise(Effect.provide(Effect.provide(tui, layer), NodeServices.layer))
  } finally {
    if (timing) {
      const host = launchTiming.snapshot().elapsed
      const offset = host["tui-import"] ?? 0
      const merged: Record<string, number> = { ...host }
      for (const [name, ms] of Object.entries(tuiTiming ?? {})) merged[name] = offset + ms
      const line = Object.entries(merged)
        .toSorted(([, left], [, right]) => left - right)
        .map(([name, ms]) => `${name}=${ms.toFixed(1)}`)
        .join("  ")
      process.stderr.write(`[shake] startup(ms): ${line}\n`)
    }
    if (pendingLogs.length) process.stderr.write(`${pendingLogs.join("\n")}\n`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`shake: ${message}\n`)
  process.exitCode = 1
})
