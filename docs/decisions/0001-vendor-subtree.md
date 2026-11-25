# 0001 — Vendor the TUI as git subtrees

**Status:** Accepted

## Problem

Fork the OpenCode TUI frontend without carrying the rest of the monorepo into the new repository, while keeping a practical path to upstream updates.

## Options considered

1. Copy `packages/tui` wholesale into the new repo. Simplest, but upstream updates become manual merges with no shared history.
2. Git submodule. Keeps history separate but requires a full upstream checkout to work, defeating the footprint goal.
3. Git subtree of the whole upstream tree under `vendor/`. Brings the entire monorepo into the working tree.
4. Git subtree of a curated snapshot branch containing only `packages/tui`, `packages/latex`, and `packages/merman`.

## Decision

Option 4 with three branches. One subtree under `vendor/` holds the frontend and the two private builtin renderer packages. `vendor-source` holds pristine snapshots built with `git archive` from an upstream ref; `tui-fork` holds those snapshots plus every OpenShake change to vendored code as ordinary commits; `git subtree merge --prefix=vendor tui-fork --squash` applies the result to `main`. `bun run vendor:sync <ref>` performs all three steps and aborts cleanly if the fork rebase conflicts. This keeps upstream history out of the repo entirely — `git subtree split` would have to walk ~23k commits for each package — while concentrating upstream conflicts in one reviewable branch and keeping `main`'s `vendor/` a clean subtree. First-party host code stays in `src/`, and a Bun module-alias plugin resolves the two private package specifiers to their vendored sources (`tsconfig` paths alone do not cross the nested package boundary).

## Tradeoffs

- Snapshots are coarse: intermediate upstream commits between syncs are not visible in the subtree.
- Conflicts on an upstream bump are resolved by rebasing `tui-fork` onto the new `vendor-source` snapshot; vendored files are never hand-edited on `main`.
- All `@opencode/*` npm dependencies and the server must stay version-aligned with the vendored source; a version bump requires a coordinated sync.

## Revisit if

Upstream publishes `@opencode/tui`, `@opencode/latex`, and `@opencode/merman` to npm, or the fork stops tracking upstream entirely.
