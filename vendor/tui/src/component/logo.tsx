import { RGBA, TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { go, logo } from "../logo"

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

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

  return (
    <box>
      {dimensions().height < 9 ? null : dimensions().width < 24 ? (
        <For each={go.right.slice(1)}>
          {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
        </For>
      ) : (
        <For each={logo}>
          {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
        </For>
      )}
    </box>
  )
}
