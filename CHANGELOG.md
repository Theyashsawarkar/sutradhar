# Changelog

## 0.1.3 (2026-11-23)

- `sutradhar call` keeps one session per terminal (or per `SUTRADHAR_SESSION`)
  between calls, so a script or an agent without MCP keeps its tabs. It ends
  after 30 idle minutes.

## 0.1.2 (2026-11-23)

- README: the install steps per browser (Zen's signing switch, Chrome's
  unpacked folder, Firefox's temporary add-on) and a full "How it works":
  three generated SVG diagrams (the pieces, one call end to end, a hand-off),
  light and dark, from `scripts/diagrams.py`.
- The README points agents to the `sutradhar` skill in vishvakarma.
- Zen shows as Zen: the native host tells the daemon which program started
  it, since Zen calls itself Firefox to extensions.

- Docs and `sutradhar install`: Zen needs `xpinstall.signatures.required`
  set to `false` in about:config before it takes the unsigned .xpi (its
  default is `true`, like Firefox's, but Zen honours the switch).

- Docs: Vayu's global Stop key is Super+Shift+Delete (Shift+Esc types `~` in
  Vayu's keymap).

## 0.1.1 (2026-11-23)

- Notifications use the logo from the install itself; `sutradhar install` no
  longer writes into `~/.local/share/sutradhar`, which is where kosha keeps the
  package.

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
