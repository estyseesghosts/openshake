export interface PatchHunk {
  readonly patch: string
  readonly header?: string
  readonly rows?: number
}

export interface PatchChunk {
  readonly patch: string
  readonly lines: readonly string[]
  readonly rows: number
}

export type AddedPatchChunk = PatchChunk

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/m

/**
 * Splits a new-file patch into chunks of `size` lines, each a valid patch with its own `@@ -0,0 +start,count @@`
 * header. Returns undefined for anything else: patches with context or removed lines would need old and new line
 * numbers recomputed at every cut, so they are not split.
 */
export function splitAddedPatch(patch: string, size: number): AddedPatchChunk[] | undefined {
  const header = /^@@ -0,0 \+1,(\d+) @@[^\n]*\n/m.exec(patch)
  if (!header) return
  const count = Number(header[1])
  const lines = patch
    .slice(header.index + header[0].length)
    .replace(/\n$/, "")
    .split("\n")
  const marker = lines.at(-1)?.startsWith("\\ No newline at end of file") ? lines.pop() : undefined
  if (lines.length !== count || lines.some((line) => !line.startsWith("+"))) return
  const prefix = patch.slice(0, header.index)
  return Array.from({ length: Math.ceil(count / size) }, (_, index) => {
    const start = index * size
    const slice = lines.slice(start, start + size)
    return {
      patch: `${prefix}@@ -0,0 +${start + 1},${slice.length} @@\n${slice.join("\n")}${marker && start + size >= count ? `\n${marker}` : ""}`,
      lines: slice,
      rows: slice.length,
    }
  })
}

/**
 * Chunks any large patch, including modified files with context and removed lines. Each chunk carries recomputed
 * old/new header counts so it remains a valid standalone patch instead of one enormous renderable.
 */
export function splitLargePatch(patch: string, size: number): PatchChunk[] | undefined {
  const added = splitAddedPatch(patch, size)
  if (added) return added

  const chunks: PatchChunk[] = []
  for (const hunk of splitPatchHunks(patch)) {
    const header = hunkHeader.exec(hunk.patch)
    if (!header) return
    const prefix = hunk.patch.slice(0, header.index)
    const suffix = header[5] ?? ""
    const body = hunk.patch
      .slice(header.index + header[0].length)
      .replace(/^\n/, "")
      .replace(/\n$/, "")
      .split("\n")
    const marker = body.at(-1)?.startsWith("\\ No newline at end of file") ? body.pop() : undefined
    let oldLine = Number(header[1])
    let newLine = Number(header[3])

    for (let start = 0; start < body.length; start += size) {
      const lines = body.slice(start, start + size)
      let oldCount = 0
      let newCount = 0
      for (const line of lines) {
        const first = line[0] ?? " "
        if (first === "+" || first === " ") newCount++
        if (first === "-" || first === " ") oldCount++
      }
      const chunkHeader = `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@${suffix}`
      const tail = marker && start + size >= body.length ? `\n${marker}` : ""
      chunks.push({
        patch: `${prefix}${chunkHeader}\n${lines.join("\n")}${tail}`,
        lines,
        rows: countRows(lines),
      })
      oldLine += oldCount
      newLine += newCount
    }
  }
  return chunks
}

export function splitPatchHunks(patch: string): PatchHunk[] {
  const starts = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)].map((match) => match.index)
  if (starts.length <= 1) return [{ patch }]

  const prefix = patch.slice(0, starts[0])
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? patch.length
    const lineEnd = patch.indexOf("\n", start)
    return {
      header: patch.slice(start, lineEnd === -1 ? end : lineEnd),
      patch: prefix + patch.slice(start, end),
      rows: splitRows(patch.slice(start, end)),
    }
  })
}

function splitRows(hunk: string) {
  return countRows(hunk.replace(/\n$/, "").split("\n").slice(1))
}

function countRows(lines: readonly string[]) {
  let rows = 0
  let index = 0

  while (index < lines.length) {
    const prefix = lines[index][0]
    if (prefix === " " || !prefix) {
      rows++
      index++
      continue
    }
    if (prefix === "\\") {
      index++
      continue
    }

    let additions = 0
    let deletions = 0
    while (index < lines.length && (lines[index][0] === "+" || lines[index][0] === "-")) {
      if (lines[index][0] === "+") additions++
      if (lines[index][0] === "-") deletions++
      index++
    }
    rows += Math.max(additions, deletions)
  }

  return rows
}
