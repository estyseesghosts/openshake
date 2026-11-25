import os from "node:os"
import path from "node:path"
import { mkdir, rename } from "node:fs/promises"
import { Schema } from "effect"
import { Config } from "../vendor/tui/src/config/index"

function configPath() {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return process.env.OPEN_SHAKE_CONFIG ?? path.join(base, "openshake", "config.json")
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function decode(raw: unknown): Config.Info {
  try {
    return Schema.decodeUnknownSync(Config.Info)(raw)
  } catch (error) {
    throw new Error(`Invalid OpenShake config at ${configPath()}: ${describe(error)}`, { cause: error })
  }
}

async function load(): Promise<Config.Info> {
  const file = Bun.file(configPath())
  if (!(await file.exists())) return {}

  let raw: unknown
  try {
    raw = await file.json()
  } catch (error) {
    throw new Error(`Could not read OpenShake config at ${configPath()}: ${describe(error)}`, { cause: error })
  }
  return decode(raw)
}

async function save(value: Config.Info) {
  const target = configPath()
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await Bun.write(temporary, JSON.stringify(value, null, 2) + "\n")
  await rename(temporary, target)
}

export function createConfigService(): Config.Interface {
  return {
    path: configPath(),
    get: load,
    update: async (update) => {
      const draft: Record<string, unknown> = { ...(await load()) }
      update(draft)
      const next = decode(draft)
      await save(next)
      return next
    },
  }
}
