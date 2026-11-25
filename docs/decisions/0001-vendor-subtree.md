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

Option 4. One subtree under `vendor/` holds the frontend and the two private builtin renderer packages. A local `vendor-source` branch holds successive snapshots built with `git archive` from an upstream ref; `git subtree merge --prefix=vendor <snapshot> --squash` applies them. This keeps upstream history out of the repo entirely — `git subtree split` would have to walk ~23k commits for each package — while preserving a clean subtree root and a repeatable update path. First-party host code stays in `src/`, and a Bun module-alias plugin resolves the two private package specifiers to their vendored sources (`tsconfig` paths alone do not cross the nested package boundary).

## Tradeoffs

- Snapshots are coarse: intermediate upstream commits between syncs are not visible in the subtree.
- Conflicts in `vendor/` must be resolved locally; first-party code should avoid editing vendored files so syncs stay clean.
- All `@opencode/*` npm dependencies and the server must stay version-aligned with the vendored source; a version bump requires a coordinated sync.

## Revisit if

Upstream publishes `@opencode/tui`, `@opencode/latex`, and `@opencode/merman` to npm, or the fork stops tracking upstream entirely.
