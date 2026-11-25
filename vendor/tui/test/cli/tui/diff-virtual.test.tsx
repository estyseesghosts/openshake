import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { addDefaultParsers, DiffRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { PatchDiff, type PatchDiffRef } from "../../../src/component/patch-diff"
import { splitLargePatch } from "../../../src/util/diff"
import parsers from "../../../src/parsers-config"

function largeModifiedPatch() {
  const body: string[] = []
  let oldCount = 0
  let newCount = 0
  for (let index = 0; index < 3200; index++) {
    if (index % 3 === 0) {
      body.push(` context ${index}`)
      oldCount++
      newCount++
    } else if (index % 3 === 1) {
      body.push(`-old ${index}`)
      oldCount++
    } else {
      body.push(`+new ${index}`)
      newCount++
    }
  }
  return [`--- a/huge.ts`, `+++ b/huge.ts`, `@@ -1,${oldCount} +1,${newCount} @@`, ...body].join("\n")
}

const patch = largeModifiedPatch()
const chunks = splitLargePatch(patch, 128)!
const totalRows = chunks.reduce((rows, chunk) => rows + chunk.rows, 0)

function findDiffs(root: Renderable): DiffRenderable[] {
  return root instanceof DiffRenderable ? [root] : root.getChildren().flatMap(findDiffs)
}

async function mount(view: "unified" | "split", viewport: () => number, filetype?: string) {
  let scroll: ScrollBoxRenderable | undefined
  let ref: PatchDiffRef | undefined
  const app = await testRender(
    () => (
      <scrollbox ref={(node: ScrollBoxRenderable) => (scroll = node)} width={40} height={viewport()}>
        <PatchDiff
          ref={(value: PatchDiffRef) => (ref = value)}
          diff={patch}
          scroll={() => scroll}
          view={view}
          filetype={filetype}
          hunkFg="#ffffff"
          lineNumberBg="#000000"
          fg="#ffffff"
          addedBg="#000000"
          removedBg="#000000"
          contextBg="#000000"
          addedSignColor="#00ff00"
          removedSignColor="#ff0000"
          lineNumberFg="#888888"
        />
      </scrollbox>
    ),
    { width: 40, height: 24 },
  )
  return { app, scroll: () => scroll, ref: () => ref }
}

test("a giant modified patch mounts bounded chunks with exact placeholder heights", async () => {
  addDefaultParsers(parsers.parsers)
  const viewport = createSignal(24)
  const { app, ref } = await mount("unified", viewport[0])
  try {
    app.renderer.start()
    await app.waitFor(() => findDiffs(app.renderer.root).length > 0)
    const root = ref()!.hunks()[0]!
    const children = root.getChildren()
    expect(chunks.length).toBeGreaterThan(20)
    expect(children).toHaveLength(chunks.length)
    expect(children.reduce((rows, child) => rows + child.height, 0)).toBe(totalRows)
    expect(findDiffs(root).length).toBeLessThan(8)
  } finally {
    app.renderer.destroy()
  }
})

test("split view virtualizes a modified patch in no-syntax large-mode", async () => {
  addDefaultParsers(parsers.parsers)
  const viewport = createSignal(24)
  const { app, ref } = await mount("split", viewport[0], "typescript")
  try {
    app.renderer.start()
    await app.waitFor(() => findDiffs(app.renderer.root).length > 0)
    const root = ref()!.hunks()[0]!
    const mounted = findDiffs(root)
    expect(mounted.length).toBeLessThan(8)
    expect(mounted.every((diff) => diff.filetype === undefined)).toBe(true)
    expect(root.getChildren().reduce((rows, child) => rows + child.height, 0)).toBe(totalRows)
  } finally {
    app.renderer.destroy()
  }
})

test("viewport resize keeps every chunk height exact", async () => {
  addDefaultParsers(parsers.parsers)
  const [viewport, setViewport] = createSignal(24)
  const { app, ref, scroll } = await mount("unified", viewport)
  try {
    app.renderer.start()
    await app.waitFor(() => findDiffs(app.renderer.root).length > 0)
    const before = scroll()!.viewport.height
    setViewport(6)
    await app.waitFor(() => scroll()!.viewport.height !== before)
    const root = ref()!.hunks()[0]!
    expect(root.getChildren().reduce((rows, child) => rows + child.height, 0)).toBe(totalRows)
  } finally {
    app.renderer.destroy()
  }
})
