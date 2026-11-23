# Changelog

## 0.1.0 (2026-11-23)

First release.

- One extension for Chrome (MV3), Firefox and Zen (MV2), a local daemon, and an
  MCP server (`sutradhar mcp`) for any agent; `sutradhar call` for scripts.
- tRPC on every hop: a two-way framed link over native messaging and a unix
  socket; the agent router's zod schemas are the MCP tools' schemas.
- 29 tools: tabs, windows, navigate, snapshot (roles, refs, shadow DOM,
  cross-origin frames), page text as Markdown, screenshots, find, act (click,
  hover, move, type, press, select, check, fill, clear, focus, scroll, drag,
  upload, wait), dialogs, eval_js, console, network, waits, downloads, PDF,
  clipboard, bookmarks, history, cookies, record (GIF/WebM), handoff, os_input, log.
- Risky steps are the user's: password/card/OTP fields, pay/buy/transfer/
  delete-account buttons, payment gateways, banks and CAPTCHAs are handed off
  with a notification the moment the wait starts, a "Your turn" card in the
  tab, Done / I won't, a reminder and a timeout. Send/publish/delete need Allow.
- Real mouse and keyboard on sway: a built-in virtual pointer client
  (zwlr_virtual_pointer_v1) and wtype, for Firefox/Zen trusted input and the
  browser's own UI.
- Stop from the page, the toolbar panel or `sutradhar stop`; resume only from
  the panel or a terminal.
- Tests: unit tests, end-to-end in headless Chromium, Zen and Firefox, MCP over
  stdio, and real input in a private headless sway.
