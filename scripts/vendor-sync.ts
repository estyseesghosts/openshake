import path from "node:path"
import { mkdir, rm } from "node:fs/promises"

const root = path.resolve(import.meta.dir, "..")
const upstream = process.env.OPENCODE_UPSTREAM ?? path.resolve(root, "..", "opencode")
const ref = process.argv[2] ?? "v2.4.1"
const scratch = path.join(root, ".git", "openshake-vendor-sync")

const packages = [
  ["packages/tui", "vendor/tui", "vendor-tui"],
  ["packages/latex", "vendor/latex", "vendor-latex"],
  ["packages/merman", "vendor/merman", "vendor-merman"],
] as const

function git(args: readonly string[], cwd = root) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`)
}

await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })
git(["clone", "--shared", "--no-checkout", upstream, scratch])
git(["-C", scratch, "checkout", "-f", ref])

for (const [prefix, destination, branch] of packages) {
  process.stdout.write(`Syncing ${prefix} -> ${destination} at ${ref}\n`)
  git(["-C", scratch, "subtree", "split", `--prefix=${prefix}`, ref, "-b", branch])
  git(["subtree", "pull", "--prefix", destination, scratch, branch, "--squash"])
}

process.stdout.write("Vendor sync complete. Update package.json and src/backend.ts if the upstream version changed.\n")
