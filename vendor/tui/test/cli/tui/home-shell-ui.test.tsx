/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../../src/config"
import { Logo, logoCell } from "../../../src/component/logo"
import { ThemeProvider } from "../../../src/context/theme"
import { epilogue } from "../../../src/util/presentation"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function renderLogo(width: number, height: number, contentWidth = width) {
  const config = createTuiResolvedConfig({ animations: false })
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Logo width={contentWidth} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height },
  )
  app.renderer.start()
  await app.waitForVisualIdle()
  return app
}

test("the wordmark waits for the complete home layout height", async () => {
  for (const height of [8, 9, 10, 11]) {
    const app = await renderLogo(80, height)
    try {
      expect(app.captureCharFrame()).not.toContain("█")
      expect(app.captureCharFrame()).not.toContain("▀")
    } finally {
      app.renderer.destroy()
    }
  }
  for (const height of [12, 13]) {
    const app = await renderLogo(80, height)
    try {
      expect(app.captureCharFrame()).toContain("████ ████ ████ █  █ ████")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the compact mark is used when home content width is below the wordmark width", async () => {
  const fixtures: [number, number][] = [
    [20, 18],
    [24, 22],
    [25, 23],
  ]
  for (const [terminal, content] of fixtures) {
    const app = await renderLogo(terminal, 20, content)
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("▀▀▀▀")
      expect(frame).not.toContain("████ ████")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the full mark is used once home content width fits it", async () => {
  const fixtures: [number, number][] = [
    [26, 24],
    [30, 26],
  ]
  for (const [terminal, content] of fixtures) {
    const app = await renderLogo(terminal, 20, content)
    try {
      expect(app.captureCharFrame()).toContain("████ ████ ████ █  █ ████")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the compact mark keeps its shaded half-block cells", async () => {
  const app = await renderLogo(24, 20, 22)
  try {
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const block = spans.find((span) => span.text.includes("▀"))
    if (!block) throw new Error("the compact mark did not render half-block cells")
    const shaded = spans.find((span) => span.text.trim() === "" && !span.bg.equals(block.bg))
    if (!shaded) throw new Error("the compact mark did not shade its `_` cells")
    expect(shaded.text).toBe("  ")
  } finally {
    app.renderer.destroy()
  }
})

test("logoCell preserves upstream foreground and background shading", () => {
  const fg = RGBA.fromInts(255, 255, 255)
  const shadow = RGBA.fromInts(64, 64, 64)
  expect(logoCell("_", fg, shadow)).toEqual({ text: " ", fg, bg: shadow })
  expect(logoCell("^", fg, shadow)).toEqual({ text: "▀", fg, bg: shadow })
  expect(logoCell("~", fg, shadow)).toEqual({ text: "▀", fg: shadow })
  expect(logoCell(",", fg, shadow)).toEqual({ text: "▄", fg: shadow })
  expect(logoCell("█", fg, shadow)).toEqual({ text: "█", fg })
})

const rows = (text: string | undefined) =>
  Bun.stripANSI(text ?? "")
    .split("\n")
    .filter((line) => line.trim() && !/[▀▄█]/.test(line))

test("the epilogue keeps the default launcher command", () => {
  expect(rows(epilogue({ session: { title: "A session", sessionID: "ses_123" } }))).toEqual([
    "  Session   A session",
    "  Continue  shake -s ses_123",
  ])
})

test("the epilogue uses a renamed launcher", () => {
  expect(rows(epilogue({ updatedVersion: "2.0.0", command: "openshake" }))).toEqual([
    "  Run openshake to use 2.0.0",
  ])
})

test("the epilogue uses an alternate invocation for the session command", () => {
  expect(
    rows(
      epilogue({
        session: { title: "A session", sessionID: "ses_123" },
        updatedVersion: "2.0.0",
        command: "bun run shake",
      }),
    ),
  ).toEqual([
    "  Run bun run shake to use 2.0.0",
    "  Session   A session",
    "  Continue  bun run shake -s ses_123",
  ])
})
