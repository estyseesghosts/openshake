/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  getTreeSitterClient,
  type ColorInput,
  type DiffGutterOptions,
  type OnHighlightCallback,
  type Renderable,
  type ScrollBoxRenderable,
  type SimpleHighlight,
} from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { useRenderer } from "@opentui/solid"
import { batch, createMemo, createSignal, For, onCleanup, Show, splitProps } from "solid-js"
import { splitLargePatch, splitPatchHunks, type PatchChunk } from "../util/diff"
import { createHighlightCache, highlightBudgetExceeded, partitionHighlights } from "../util/diff-highlight"

export interface PatchDiffRef {
  readonly hunks: () => readonly (DiffRenderable | BoxRenderable)[]
}

// Smaller patches render fine as a single DiffRenderable; only split files large enough to stall the TUI.
const VIRTUAL_MIN_LINES = 3000
const VIRTUAL_CHUNK_LINES = 128

type Props = Omit<JSX.IntrinsicElements["diff"], "diff" | "lineNumberBg" | "ref"> & {
  diff: string
  hunkFg: ColorInput
  lineNumberBg: ColorInput
  ref?: (value: PatchDiffRef) => void
  scroll?: () => ScrollBoxRenderable | undefined
  /** Extra gutter columns before the line numbers, painted in each row's color. */
  gutterPadding?: number
}

export function PatchDiff(props: Props) {
  const [local, diffProps] = splitProps(props, [
    "diff",
    "hunkFg",
    "lineNumberBg",
    "ref",
    "scroll",
    "gutterPadding",
    "filetype",
  ])
  const hunks = createMemo(() => splitPatchHunks(local.diff))
  const chunks = createMemo(() => {
    if (!local.scroll) return
    const result = splitLargePatch(local.diff, VIRTUAL_CHUNK_LINES)
    return result && lineCount(result) > VIRTUAL_MIN_LINES ? result : undefined
  })
  // Hunks, virtual chunks and split sides each have their own gutter; give them all one width so the code lines up.
  const gutter = createMemo((): DiffGutterOptions => {
    const paddingLeft = 1 + (local.gutterPadding ?? 0)
    const last = [...local.diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((match) => [
      Number(match[1]) + Number(match[2] ?? 1) - 1,
      Number(match[3]) + Number(match[4] ?? 1) - 1,
    ])
    const virtual = chunks()
    const maxLine = Math.max(1, ...last, ...(virtual ? [lineCount(virtual)] : []))
    return { paddingLeft, minDigits: String(maxLine).length }
  })
  const nodes = new Map<number, DiffRenderable>()
  let virtualRoot: BoxRenderable | undefined
  local.ref?.({
    hunks: () => {
      if (chunks()) return virtualRoot && !virtualRoot.isDestroyed ? [virtualRoot] : []
      return [...nodes.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, node]) => node)
        .filter((node) => !node.isDestroyed)
    },
  })
  const register = (index: number, node: DiffRenderable) => {
    nodes.set(index, node)
    onCleanup(() => nodes.delete(index))
  }

  return (
    <Show
      when={chunks()}
      fallback={
        <For each={hunks()}>
          {(hunk, index) => (
            <>
              <Show when={index() > 0}>
                <box width="100%" height={1} backgroundColor={local.lineNumberBg}>
                  <text fg={local.hunkFg} bg={local.lineNumberBg}>
                    {` ${hunk.header ?? ""}`}
                  </text>
                </box>
              </Show>
              <diff
                {...diffProps}
                ref={(node: DiffRenderable) => register(index(), node)}
                diff={hunk.patch}
                minHeight={hunk.rows}
                lineNumberBg={local.lineNumberBg}
                gutter={gutter()}
                filetype={local.filetype}
              />
            </>
          )}
        </For>
      }
    >
      {(items) => (
        <VirtualPatch
          chunks={items()}
          scroll={local.scroll!}
          diffProps={diffProps}
          filetype={local.filetype}
          lineNumberBg={local.lineNumberBg}
          gutter={gutter()}
          register={register}
          registerRoot={(root) => (virtualRoot = root)}
        />
      )}
    </Show>
  )
}

// Whole-file syntax results are immutable for a given source; reuse them across viewport changes and remounts.
const highlightCache = createHighlightCache<Promise<SimpleHighlight[][] | undefined>>()

// Chunks render without wrapping so each one is exactly `rows` tall. Offscreen chunks become fixed-height
// placeholders; viewport membership follows cumulative row offsets, so resize and mixed heights stay exact.
// Split view and oversized files use no-syntax large-mode: a chunk is not valid source on its own, so it is
// never parsed independently with invented syntax state.
function VirtualPatch(props: {
  chunks: readonly PatchChunk[]
  scroll: () => ScrollBoxRenderable | undefined
  diffProps: Omit<JSX.IntrinsicElements["diff"], "diff" | "lineNumberBg" | "ref" | "filetype">
  filetype: string | undefined
  lineNumberBg: ColorInput
  gutter: DiffGutterOptions
  register: (index: number, node: DiffRenderable) => void
  registerRoot: (root: BoxRenderable) => void
}) {
  const renderer = useRenderer()
  const [first, setFirst] = createSignal(0)
  const [last, setLast] = createSignal(0)
  // A chunk is not valid source on its own (a slice of a JSON object parses as an error), so highlight the
  // whole file once and partition the result into per-chunk slices instead of refiltering on every render.
  const contents = createMemo(() =>
    props.chunks.map((chunk) =>
      chunk.lines
        .filter((line) => !line.startsWith("\\"))
        .map((line) => line.slice(1))
        .join("\n"),
    ),
  )
  const sourceLines = createMemo(() => contents().reduce((count, content) => count + content.split("\n").length, 0))
  const rowOffsets = createMemo(() => {
    const offsets = new Array<number>(props.chunks.length + 1)
    offsets[0] = 0
    for (let index = 0; index < props.chunks.length; index++) {
      offsets[index + 1] = offsets[index] + props.chunks[index].rows
    }
    return offsets
  })
  const noSyntax = createMemo(
    () =>
      (props.diffProps.view ?? "unified") !== "unified" ||
      highlightBudgetExceeded(contents(), sourceLines()),
  )
  const partitioned = createMemo(() => {
    const filetype = props.filetype
    if (noSyntax() || !filetype) return Promise.resolve(undefined)
    const source = contents().join("\n")
    return highlightCache.get(source, () =>
      getTreeSitterClient()
        .highlightOnce(source, filetype)
        .then((result) => partitionHighlights(result.highlights ?? [], contents()))
        // Rejects when the renderer tears down the client mid-parse; chunks then keep their own highlights.
        .catch(() => undefined),
    )
  })
  const chunkHighlights =
    (index: number): OnHighlightCallback =>
    async () => {
      if (noSyntax()) return
      return (await partitioned())?.[index]
    }

  return (
    <box
      width="100%"
      ref={(root: BoxRenderable) => {
        props.registerRoot(root)
        root.onLifecyclePass = () => {
          const scroll = props.scroll()
          if (!scroll) return
          // ScrollBox's scroll position is not a Solid signal; observe it during the render pass.
          const top = scroll.scrollTop - (root.y - scroll.content.y)
          const bottom = top + scroll.viewport.height
          const offsets = rowOffsets()
          let first = 0
          while (first < offsets.length - 1 && offsets[first + 1]! <= top) first++
          let last = first
          while (last < offsets.length - 1 && offsets[last]! < bottom) last++
          batch(() => {
            setFirst(first)
            setLast(last)
          })
        }
        renderer.registerLifecyclePass(root)
        onCleanup(() => renderer.unregisterLifecyclePass(root))
      }}
    >
      <For each={props.chunks}>
        {(chunk, index) => (
          <Show when={index() >= first() - 1 && index() <= last() + 1} fallback={<box height={chunk.rows} />}>
            <diff
              {...props.diffProps}
              filetype={noSyntax() ? undefined : props.filetype}
              ref={(node: DiffRenderable) => {
                props.register(index(), node)
                // DiffRenderable creates its CodeRenderable after ref runs; setting onHighlight re-highlights.
                queueMicrotask(() => {
                  const code = findCode(node)
                  if (code) code.onHighlight = chunkHighlights(index())
                })
              }}
              diff={chunk.patch}
              wrapMode="none"
              height={chunk.rows}
              lineNumberBg={props.lineNumberBg}
              gutter={props.gutter}
            />
          </Show>
        )}
      </For>
    </box>
  )
}

function findCode(node: Renderable): CodeRenderable | undefined {
  if (node instanceof CodeRenderable) return node
  return node.getChildren().reduce<CodeRenderable | undefined>((found, child) => found ?? findCode(child), undefined)
}

function lineCount(chunks: readonly PatchChunk[]) {
  return chunks.reduce((count, chunk) => count + chunk.lines.filter((line) => !line.startsWith("\\")).length, 0)
}
