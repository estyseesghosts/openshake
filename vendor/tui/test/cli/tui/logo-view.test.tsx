/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { Logo } from "../../../src/component/logo"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("the rendered logo keeps every pixel row intact", async () => {
  const config = createTuiResolvedConfig({ animations: false })
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Logo />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24 },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("████ ████ ████ █  █ ████"))
    const rows = app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("█"))
    expect(rows).toEqual([
      "█         █",
      "█         █",
      "████ ████ ████ █  █ ████",
      "█    █  █    █ █ █  █  █",
      "████ █  █  ███ ██   ████",
      "█ █  █ █  █ █ █  █",
      "████ █  █ ████ █  █ ████",
    ])
  } finally {
    app.renderer.destroy()
  }
})
