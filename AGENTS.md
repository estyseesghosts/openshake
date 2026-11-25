# OpenShake

Follow `../typescript-style-guide.md` for all first-party code in `src/` and `scripts/`.

## Boundaries

- `vendor/` is upstream code managed by git subtree. Do not edit it by hand; change `src/` instead, or sync with `bun run vendor:sync <ref>` and resolve conflicts in the subtree.
- Keep TUI source changes in a dedicated upstream patch/PR when they belong upstream. Local behavior that is OpenShake-specific belongs in `src/backend.ts`, `src/config.ts`, or `src/main.tsx`.
- The vendored TUI uses no semicolons, double quotes, and 120-column lines, so `bunfig.toml` uses that style and excludes `vendor/` from format/lint. Do not reformat vendored files.

## Version lockstep

The vendored TUI and every `@opencode/*` dependency plus the server must share one version. Update `package.json` (dependencies, overrides, patch version) and `UPSTREAM_VERSION` in `src/backend.ts` together with the subtree sync.

## Backends

- Remote mode is opt-in via `--server` or `OPEN_SHAKE_SERVER`; local mode uses `@opencode/client/promise/service` discovery/ensure and must keep `server.local` accurate.
- Validate URLs and config files at their boundary. Never print credentials in errors or logs.

## Checks

Run `bun run verify` before reporting completion. Tests must not require a live server or network.
