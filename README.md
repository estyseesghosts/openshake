# OpenShake

A soft fork of the OpenCode **TUI frontend**. The TUI, its LaTeX renderer, and its Mermaid renderer are vendored as three git subtrees from `anomalyco/opencode`; the server, SDKs, and theme packages stay as pinned npm dependencies. No monorepo checkout is needed to build or run this project.

## Requirements

- Bun `1.4.4` (see `.bun-version`)
- Either a local OpenCode service (`@opencode/cli@2.4.1` is a dev dependency and provides `opencode serve --service`), or a reachable remote OpenCode server.

## Install and run

```bash
bun install
bun run dev                        # local background service, auto-discovered/started
bun run dev /path/to/project       # same, launching in a directory
```

Remote backend:

```bash
OPEN_SHAKE_SERVER=http://host:4096 bun run dev
OPEN_SHAKE_SERVER=https://host:4096 OPEN_SHAKE_PASSWORD=... bun run dev
# or: bun run dev --server http://host:4096 --username user --password ...
```

`--local` forces the local background service and ignores the server env vars. `OPEN_SHAKE_CHANNEL` isolates client-local state (tabs, drafts, layout) between different forks or backends; it defaults to `local`.

Settings are stored in `~/.config/openshake/config.json` (override with `OPEN_SHAKE_CONFIG`). The file is validated against the vendored TUI's config schema on load and on write.

## Version lockstep

The vendored TUI source and every `@opencode/*` package plus the server **must** be the same version. The generated HTTP client and plugin SDK in `@opencode/client` / `@opencode/plugin` are built from the server's API at that exact commit. Currently pinned to `2.4.1` in `package.json`, overrides, and `src/backend.ts`.

## Upstream sync

```bash
bun run vendor:sync v2.4.2
```

The script archives `packages/tui`, `packages/latex`, and `packages/merman` from the upstream ref, commits that snapshot on the `vendor-source` branch, then applies it with `git subtree merge --prefix=vendor`. It defaults to the sibling `../opencode` checkout; set `OPENCODE_UPSTREAM` to use another path. This avoids splitting tens of thousands of upstream commits just to move a snapshot. After syncing, bump the pinned version in `package.json` and `UPSTREAM_VERSION` in `src/backend.ts`, re-run `bun install`, and commit the result. Resolve any vendor conflicts in `vendor/` only; keep first-party changes in `src/`.

## Layout

```text
src/            first-party host: backend resolution, config persistence, entry point
vendor/tui/     subtree of upstream packages/tui
vendor/latex/   subtree of upstream packages/latex
vendor/merman/  subtree of upstream packages/merman
patches/        upstream solid-js patch, applied via bun patchedDependencies
scripts/        vendor sync helper
```

`tsconfig.json` maps `@opencode/latex/*` and `@opencode/merman/*` to the vendored sources, so the two private upstream packages resolve without publishing or editing the vendored imports.

## Checks

```bash
bun run verify
```

Vendored code is excluded from formatting and linting; it is checked with the upstream TypeScript settings, while first-party code follows `AGENTS.md` and `../typescript-style-guide.md`. `lint:check` uses `oxlint` because Bun 1.4.4's `bun lint` delegates to a package script and cannot be used as a built-in. The test script explicitly lists first-party test files; upstream's vendored tests require their own preload and are not part of this gate.
