import { expect, test } from "bun:test"
import { logo } from "../../../src/logo"

const glyph = (lines: readonly string[], start: number) => lines.map((line) => [...line].slice(start, start + 4).join(""))

test("the launch banner matches the four-wide, five-tall pixel reference", () => {
  expect(logo).toHaveLength(7)
  for (const line of logo) expect([...line]).toHaveLength(24)
  expect(glyph(logo, 0)).toEqual(["    ", "    ", "████", "█   ", "████", "   █", "████"])
  expect(glyph(logo, 5)).toEqual(["█   ", "█   ", "████", "█  █", "█  █", "█  █", "█  █"])
  expect(glyph(logo, 10)).toEqual(["    ", "    ", "████", "   █", " ███", "█  █", "████"])
  expect(glyph(logo, 15)).toEqual(["█   ", "█   ", "█  █", "█ █ ", "██  ", "█ █ ", "█  █"])
  expect(glyph(logo, 20)).toEqual(["    ", "    ", "████", "█  █", "████", "█   ", "████"])
})

test("the banner contains no OpenCode wordmark", () => {
  expect(logo.join("\n")).not.toMatch(/[▀▄]/)
  expect(logo.join("\n")).not.toContain("opencode")
})
