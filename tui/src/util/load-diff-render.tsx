/** @jsxImportSource @opentui/solid */
import { DiffRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { addDefaultParsers } from "@opentui/core"
import { PatchDiff, type PatchDiffRef } from "../component/patch-diff"
import parsers from "../parsers-config"
import { splitLargePatch } from "./diff"

export type DiffRenderStats = {
  chunks: number
  mounted: number
  diffNodes: number
}

function countDiffs(root: Renderable): number {
  return root instanceof DiffRenderable ? 1 : root.getChildren().reduce((sum, child) => sum + countDiffs(child), 0)
}

/**
 * Actually mount the giant diff through the production PatchDiff component and
 * render it, rather than only partitioning strings. Large modified files must end
 * up as a bounded set of virtual chunks, never one enormous renderable.
 */
export async function renderGiantDiff(patch: string, filetype?: string): Promise<DiffRenderStats> {
  addDefaultParsers(parsers.parsers)
  let scroll: ScrollBoxRenderable | undefined
  let ref: PatchDiffRef | undefined
  const setup = await testRender(
    () => (
      <scrollbox ref={(node) => (scroll = node)} width={100} height={24}>
        <PatchDiff
          ref={(value) => (ref = value)}
          diff={patch}
          scroll={() => scroll}
          view="unified"
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
    { width: 100, height: 24 },
  )
  try {
    await setup.renderOnce()
    const chunks = splitLargePatch(patch, 128)?.length ?? 0
    return {
      chunks,
      mounted: ref?.hunks().length ?? 0,
      diffNodes: countDiffs(setup.renderer.root),
    }
  } finally {
    await setup.dispose()
  }
}
