import { logo } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

function wordmark(pad = "") {
  const draw = (line: string, fg: string, shadow: string, bg: string) =>
    [...line]
      .map((char) => {
        if (char === "_") return `${bg} ${reset}`
        if (char === "^") return `${fg}${bg}▀${reset}`
        if (char === "~") return `${shadow}▀${reset}`
        if (char === " ") return " "
        return `${fg}${char}${reset}`
      })
      .join("")

  return logo.map((line) => `${pad}${draw(line, reset, "\x1b[38;5;238m", "\x1b[48;5;238m")}`)
}

export type SessionEpilogue = { readonly title: string; readonly sessionID?: string }

// Printed after the TUI closes. `command` is the invocation the user should type;
// it defaults to the packaged launcher, and callers pass renamed/package commands.
export function epilogue(
  input: {
    readonly session?: SessionEpilogue
    readonly updatedVersion?: string
    readonly command?: string
  },
) {
  if (!input.session && !input.updatedVersion) return
  const command = input.command ?? "shake"
  const row = (label: string, value: string) => `  ${dim}${label.padEnd(10, " ")}${reset}${bold}${value}${reset}`
  return [
    ...wordmark("  "),
    "",
    ...(input.updatedVersion
      ? [
          `  ${dim}Run ${reset}${bold}${command}${reset}${dim} to use ${reset}${bold}${input.updatedVersion}${reset}`,
          "",
        ]
      : []),
    ...(input.session
      ? [row("Session", input.session.title), row("Continue", `${command} -s ${input.session.sessionID}`), ""]
      : []),
  ].join("\n")
}
