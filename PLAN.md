# sutradhar — plan

> **Sūtradhāra** (सूत्रधार), "holder of the strings": the director who opens
> and runs every Sanskrit drama. The command is `sutradhar`. The shloka is
> chosen and verified against a real text at release, never from memory.

A browser extension plus a local server that lets **any AI agent** (Claude
Code, Codex, opencode, Gemini, a shell script) use the user's real browser the
way the user does: read pages, click, type, move the mouse, upload, download,
handle dialogs, manage tabs. Anything risky (payments, passwords, OTPs) it
stops, notifies the user at once, and waits for the user to do it. It replaces
Claude in Chrome.

---

## 1. Goals and non-goals

**Goals**

1. Everything Claude in Chrome does today (parity list in §6), then more.
2. Everything a person at the browser can do, mouse and keyboard included,
   down to the browser's own menus (§4.3, §5).
3. Any agent, not just Claude: MCP for agents, a CLI for scripts.
4. **Chrome, Firefox and Zen** from one codebase (Chromium and Brave come free
   with Chrome's build). Several browsers connected at once.
5. Safe by default: page text is untrusted, risky steps go to the user,
   everything is logged, one key stops it all.

**Non-goals**

- No model inside the extension or the server. The agent is the brain; we are
  the hands and eyes.
- No cloud relay. Everything stays on this machine.
- No stored passwords. The agent never reads or types a password, card number
  or OTP.

---

## 2. Architecture

```
 ╭──────────────╮  MCP (stdio)   ╭──────────────────────────────╮
 │ Claude Code  │───────────────▶│ sutradhar mcp    (thin client)  │──╮
 │ Codex, Gemini│                ╰──────────────────────────────╯  │
 ╰──────────────╯                ╭──────────────────────────────╮  │ tRPC over
 ╭──────────────╮  CLI           │ sutradhar call <tool> '{json}'  │──┤ unix socket
 │ scripts      │───────────────▶╰──────────────────────────────╯  │ $XDG_RUNTIME_DIR/
 ╰──────────────╯                                                  │ sutradhar/sock (0600)
                                 ╭─────────────────────────────────▼──────────╮
                                 │ sutradhar daemon  (systemd --user, Node/TS)   │
                                 │  • registry of connected browsers & tabs   │
                                 │  • sessions (one per agent), tab locks     │
                                 │  • policy, risk rules, hand-offs           │
                                 │  • notifications (akashvani)               │
                                 │  • files: uploads in, downloads out        │
                                 │  • OS-level mouse & keyboard (§4.3)        │
                                 ╰──────▲──────────────────────────▲──────────╯
                                        │ unix socket (tRPC)       │
                          ╭─────────────┴────────╮   ╭─────────────┴────────╮
                          │ sutradhar host (Zen)    │   │ sutradhar host (Chrome) │   native-messaging
                          ╰─────────────▲────────╯   ╰─────────────▲────────╯   hosts: dumb pipes,
                                        │ stdio, length-prefixed JSON          started by the browser
                          ╭─────────────┴────────────────────────────────────╮
                          │ Extension (one per browser)                      │
                          │  background: tRPC router, tabs, downloads, CDP   │
                          │  content scripts (every frame): snapshot, refs,  │
                          │    actions, dialog guards, overlay               │
                          │  side panel: activity, your-turn queue, policy,  │
                          │    stop, about                                   │
                          ╰──────────────────────────────────────────────────╯
```

### 2.1 tRPC: yes, and it decides the language

tRPC only works when **both ends are TypeScript** (its whole value is the
caller importing the other side's router *type*). The extension is TypeScript
whatever we do, so using tRPC means the daemon is TypeScript too. That's a
good trade here:

| For TypeScript + tRPC | Against |
|---|---|
| One set of **zod** schemas: the tRPC procedure input *is* the MCP tool's input schema (the official MCP TypeScript SDK takes zod directly). Change a field once, every hop type-checks. | Breaks the Go habit of narada/sangam/vaikhari (no shared Go UI kit; the daemon has no TUI, so little is lost). |
| Official MCP SDK is TypeScript-first. | Needs Node at runtime (a kosha `requires`), where Go gave one static binary. |
| Extension internals (background ↔ content scripts ↔ side panel) use tRPC too (`trpc-chrome`-style link over `runtime` ports). One RPC style everywhere. | tRPC is client→server shaped; our main traffic is daemon→extension, so the roles are set up deliberately (below). |
| Subscriptions carry the event streams (console, network, dialogs, downloads, hand-off results). | Custom links needed for native messaging and the unix socket (small: framing + JSON). |

**Decided (2026-11-23): TypeScript everywhere, tRPC on every hop, on
Node 26** (already installed; runs TypeScript directly, so no build step for
the daemon) with a **pnpm** workspace. Not Bun: it isn't installed and would
add a dependency for no real gain here.

How the routers sit (two-way over one connection):

- **`browserRouter`, served by the extension**, called by the daemon:
  `snapshot`, `act`, `screenshot`, `tabs.*`, `downloads.*`… (the daemon is
  the client). Mutations for actions, queries for reads.
- **`hubRouter`, served by the daemon**, called by the extension:
  `hello` (browser, profile, version), `events` (subscription-in-reverse:
  the extension pushes), `handoff.done`, `policy.get/set`, `log.list`.
- **`agentRouter`, served by the daemon**, called by `sutradhar mcp` and
  `sutradhar call`: the agent-facing API (§6). MCP tools are generated from it,
  so the MCP list can't drift from the code.
- One custom tRPC link speaks "length-prefixed JSON frames, both directions,
  multiplexed by id" over stdio (native messaging) and over the unix socket.

Native messaging rather than a localhost WebSocket: any website can reach a
localhost port; only our extension ID can open a native-messaging host. It
also keeps the Chrome MV3 service worker alive while connected.

### 2.2 Sessions

- Each agent connection is a **session** named after the agent ("claude",
  "codex"), shown in the log, side panel, notifications and the page badge.
- Tabs a session opens go into a coloured **tab group** named after it
  (Chrome `tabGroups`; Firefox/Zen tab-group API where present, else a title
  prefix). A session acts only in its own tabs unless the user lends one
  (`tab_attach`).
- A tab is **locked** to one session while it acts.

---

## 3. Seeing a page

1. **Snapshot** (main tool): an accessibility-style tree of what a person
   sees: role, name, value, state, and a **ref** (`f<frame>:e<n>`) for
   anything you can act on. Refs live in a per-frame `WeakRef` map with a
   generation number; a stale ref fails clearly ("take a new snapshot"),
   never clicks the wrong thing. Walks shadow DOM (closed roots through CDP on
   Chrome) and every frame, same- or cross-origin. Visible part by default,
   `full:true` for the whole page, `root:ref` to zoom in, long lists cut.
   Password, card and OTP field values never appear.
2. **Text**: the page as clean Markdown.
3. **Screenshot**: viewport, full page or one element, optional ref labels.
4. **Find**: by text, role, label or CSS; returns refs.

All page text goes back wrapped in `<untrusted>…</untrusted>`, like narada and
ekatva; the MCP instructions say it's data, never orders.

---

## 4. Acting on a page

### 4.1 One `act` tool, a list of steps

Steps run in order, stop at the first failure, and return what changed:
`click` (left/right/middle, double, modifiers) · `hover` · `move` (mouse to a
point or along a path) · `type` · `press` (keys, chords) · `select` · `check`
· `fill` (many fields) · `clear` · `scroll` · `drag` (mouse drags and HTML5
drag-and-drop) · `upload` · `focus` · `wait` · `click_at`/`type_at`
(coordinates, for canvas apps and browser UI).

Before acting: scroll into view, check visible, enabled and not covered (says
what covers it), wait for it to stop moving.

### 4.2 Input sites believe, per browser

| Browser | Page input | Trusted? |
|---|---|---|
| **Chrome** (and Chromium, Brave) | `chrome.debugger` + CDP `Input.dispatch*`, `insertText`, `setFileInputFiles` | Yes. Chrome shows a "being debugged" bar; we attach only while acting. |
| **Firefox, Zen** | Synthetic events in the right order (pointer→mouse→focus→click, `beforeinput`/`input` with the native value setter so React/Vue see it, `DataTransfer` for drops/uploads) | No (`isTrusted:false`); fine for nearly every site. |
| **Firefox, Zen**, when a site needs trusted input | The daemon's OS-level mouse and keyboard (§4.3), or WebDriver BiDi if the browser runs with remote debugging | Yes |

The extension picks the path itself: it tries page input, and if the site
ignored it (nothing changed, or the fixture-proven `isTrusted` signals),
retries through the OS path and says so in the result.

### 4.3 OS-level mouse and keyboard (on)

For what no extension may script: the browser's own menus, address bar,
permission prompts, `about:`/`chrome://` pages, extension stores, the native
file picker and print dialog, and sites that demand trusted input. The daemon
drives sway's **virtual pointer and keyboard** (wlroots protocols), mapping
page coordinates to the screen from the window's geometry (`swaymsg -t
get_tree`), the page's screen offset and `devicePixelRatio`.

Because it moves the real cursor: it only acts on the agent's own focused
browser window, shows the page badge while doing it, pauses if the user moves
the mouse or types (the user always wins), and is logged like everything
else. Other desktops (X11, GNOME, KDE) come later; Phase 0 picks the
implementation (`wlrctl` vs a small helper).

---

## 5. Everything a person can do

✅ the agent does it · 🙋 handed to the user (§7) · 🔐 asks the user first

| Area | What | How |
|---|---|---|
| **Tabs & windows** | list, open, close, switch, reload, back/forward, duplicate, pin, mute, move, new window, resize, zoom, tab groups | ✅ |
| **Reading** | snapshot, Markdown, screenshot, find, selected text, PDFs in the browser | ✅ |
| | console messages, network requests | ✅ CDP on Chrome; `webRequest` + console hook on Firefox/Zen |
| | cookies, local storage | 🔐 per site |
| **Mouse & keyboard** | click, double, right, middle, hover, move, drag, scroll, keys, chords, typing | ✅ §4 |
| **Forms** | inputs, selects, checkboxes, radios, date pickers, rich editors (contenteditable, ProseMirror, CodeMirror, Monaco), submit | ✅ |
| **Files** | upload local files, drop zones | ✅ |
| | downloads: start, wait, list, read | ✅ |
| | save as PDF, print | ✅ |
| **Dialogs** | alert, confirm, prompt, "leave site?" | ✅ (Firefox/Zen: guard at `document_start` so a dialog never freezes the browser) |
| **Clipboard** | copy, paste | ✅ / 🔐 to read |
| **Browser data** | bookmarks, history | ✅ |
| **Waiting** | element, text, URL, navigation, network idle, download, new tab | ✅ |
| **Pages & JS** | run JavaScript | 🔐 per site |
| **Recording** | GIF/WebM, replayable action trace | ✅ |
| **Browser UI** | menus, address bar, settings pages, permission prompts, file picker, print dialog | ✅ OS-level (§4.3) |
| **Multiple browsers** | Chrome, Firefox and Zen connected at once | ✅ |
| **Risky steps** | payments, card/UPI/bank details, passwords, OTP/2FA, CAPTCHAs, final buy/pay/transfer clicks, account deletion | 🙋 |
| **Consequential steps** | send mail/message, publish, delete, accept terms | 🔐 the user says yes, then the agent clicks |

---

## 6. MCP tools (≈25)

| Tool | Does |
|---|---|
| `browsers` | list connected browsers/profiles; pick one for this session |
| `tabs`, `tab_open`, `tab_close`, `tab_focus` | — |
| `tab_attach` | 🔐 borrow one of the user's tabs |
| `navigate` | URL, back, forward, reload; waits for load |
| `snapshot`, `page_text`, `screenshot`, `find` | §3 |
| `act` | §4.1 |
| `dialog` | answer an alert/confirm/prompt/leave-site |
| `downloads`, `page_pdf` | — |
| `eval_js` | 🔐 |
| `console_read`, `network_read`, `wait_for` | — |
| `window`, `clipboard`, `bookmarks`, `history`, `record` | — |
| `handoff` | 🙋 give a step to the user and wait (§7) |
| `log` | this session's recent actions |

**Parity with Claude in Chrome**: `tabs_context_mcp`→`tabs`,
`tabs_create/close`→`tab_open/close`, `navigate`, `read_page`→`snapshot`,
`get_page_text`→`page_text`, `find`, `computer`→`act`+`screenshot`,
`form_input`→`act fill`, `javascript_tool`→`eval_js`,
`read_console_messages`/`read_network_requests`, `resize_window`→`window`,
`file_upload`/`upload_image`→`act upload`, `gif_creator`→`record`,
`browser_batch`→`act`, `list_connected_browsers`/`select_browser`/
`switch_browser`→`browsers`. Each has a test (Phase 2 gate).

CLI mirrors it: `sutradhar call snapshot '{"tab":118}'`, plus
`sutradhar status | log | stop | policy | doctor | install`.

---

## 7. Safety and the user's turn

### 7.1 Hand-off: the user does the risky step

The agent never does a 🙋 step itself, **and it doesn't depend on the agent
being polite**: the extension checks every `act` step and refuses one that
types into a password/card/OTP field, or clicks a buy/pay/place-order/transfer/
delete-account control, or lands on a known payment page (Razorpay, Stripe,
PayU, bank and UPI pages, card iframes). Instead it opens a hand-off, the same
as the agent calling `handoff` itself:

1. **The notification fires at the very start** of the wait, through
   akashvani: *"claude needs you: complete the payment on amazon.in"*, with
   the reason from the agent. Clicking it raises the browser and focuses the
   tab.
2. The tab comes to the front, the step is highlighted, the page border turns
   **yellow** (waiting on you), and the side panel shows **Your turn** with
   what to do and two buttons: **Done** and **I won't**.
3. The agent's call blocks (no busy polling). A reminder notification after 5
   minutes; after the timeout (default 15 min, set per call) the agent gets
   `"timeout: the user didn't finish"`.
4. When the user presses Done, the agent gets `done`, a fresh snapshot, and
   anything the user typed in the panel's optional answer box (never a
   password). **I won't** returns `declined`, and the agent must stop that
   task.
5. While waiting, the agent keeps no hold on the page: the user's mouse and
   keyboard are theirs.

### 7.2 Approvals: the user says yes, the agent does it

For 🔐 steps (send, publish, delete, `eval_js`, cookies, `tab_attach`): the same
notification at once, the panel shows the exact action and the agent's `why`,
**Allow** / **Deny**. Never claimed done unless the reply says so.

### 7.3 The rest

- **Site policy** (`~/.config/sutradhar/policy.toml`, edited in the panel): per
  site allow/ask/deny for read, act, `eval_js`, cookies; a list of payment
  and bank domains that are always hand-off.
- **Visible while working**: accent border and a badge ("claude is acting ·
  Stop"); the session's tab group coloured.
- **One stop for everything**: Stop on the page and in the panel, a browser
  shortcut (in keybind-search), and `sutradhar stop`. Ends every session,
  releases locks, detaches debugger, frees the mouse.
- **Action log** in `~/.local/state/sutradhar/log.jsonl`, in the panel and
  `sutradhar log`.
- **Lock-down**: socket 0600 in `$XDG_RUNTIME_DIR`; host manifests list only
  our extension IDs; no network listener.

---

## 8. Repository (`~/personal/sutradhar`, public, kosha package)

```
packages/protocol/      zod schemas + router types shared by every package
packages/daemon/        hub: registry, sessions, locks, policy, handoffs,
                        notifications, OS input, agentRouter
packages/cli/           sutradhar binary: daemon | host | mcp | call | stop | log …
packages/trpc-link/     framed two-way tRPC link (stdio + unix socket)
extension/              WXT project, builds Chrome MV3 + Firefox MV3
  src/background/       browserRouter, tabs, downloads, cdp, events
  src/content/          snapshot, refs, actions/, risk.ts, dialogs, overlay
  src/sidepanel/        activity, Your turn, approvals, policy, stop, about
tests/fixtures/         local site with the hard cases (§9)
tests/e2e/              drives throwaway browsers through the real stack
packaging/              native-host manifests, systemd unit, kosha
assets/logo.svg, site.toml, docs/, README.md, CHANGELOG.md, CLAUDE.md
```

`sutradhar install` writes native-host manifests for every browser found
(Chrome `~/.config/google-chrome/NativeMessagingHosts`, Chromium, Brave,
Firefox and Zen `~/.mozilla/native-messaging-hosts`; Zen's path confirmed in
Phase 0), enables `sutradhar.service`, and says how to add the extension.

Distribution: Firefox and Zen need a signed `.xpi`, signed through AMO as
**unlisted** (free; AMO keys in `~/.config/sutradhar/amo.toml`, never in git).
Chrome: the Chrome Web Store (unlisted) or load-unpacked in developer mode.

---

## 9. Testing (never the user's real browser or desktop)

- **Fixture site** with the hard cases: React/Vue controlled inputs, shadow
  DOM, cross-origin iframes, all dialog kinds, drag-and-drop, uploads and drop
  zones, canvas, `isTrusted` checkers, infinite scroll, popups, downloads,
  basic auth, rich editors, covered elements, and **fake** payment, OTP and
  password pages to prove hand-off triggers (made-up data only).
- **E2E** on throwaway profiles: Chrome for Testing / Chromium
  (`--headless=new --user-data-dir=$tmp --load-extension`; branded Chrome no
  longer accepts `--load-extension`), Firefox and Zen through `web-ext run`
  with temp profiles. A test daemon on its own socket, akashvani faked.
- **OS-level input** only in a headless nested sway, killed by PID, never
  `swaymsg exit`.
- Unit tests (Vitest) for routers, locks, policy, risk rules, snapshot/refs.

---

## 10. Phases

| # | Phase | Delivers | Exit gate |
|---|---|---|---|
| 0 | **Spikes** | native messaging in Zen, Firefox, Chrome; xpi signing; MV3 worker staying alive; tRPC two-way link over stdio; CDP infobar; Firefox tab groups; OS input on sway (`wlrctl` vs helper) | answers in `docs/spikes.md` |
| 1 | **Skeleton** | protocol, daemon, host, link, extension handshake, `mcp`/`call`; `browsers`, `tabs`, `tab_open`, `navigate`, `screenshot`, `page_text`; install, systemd | an agent opens and reads a page in Chrome, Firefox and Zen |
| 2 | **Parity** | snapshot + refs, `find`, `act`, `eval_js`, console/network, `window`, upload, `record`, multi-browser | Claude-in-Chrome parity suite green → agents switch over, Claude in Chrome disabled |
| 3 | **Hand-off & safety** | risk rules, `handoff`, approvals, akashvani notifications, side panel (Your turn, approvals, policy, stop), overlay, log, stop shortcut | fake payment/OTP fixtures always hand off; notification fires at start |
| 4 | **Beyond parity** | dialogs, downloads, `page_pdf`, clipboard, bookmarks/history, `wait_for`, tab groups, locks, rich editors | every ✅ row green on the fixtures |
| 5 | **OS-level hands** | virtual pointer/keyboard, browser-UI actions, trusted-input fallback, user-wins pause | browser-UI fixtures pass in nested sway |
| 6 | **Release** | name, logo, verified shloka, README, site, CHANGELOG, kosha, vishvakarma `mcp.toml`, signed xpi, keybind-search entry, public repo | `keybind-search.py --check` OK, release tagged |

