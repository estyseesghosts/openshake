/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { PromptMetadataRow, promptMetadataLayout } from "../../src/component/prompt/metadata"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("context readout reserves width without changing a roomy metadata row", () => {
  const roomy = promptMetadataLayout({
    width: 80,
    terminalWidth: 100,
    agent: "Build",
    auto: false,
    model: "Hy4 flash Free",
    provider: "OpenCode Go",
    variant: "high",
    context: "14.1K (45%)",
  })
  expect(roomy.model).toBe("Hy4 flash Free")
  expect(roomy.provider).toBe("OpenCode Go")
  expect(roomy.variant).toBe("high")

  const tight = promptMetadataLayout({
    width: 30,
    terminalWidth: 100,
    agent: "",
    auto: false,
    model: "Hy4 flash Free OpenCode",
    provider: "",
    context: "14.1K (45%)",
  })
  expect(tight.model).not.toBe("Hy4 flash Free OpenCode")
  expect(tight.model.length).toBeLessThan("Hy4 flash Free OpenCode".length)
})

test("narrow metadata truncates provider and variant instead of dropping them", () => {
  const layout = promptMetadataLayout({
    width: 31,
    terminalWidth: 40,
    agent: "Build",
    auto: false,
    model: "Hy4",
    provider: "OpenCode Go",
    variant: "medium",
    context: "14.1K",
  })
  expect(layout.agent).toBeUndefined()
  expect(layout.provider).toEndWith("…")
  expect(layout.variant).toEndWith("…")
})

test("model and variant clicks fire their handlers without changing keyboard state", async () => {
  const clicks: string[] = []
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <PromptMetadataRow
            mode="normal"
            agent="Build"
            auto={false}
            model="Hy4 flash Free"
            provider="OpenCode Go"
            variant="high"
            muted={false}
            highlight={RGBA.fromHex("#0000ff")}
            agentAlpha={1}
            modelAlpha={1}
            variantAlpha={1}
            onModelClick={() => clicks.push("model")}
            onVariantClick={() => clicks.push("variant")}
          />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 80, height: 1 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Hy4 flash Free")

    await app.mockMouse.click(10, 0)
    await app.mockMouse.click(38, 0)
    expect(clicks).toEqual(["model", "variant"])
  } finally {
    app.renderer.destroy()
  }
})
