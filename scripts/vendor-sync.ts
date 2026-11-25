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
  return result.exitCode
}

function git(args: readonly string[], cwd = root, env = process.env) {
  return run("git", args, cwd, env)
}

function tryRun(command: string, args: readonly string[], cwd: string) {
  return Bun.spawnSync([command, ...args], { cwd, stdout: "inherit", stderr: "inherit" }).exitCode
}

function gitOutput(args: readonly string[], cwd = root) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`)
  return new TextDecoder().decode(result.stdout).trim()
}

const tarBinary =
  process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"

const originalBranch = gitOutput(["branch", "--show-current"])
if (!originalBranch) throw new Error("vendor:sync must run from a branch, not a detached HEAD")
if (gitOutput(["status", "--porcelain"]) !== "") throw new Error("Commit or stash local changes before vendor:sync")

const scratch = await mkdtemp(path.join(os.tmpdir(), "openshake-vendor-"))
const archive = path.join(scratch, "upstream.tar")
const extracted = path.join(scratch, "extracted")
const snapshotWorktree = path.join(scratch, "snapshot")
const forkWorktree = path.join(scratch, "fork")

try {
  await mkdir(extracted, { recursive: true })
  git(["-C", upstream, "archive", "-o", archive, ref, ...names.map((name) => `packages/${name}`)])
  run(tarBinary, ["-xf", archive, "-C", extracted])

  // The pristine upstream snapshot lives on `vendor-source`. OpenShake's changes
  // live on `tui-fork`, which is rebased onto each new snapshot before the subtree
  // merge so every conflict is resolved once, on the fork branch.
  git(["worktree", "add", snapshotWorktree, "vendor-source"])
  git(["worktree", "add", forkWorktree, "tui-fork"])
  try {
    for (const name of names) {
      await rm(path.join(snapshotWorktree, name), { recursive: true, force: true })
      await cp(path.join(extracted, "packages", name), path.join(snapshotWorktree, name), { recursive: true })
    }
    git(["-C", snapshotWorktree, "add", "-A", "--", ...names])

    if (gitOutput(["-C", snapshotWorktree, "status", "--porcelain"]) !== "") {
      const identity = {
        ...process.env,
        GIT_AUTHOR_NAME: "openshake",
        GIT_AUTHOR_EMAIL: "openshake@localhost",
        GIT_COMMITTER_NAME: "openshake",
        GIT_COMMITTER_EMAIL: "openshake@localhost",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      }
      git(["-C", snapshotWorktree, "commit", "-m", `vendor: ${ref}`], snapshotWorktree, identity)
    }

    const rebase = tryRun("git", ["rebase", "vendor-source"], forkWorktree)
    if (rebase !== 0) {
      // Do not leave the fork worktree mid-rebase; surface the conflicts for a human.
      tryRun("git", ["rebase", "--abort"], forkWorktree)
      throw new Error(`Rebasing tui-fork onto ${ref} conflicted; resolve the fork changes and retry`)
    }

    git(["subtree", "merge", "--prefix=vendor", "tui-fork", "--squash", "-m", `subtree: sync tui-fork from ${ref}`])
    process.stdout.write(
      `Updated vendor/ from ${ref} via tui-fork (${gitOutput(["rev-parse", "--short", "tui-fork"])})\n`,
    )
  } finally {
    git(["worktree", "remove", "--force", snapshotWorktree])
    git(["worktree", "remove", "--force", forkWorktree])
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
