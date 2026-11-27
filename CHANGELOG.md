# Changelog

## Unreleased

- **The real-input e2e test can't leave processes behind**: `tests/e2e/nested-sway.sh` runs its private bus and headless sway in a systemd user scope of its own (`sutradhar-e2e-<pid>`), stopped when it ends, so whatever they started (a document portal, a stray child) goes with it; these once sat for days. The private `XDG_RUNTIME_DIR` is still set before the bus starts, and a FUSE mount left in it is unmounted (lazily) before it's removed. Without a user systemd it runs as before.

## 0.1.12 (2026-11-27)

- `sutradhar.service` lists both sockets in `Sockets=`, so a daemon started at login also takes them from systemd (and after them) instead of binding the paths itself.

- **`sutradhar mcp` is pranali, a 2 MB pipe, not a 78 MB Node process per
  agent.** The daemon serves MCP sessions itself on `mcp.sock` (beside its
  socket, 0600) and speaks [pranali](https://github.com/Theyashsawarkar/pranali)'s
  protocol there: a hello with the agent's name and directory, then MCP.
  `sutradhar mcp` execs `pranali sutradhar --agent <name>` when pranali is on
  PATH, falling back to the Node server (`sutradhar mcp --in-process`) when no
  daemon can be reached; without pranali it is the Node server. Same tools,
  names, gates and sessions. When the daemon restarts, pranali answers the
  calls it had ("restarted while this call was running: it may or may not
  have happened"), reconnects and replays the agent's handshake. For one
  release the daemon also accepts the `{"name"}` preamble of the short-lived
  `sutradhar-mcp` pipe, for sessions still running it; `crates/sutradhar-mcp`
  is gone.
- **systemd owns the daemon (socket activation).** `sutradhar install` adds
  `sutradhar.socket` (the main socket: browsers' hosts, the CLI) and
  `sutradhar-mcp.socket` (MCP sessions) to `sutradhar.service`, both part of
  the graphical session like the service (so no connection starts the daemon
  before DISPLAY / WAYLAND_DISPLAY exist); the daemon
  takes their listeners and starts on the first connection, and connections
  made while it restarts wait instead of failing. No pipe or host starts a
  daemon any more, so `systemctl --user stop` really stops it (stop the
  sockets too), and a crash no longer brings back one daemon per open agent.
  Without the units (a dev checkout), the CLI and the Node MCP server still
  start one.
- **One daemon, and it never removes a live socket.** A lock file in the
  runtime directory (`daemon.lock`, taken before either socket is touched)
  keeps a second daemon from starting; a leftover socket is removed only when
  connecting to it is refused (a crashed daemon's), never one systemd passed.
- **Stopping drains.** On `SIGTERM` the daemon stops accepting, refuses new
  calls with JSON-RPC error -32002 ("sutradhar is restarting; this call was
  not run, retry it"), lets running calls finish for up to 20 s, then exits
  (the unit allows 30). Connections are half-open: when an agent closes its
  side, the answers it is owed still arrive (up to 10 s), in the Node server
  too, which also now exits when the agent closes stdin.
- **Never `/tmp`.** Without `XDG_RUNTIME_DIR`, the sockets live in
  `$XDG_STATE_HOME/sutradhar/run`; the daemon, the CLI and the host refuse a
  socket directory that isn't yours alone (owner, no group/other bits).
- **The native-messaging host is Rust:** `crates/sutradhar-host` (std only,
  about 400 KB on disk, 2.4 MB resident against 68 MB for the Node host),
  built by `pnpm build` when `cargo` is there; `bin/sutradhar-host` runs it,
  else the Node host. It relays byte for byte what the Node host does
  (`JSON.stringify(JSON.parse(…))` toward the daemon, the same `part` frames
  toward the browser), and an e2e test compares the two.
- **Big frames to the browser always fit its 1 MB limit.** Parts were cut at
  512 Ki UTF-16 units, so a part of CJK text (3 bytes a character) or of
  escape-heavy text could reach 1.5 MB or more and be refused. Both hosts now
  cut parts by encoded size: each `part` message, envelope and JSON escapes
  included, is at most 1 MB of UTF-8, cut between characters (the extension
  joins them as before).
- Relative paths an agent passes (`screenshot` `save`, `page_pdf`, `record`,
  `downloads` `read`) are relative to the agent's directory (pranali's hello,
  or the CLI's); `sutradhar status` shows the MCP client's name beside each
  session.
- The website, closer to Vayu's own: the tool's screenshot blurred behind the page, a centred hero with the logo and the verse, the page you're on as the white pill, glass "On this page" and footer panels, releases as cards. No glow behind the logo, no coloured line beside the verse.
- **Spatial look** in the browser panel: graphite, rounder cards, near-white where you act, no all-caps headings.
- The website has Vayu's Spatial look: graphite glass, a floating navigation bar, near-white for links and the main button, and the tool's own colour only as its signature (the logo's glow, the shloka's line, the release dots). No more all-caps labels.
- `scripts/amo-submit.mjs` submits a release to addons.mozilla.org (listed) with
  the store build, the source archive and the listing in
  `packaging/amo-metadata.json`; the API key pair stays in
  `~/.config/sutradhar/amo.toml`. (Firefox and Zen block every extension from
  Mozilla's own sites, so this can't be done through sutradhar itself.)

## 0.1.11 (2026-11-23)

- **Pause / take over:** a Pause button on the "working here" pill, in the
  panel, and `sutradhar pause`. The border turns yellow ("Paused · you have
  control"), steps wait between each other and agents' calls wait (they don't
  fail); **Hand back** (or `sutradhar handback`) lets sutradhar carry on. Stop
  also ends a pause.
- **Site recipes:** `site_notes` keeps short notes per site about what worked
  (`~/.local/state/sutradhar/sites/`); `navigate` shows them, so the next run
  starts from what the last one learned.
- **Replays:** one recorder for the agent's `record`, the panel's "Record a
  replay" and `sutradhar record start|stop`: two frames a second plus one per
  step, pointer and captions included; a notification opens the file.
- **Network tools for testing:** `network_rules` blocks, redirects or answers
  requests with a made-up response in sutradhar's tab only (Chrome through
  the debugger's Fetch domain, Firefox and Zen through blocking webRequest).
- **Ready for addons.mozilla.org:** the manifest declares that sutradhar
  collects no data (`data_collection_permissions`, so Firefox 140+), and the
  build makes `dist/sutradhar-amo.xpi` without `update_url` (Mozilla delivers
  updates for listed add-ons). `web-ext lint`: no errors.

## 0.1.10 (2026-11-23)

- `updates.json` (Firefox/Zen self-updates) is written only by `pnpm
  release-manifest`. Before, every build rewrote it, so kosha's installed copy
  looked modified (and refused to update) and the published file lagged a
  version behind.

## 0.1.9 (2026-11-23)

- **A better pointer.** It takes the shape your own pointer would (a hand over
  links and buttons, a text cursor over fields, from the page's own CSS
  cursor), presses on clicks, and its name tag says what it's doing
  ("sutradhar · Clicking “Post”"). Key presses show as a chip. It stays put
  between steps and carries its position across page loads, so it no longer
  vanishes and pops back in another place; it fades after 8 quiet seconds.
- **A more obvious border:** a glow that breathes around the tab and a light
  running along its top edge while sutradhar works. The glow stays on
  between an agent's calls instead of flickering off and on.
- **The sutra group stays:** closing sutradhar's last tab parks it on a
  "sutradhar is idle" page; the next task reuses it.
- **Watch it:** the panel shows what sutradhar is doing now and has a "Watch
  it work" button; `sutradhar watch` brings its tab to the front.
- When an element isn't found, the error is the main page's, not an ad frame's.

## 0.1.8 (2026-11-23)

- **Rich editors keep every line.** The caret for typing went *between* the
  editor's paragraphs (selecting the whole editor and collapsing it), so on
  Firefox and Zen the first line became a loose text node that
  ProseMirror-like editors (LinkedIn's composer) dropped at the next Enter.
  The caret now goes inside the first or last paragraph's text, and typing
  lets the editor catch up before each Enter. Found when a LinkedIn post lost
  its opening line; covered by a new test editor that keeps its own model.

## 0.1.7 (2026-11-23)

- **The sutra tab group:** sutradhar works only in its own tab group, "sutra",
  in the background (Chrome, Firefox, Zen). Popups from its tabs join it.
  It never switches your tab or window; a popup that grabs the front gives
  it back to your tab.
- **Real input never lands in the wrong window:** the real mouse and keyboard
  are used only when sutradhar's tab is in front of a focused window, and the
  daemon checks the browser really has focus before typing. (Before, keys
  meant for the browser could reach the focused terminal.)
- **Hand-offs don't take your screen:** the notification goes out; "Show me"
  brings the tab forward.
- **The pointer is above modal dialogs** (it's in the browser's top layer, as
  a popover), has a "sutradhar" name tag, and scrolling is smooth with the
  pointer over what scrolls.
- Chrome renders background tabs for screenshots (focus emulation).
- `type` takes `at: "start"` to type before what's already in a field.

## 0.1.6 (2026-11-23)

- **Only risky steps wait for you.** Payments, passwords, OTPs and CAPTCHAs
  are still always yours; everything else (send, publish, delete, eval_js,
  cookies, clipboard reads, tab_attach, os_input) goes ahead without asking.
  `[approve] enabled = true`, or "Ask before…" for a site in the panel,
  brings the Allow step back.
- **You see sutradhar, never the agent:** the page says "sutradhar is working
  here", notifications say "sutradhar needs you", the panel shows what
  sutradhar is doing, not who asked.
- **A visible pointer:** it glides to each element, ripples on each click,
  rings the field it types in, and typing runs at a pace you can follow (at
  most about 4 s). Hidden tabs run at full speed without it.
- **File pickers never open:** when a page's button would open one (LinkedIn's
  "add media"), the upload step hands the page the files directly
  (`input.click()` / `showPicker()` are answered while an upload is armed).

## 0.1.5 (2026-11-23)

- Real keyboard into the browser's own dialogs: when a file picker (or print
  or permission dialog) the browser opened has focus, `os_input` keys and
  typing go to it instead of refocusing the page. Found while attaching
  images to a LinkedIn post.
- After a daemon restart, an agent session gets back the tabs the extension
  still marks as its own.

## 0.1.4 (2026-11-23)

- Background tabs: waiting for an element to settle no longer depends on
  animation frames, which Zen and Firefox throttle to about one a minute in
  tabs you aren't looking at (a click there took up to two minutes); typing
  doesn't pause between characters there either.
- An element under a sticky header or toolbar is centred and checked again
  before it's reported as covered.
- Scrolling the page finds the real scroller in apps that scroll an inner
  container (LinkedIn, Gmail…).
- Firefox and Zen update the extension by themselves from now on: the
  manifest's `update_url` points at `updates.json` in the repo, which the
  build writes for each release.

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
