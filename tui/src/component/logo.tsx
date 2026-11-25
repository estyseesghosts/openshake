import { RGBA, TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { go, logo } from "../logo"
import { tint } from "../theme/color"

// The full wordmark occupies 24 cells; anything narrower must use the compact mark.
const fullLogoWidth = Math.max(...logo.map((line) => Array.from(line).length))
// Home's smallest usable stack: a one-row top spacer (the three-row spacer
// shrinks to one before anything else), one gap row under the mark, the prompt's
// top padding and prompt row, and the footer.
const minHomeHeight = logo.length + 5

type LogoCell = { readonly text: string; readonly fg: RGBA; readonly bg?: RGBA }

// Upstream half-block shading: `_` paints a shaded cell, `^` its upper half,
// `~` and `,` the shadow-coloured upper and lower halves respectively.
export function logoCell(char: string, fg: RGBA, shadow: RGBA): LogoCell {
  if (char === "_") return { text: " ", fg, bg: shadow }
  if (char === "^") return { text: "▀", fg, bg: shadow }
  if (char === "~") return { text: "▀", fg: shadow }
  if (char === ",") return { text: "▄", fg: shadow }
  return { text: char, fg }
}

export function Logo(props: { readonly width?: number }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const availableWidth = () => props.width ?? dimensions().width

  // One text node per row keeps the pixel grid aligned: individual text nodes in a
  // flex row let the layout engine drop or resize single-cell spaces.
  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element => {
    const display = Array.from(line)
      .map((char) => {
        if (char === "_" || char === " ") return " "
        if (char === "^" || char === "~" || char === ",") return "▀"
        return char
      })
      .join("")
    return (
      <text fg={fg} attributes={bold ? TextAttributes.BOLD : undefined} selectable={false}>
        {display}
      </text>
    )
  }

  // The compact mark needs a different background per `_`/`^` cell, so each cell
  // is its own text node. It has no unshaded spaces for the layout engine to drop.
  const renderShadedLine = (line: string, fg: RGBA): JSX.Element[] => {
    const shadow = tint(theme.background.base, fg, 0.25)
    return Array.from(line).map((char) => {
      const cell = logoCell(char, fg, shadow)
      return (
        <text fg={cell.fg} bg={cell.bg} attributes={TextAttributes.BOLD} selectable={false}>
          {cell.text}
        </text>
      )
    })
  }

  return (
    <box>
      {dimensions().height < minHomeHeight ? null : availableWidth() < fullLogoWidth ? (
        <For each={go.right.slice(1)}>
          {(line) => <box flexDirection="row">{renderShadedLine(line, theme.text.base)}</box>}
        </For>
      ) : (
        <For each={logo}>{(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}</For>
      )}
    </box>
  )
}
