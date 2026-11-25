import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { paintBootShell } from "../src/component/boot-shell"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("boot shell paints a location-independent frame and is removable", async () => {
  await using setup = await createTestRenderer({ width: 80, height: 24 })
  setup.renderer.start()
  const dispose = paintBootShell(setup.renderer)

  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Starting Shake")
  expect(frame).toContain("█")

  dispose()
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain("Starting Shake")
})

test("the boot shell is visible before the location RPC resolves", async () => {
  const release = Promise.withResolvers<void>()
  await using app = await createAppFixture({
    width: 80,
    height: 24,
    fetch: (url) => {
      if (["/api/file", "/api/fs/list", "/api/location"].includes(url.pathname))
        return (async () => {
          await release.promise
          return json({ location: { directory, project: { id: "proj_test", directory, canonical: directory } } })
        })()
      return undefined
    },
  })
  try {
    // Location is still blocked; the shell must already have painted.
    await app.waitForFrame((frame) => frame.includes("Starting Shake"), { maxPasses: 30 })
    expect(app.captureCharFrame()).toContain("Starting Shake")
  } finally {
    release.resolve()
    await app.ready
  }
  await app.waitForFrame((frame) => !frame.includes("Starting Shake"), { maxPasses: 30 })
})
