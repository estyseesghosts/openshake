import { defaultLoadScale, runLoadBenchmark, type LoadScale } from "../src/util/load-benchmark"

function option(name: string, fallback: number) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const raw = process.argv[index + 1]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const scale: LoadScale = {
  sessions: option("--sessions", defaultLoadScale.sessions),
  messagesPerSession: option("--messages", defaultLoadScale.messagesPerSession),
  assistants: option("--assistants", defaultLoadScale.assistants),
  deltaRounds: option("--rounds", defaultLoadScale.deltaRounds),
  screenshotBytes: option("--screenshot-bytes", defaultLoadScale.screenshotBytes),
  diffLines: option("--diff-lines", defaultLoadScale.diffLines),
}

// Opt-in wall-clock measurement; never enabled by CI's deterministic assertions.
const realFrames = process.argv.includes("--real-frames")
const report = await runLoadBenchmark(scale, {
  realFrames,
  width: option("--width", 100),
  height: option("--height", 30),
})
console.log(JSON.stringify(report, null, 2))
