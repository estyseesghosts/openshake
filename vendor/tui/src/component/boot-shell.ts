import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { logo } from "../logo"

/**
 * The smallest thing we can paint: a wordmark and a single line. It uses raw
 * renderables, so it needs no theme, location, client or plugin providers. Cold
 * start paints this as soon as the renderer exists, before the location RPC is
 * joined; the full app replaces it once location is known.
 */
export function paintBootShell(renderer: CliRenderer): () => void {
  const shell = new BoxRenderable(renderer, {
    id: "shake-boot-shell",
    width: "100%",
    height: "100%",
    backgroundColor: "#000000",
  })
  const content = new TextRenderable(renderer, {
    id: "shake-boot-content",
    content: `${logo.join("\n")}\n\n  Starting Shake…`,
    fg: "#ffffff",
    width: "100%",
    height: "100%",
  })
  shell.add(content)
  renderer.root.add(shell)
  renderer.requestRender()
  let disposed = false
  return () => {
    if (disposed || renderer.isDestroyed) return
    disposed = true
    renderer.root.remove(shell)
    shell.destroy()
    renderer.requestRender()
  }
}
