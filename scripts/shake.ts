#!/usr/bin/env bun
// Global `shake` executable. Bun applies the renderer's Solid transform only when
// `@opentui/solid/preload` is passed as a flag; importing it from this module is
// too late for sibling static imports. Re-exec once with that flag so the linked
// shim works from any directory, where this project's bunfig.toml is not loaded.
if (!process.env.OPEN_SHAKE_PRELOADED) {
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync(
    process.execPath,
    ["--preload", "@opentui/solid/preload", import.meta.path, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env, OPEN_SHAKE_PRELOADED: "1" },
    },
  )
  process.exit(result.status ?? 1)
}

await import("../src/main")
