import os from "node:os"
import path from "node:path"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"

const root = path.resolve(import.meta.dir, "..")
const upstream = process.env.OPENCODE_UPSTREAM ?? path.resolve(root, "..", "opencode")
const ref = process.argv[2] ?? "v2.4.1"
const names = ["tui", "latex", "merman"] as const

function run(command: string, args: readonly string[], cwd = root, env = process.env) {
  const result = Bun.spawnSync([command, ...args], { cwd, env, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}`)
}

function git(args: readonly string[], cwd = root, env = process.env) {
  run("git", args, cwd, env)
}

function gitOutput(args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`)
  return new TextDecoder().decode(result.stdout).trim()
}

const tarBinary =
  process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"

const scratch = await mkdtemp(path.join(os.tmpdir(), "openshake-vendor-"))
const archive = path.join(scratch, "upstream.tar")
const extracted = path.join(scratch, "extracted")
const worktree = path.join(scratch, "worktree")

try {
  await mkdir(extracted, { recursive: true })
  git(["-C", upstream, "archive", "-o", archive, ref, ...names.map((name) => `packages/${name}`)])
  run(tarBinary, ["-xf", archive, "-C", extracted])

  git(["worktree", "add", "--detach", worktree, "vendor-source"])
  try {
    for (const name of names) {
      await rm(path.join(worktree, name), { recursive: true, force: true })
      await cp(path.join(extracted, "packages", name), path.join(worktree, name), { recursive: true })
    }
    git(["-C", worktree, "add", "-A", "--", ...names])

    if (gitOutput(["-C", worktree, "status", "--porcelain"]) === "") {
      process.stdout.write(`vendor/ already matches ${ref}\n`)
    } else {
      const identity = {
        ...process.env,
        GIT_AUTHOR_NAME: "openshake",
        GIT_AUTHOR_EMAIL: "openshake@localhost",
        GIT_COMMITTER_NAME: "openshake",
        GIT_COMMITTER_EMAIL: "openshake@localhost",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      }
      git(["-C", worktree, "commit", "-m", `vendor: ${ref}`], worktree, identity)
      const snapshot = gitOutput(["-C", worktree, "rev-parse", "HEAD"])
      git(["subtree", "merge", "--prefix=vendor", snapshot, "--squash"])
      process.stdout.write(`Updated vendor/ from ${ref} (${snapshot.slice(0, 10)})\n`)
    }
  } finally {
    git(["worktree", "remove", "--force", worktree])
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
