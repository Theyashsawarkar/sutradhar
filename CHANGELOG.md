# Changelog

## Unreleased

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
