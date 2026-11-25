# 0001 — Vendor the TUI as git subtrees

**Status:** Accepted

## Problem

Fork the OpenCode TUI frontend without carrying the rest of the monorepo into the new repository, while keeping a practical path to upstream updates.

## Options considered

1. Copy `packages/tui` wholesale into the new repo. Simplest, but upstream updates become manual merges with no shared history.
2. Git submodule. Keeps history separate but requires a full upstream checkout to work, defeating the footprint goal.
3. Git subtree of the whole upstream tree under `vendor/`. Brings the entire monorepo into the working tree.
4. Git subtree of `git subtree split` histories for just `packages/tui`, `packages/latex`, and `packages/merman`.

## Decision

Option 4. Three subtrees under `vendor/` hold only the frontend and the two private builtin renderer packages. The split histories keep `git subtree pull` working for upstream updates; `--squash` keeps the object count small. First-party host code stays in `src/`, and `tsconfig.json` path mappings resolve the two private package specifiers to their vendored sources.

## Tradeoffs

- Upstream commits touching multiple vendored packages appear in three subtree pulls.
- Conflicts in `vendor/` must be resolved locally; first-party code should avoid editing vendored files so pulls stay clean.
- All `@opencode/*` npm dependencies and the server must stay version-aligned with the vendored source; a version bump requires a coordinated sync.

## Revisit if

Upstream publishes `@opencode/tui`, `@opencode/latex`, and `@opencode/merman` to npm, or the fork stops tracking upstream entirely.
