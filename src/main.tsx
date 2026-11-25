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
  if (options.directory) process.chdir(options.directory)

  const backend = await resolveBackend(options)
  const { run } = await import("../vendor/tui/src/index")
  const layer = LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node, EffectFlock.node]))

  const prepare = (spec: string, install = true) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const npm = yield* Npm.Service
          return install ? yield* npm.add(spec) : yield* npm.resolve(spec)
        }),
        layer,
      ),
    )

  await Effect.runPromise(
    Effect.provide(
      run({
        app: { name: "openshake", version: "0.1.0", channel: options.channel },
        server: { endpoint: backend.endpoint, local: backend.local },
        args: {},
        config: createConfigService(),
        packages: { prepare },
        log: (level, message) => process.stderr.write(`[openshake] ${level}: ${message}\n`),
      }),
      layer,
    ),
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`openshake: ${message}\n`)
  process.exitCode = 1
})
