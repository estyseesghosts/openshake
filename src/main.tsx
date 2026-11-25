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

// Bun does not apply this project's tsconfig paths inside a nested package
// boundary, so bind the two private upstream packages explicitly.
const [latex, merman] = await Promise.all([import("../vendor/latex/src/plugin"), import("../vendor/merman/src/plugin")])
Bun.plugin({
  name: "openshake-vendor-bindings",
  setup(build) {
    build.module("@opencode/latex/plugin", () => ({ loader: "object", exports: { default: latex.default } }))
    build.module("@opencode/merman/plugin", () => ({ loader: "object", exports: { default: merman.default } }))
  },
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (options.directory) process.chdir(options.directory)

  const backend = await resolveBackend(options)
  const { run } = await import("../vendor/tui/src/index")
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

  const tui = run({
    app: { name: "openshake", version: "0.1.0", channel: options.channel },
    server: { endpoint: backend.endpoint, local: backend.local },
    args: {},
    config: createConfigService(),
    packages: { prepare },
    log: (level, message) => process.stderr.write(`[shake] ${level}: ${message}\n`),
  })

  await Effect.runPromise(Effect.provide(Effect.provide(tui, layer), NodeServices.layer))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`shake: ${message}\n`)
  process.exitCode = 1
})
