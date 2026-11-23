# 1. TypeScript, tRPC and native messaging

Date: 2026-11-23. Status: accepted.

## Context

sutradhar has three parties: agents, a local daemon, and an extension in each
browser. The extension must be JavaScript. Most Vayu tools are Go.

## Decision

- **TypeScript everywhere, on Node 22+.** The extension is TypeScript anyway;
  with the daemon in TypeScript too, one zod schema per call is the tRPC input,
  the MCP tool's input schema and the extension's type, so nothing drifts.
- **tRPC on every hop, both ways.** Both ends of a connection serve a router
  and call the other's over one framed link (`packages/protocol/src/rpc.ts`):
  the daemon calls `browserRouter` in the extension; the extension calls `hub`
  in the daemon; agents call `agent`. No subscriptions: events are calls.
- **Native messaging between browser and daemon**, through a small host
  process (`sutradhar host`) that pipes to the daemon's unix socket. A
  localhost WebSocket would be reachable by any web page.
- **Node instead of Bun**: already installed, runs TypeScript, one bundled file
  (`dist/sutradhar.mjs`) via esbuild.
- **Firefox/Zen use MV2** with a persistent background page (an open native
  port keeps it alive and its APIs are complete there); Chrome uses MV3.

## Consequences

- Node is a runtime dependency (a kosha `requires`), where Go gave one binary.
- Messages from host to browser are capped at 1 MB by browsers; big frames are
  split into parts and joined in the extension (`framing.ts`).
