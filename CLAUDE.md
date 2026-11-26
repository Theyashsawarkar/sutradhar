# sutradhar -- notes for agents

Lets AI agents use the user's real browser. Three parts, all TypeScript:
`packages/daemon` (daemon, native-messaging host, MCP server, CLI: one bundle,
`dist/sutradhar.mjs`), `packages/protocol` (the two-way tRPC link and shared
zod schemas) and `extension` (Chrome MV3 / Firefox MV2 from one source).
PLAN.md is the original design; README.md documents every tool, setting and
command; docs/adr holds the decisions.

- **tRPC routers:** `extension/src/background/router.ts` (browserRouter,
  served by the extension), `packages/daemon/src/hub-router.ts` (hub, called
  by the extension, paths prefixed `hub.`), `packages/daemon/src/agent-router.ts`
  (agent API = the MCP tools, prefixed `agent.`). A new MCP tool is a new
  agentRouter procedure with `.meta({ description })` (and `untrusted: true`
  if it returns page content); mcp.ts lists it automatically.
- **Risk rules** live in `extension/src/content/risk.ts` and dom.ts
  (`isSecretField`); the gate and notifications in `packages/daemon/src/gates.ts`.
  Never let an agent type into secret fields or press pay/buy/delete-account:
  those are handoffs, enforced in the page.
- **Build:** `pnpm build` (scripts/build.mjs writes dist/ and both
  manifests). `pnpm check` = typecheck + unit tests + build.
- **MCP:** the daemon serves each MCP session itself on `mcp.sock`
  (daemon.ts `serveMcp`, server built in mcp.ts); `sutradhar mcp` is the
  Rust pipe `crates/sutradhar-mcp` (std only: preamble `{"name"}` line, then
  bytes both ways; `cargo test` and `cargo clippy -- -D warnings` there).
  Without it, or without a daemon, `sutradhar mcp` is the old Node server.
- **Tests never touch the user's browser, profile, daemon or desktop.**
  `pnpm e2e` runs throwaway headless Chromium, Zen and Firefox profiles with a
  test daemon on its own socket and a fake notify-send
  (tests/e2e/harness.mjs). Real mouse/keyboard tests run only through
  `tests/e2e/nested-sway.sh` (private headless sway, its own runtime dir,
  killed by PID). Never run bare `swaymsg` from a test. Fixtures use made-up data.
- **Identity:** logo `assets/logo.svg`, verse Bhagavad Gītā 7.7 (verified),
  in README, site.toml and the panel (`extension/icons/shloka.svg`).
- **Website:** after changing README.md, CHANGELOG.md or docs/adr/, run
  `python3 scripts/build-site.py` and commit docs/.
- Every change gets a CHANGELOG.md entry; releases are tags `vX.Y.Z` with
  `version` in package.json bumped to match (it flows into both manifests and
  the CLI). After bumping, run `pnpm release-manifest` so `updates.json`
  (what Firefox/Zen check for self-updates) names the new version, and commit
  it with the release. Then `node scripts/amo-submit.mjs` sends it to
  addons.mozilla.org (key pair in ~/.config/sutradhar/amo.toml, never in git).
- Keys: the extension's "Stop every agent" command has no default key (the
  global one is Super+Shift+Delete in Vayu's sway config, annotated there).
