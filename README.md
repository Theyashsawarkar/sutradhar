<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="sutradhar" src="assets/banner-dark.svg" width="560">
  </picture>
</p>

<!-- identity -->
<p align="center">
  <b>मत्तः परतरं नान्यत्किञ्चिदस्ति धनञ्जय ।<br>
  मयि सर्वमिदं प्रोतं सूत्रे मणिगणा इव ॥</b><br>
  <i>There is nothing higher than me, Dhanañjaya: all this is strung on me, like pearls on a thread.</i><br>
  <sub>Bhagavad Gītā 7.7</sub>
</p>
<!-- /identity -->

<p align="center">
  <b>Let any AI agent use your real browser, the way you do.</b><br>
  One extension for Chrome, Firefox and Zen, one local daemon, and an MCP server every agent can talk to.
  Payments, passwords and one-time codes stay yours.
</p>

<p align="center">
  <a href="https://github.com/Theyashsawarkar/sutradhar/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Theyashsawarkar/sutradhar?color=b4befe&label=release"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-cba6f7"></a>
  <img alt="Platform: Linux" src="https://img.shields.io/badge/platform-linux-89b4fa">
  <img alt="Written in TypeScript" src="https://img.shields.io/badge/written%20in-typescript-a6e3a1">
</p>

**Sūtradhāra** (सूत्रधार) is "the holder of the strings": the director who opens
and runs every Sanskrit drama. Here the agent writes the play and sutradhar
holds the strings: it moves the browser for the agent, and hands the stage back
to you whenever a step is yours.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Using it from an agent](#using-it-from-an-agent)
- [Your turn: what the agent never does](#your-turn-what-the-agent-never-does)
- [Tools](#tools)
- [Command line](#command-line)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Security](#security)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## What it does

- **Everything a person does in a browser.** Open, switch and close tabs and
  windows; read a page as a tree of controls or as Markdown; click, double-click,
  right-click, hover, drag; type, press keys and chords; fill forms, pick
  options, tick boxes; upload files and drop them on drop zones; download
  files and read them; save a page as PDF; answer alert/confirm/prompt
  dialogs; search bookmarks and history; record a GIF of what happened.
- **Pages as they really are.** Shadow DOM (open and closed), cross-origin
  iframes, rich editors (contenteditable, ProseMirror, CodeMirror, Monaco),
  React/Vue controlled inputs, elements hidden under overlays (reported, not
  clicked blindly), infinite scroll.
- **Real mouse and keyboard when a page needs them.** Chrome gets trusted input
  through its debugger protocol. On Firefox and Zen, synthetic events cover most
  pages; when a page ignores them, sutradhar repeats the click with a real
  pointer (a virtual pointer device on sway) and real keys (wtype). The same
  hands reach what no extension may touch: the address bar, the browser's menus,
  permission prompts, file pickers.
- **Any agent.** Claude Code, Codex, opencode, Gemini, anything that speaks MCP,
  and scripts through `sutradhar call`.
- **Several browsers at once.** Chrome, Chromium, Brave, Firefox and Zen can all
  be connected; each agent picks one.
- **Safe by default.** Page text reaches the agent marked untrusted. Risky steps
  go to you. One Stop ends everything. Every action is logged.

## Install

### Requirements

| What | Why |
|---|---|
| Linux, Node.js 22.18+ | the daemon, the native-messaging host, the MCP server |
| Chrome / Chromium / Brave 116+, Firefox 128+ or Zen | the browser it drives |
| `notify-send` (libnotify) and a notification server | "your turn" notifications |
| sway (or another wlroots compositor), `wtype` | real mouse and keyboard (optional) |
| `wl-copy` / `wl-paste` | the clipboard tool |
| `ffmpeg` | `record` (GIF/WebM) |
| `pdftotext` (poppler) | reading downloaded PDFs (optional) |

### Steps

```sh
git clone https://github.com/Theyashsawarkar/sutradhar ~/.local/share/sutradhar-src
cd ~/.local/share/sutradhar-src
pnpm install && pnpm build
ln -s "$PWD/bin/sutradhar" ~/.local/bin/sutradhar
sutradhar install          # native-messaging hosts for every browser found + the user service
```

Then add the extension to each browser (`sutradhar install` prints these paths):

- **Chrome, Chromium, Brave:** `chrome://extensions` → Developer mode → **Load
  unpacked** → `dist/chrome`.
- **Zen:** `about:addons` → gear → **Install Add-on From File…** →
  `dist/sutradhar-firefox.xpi` (Zen accepts unsigned add-ons).
- **Firefox:** use the signed `.xpi` from a [release](https://github.com/Theyashsawarkar/sutradhar/releases);
  while developing, `about:debugging` → **Load Temporary Add-on** → `dist/firefox/manifest.json`.

Check it with `sutradhar doctor`. In [Vayu](https://github.com/Theyashsawarkar/vayu)
it is a [kosha](https://github.com/Theyashsawarkar/kosha) package (`kosha install sutradhar`)
and [vishvakarma](https://github.com/Theyashsawarkar/vishvakarma) gives its MCP server to every agent.

### Adding it to an agent by hand

```sh
claude mcp add sutradhar -- sutradhar mcp --name claude
codex mcp add sutradhar -- sutradhar mcp --name codex
```

Any other MCP client: command `sutradhar`, arguments `mcp --name <agent>`.

## Using it from an agent

A typical run:

1. `navigate` to a URL (it opens a tab in the agent's own tab group if it has none).
2. `snapshot` to read the page; every control has a ref like `e12` (`f3:e7` inside a frame):
   ```
   - page "Sign in" https://example.com/login
     - main
       - heading "Sign in" [level=1]
       - textbox "Email" [ref=e4] [required]
       - textbox "Password" [ref=e5] [required]
       - button "Continue" [ref=e6]
   ```
3. `act` with a list of steps:
   ```json
   {"steps": [{"do": "type", "ref": "e4", "value": "me@example.com"},
              {"do": "click", "ref": "e6"}],
    "why": "log in to check my order"}
   ```
4. `snapshot` again after the page changes.

Agents work only in their own tabs (and popups those open). To use one of
yours, an agent asks with `tab_attach`, and you approve it.

## Your turn: what the agent never does

The page itself checks every step, whatever the agent asked for. These are
**handed to you**:

- typing into password, card, CVV, expiry, OTP / one-time-code, PIN, UPI PIN,
  bank account or IFSC fields;
- buy, pay, place order, checkout, transfer, send money, subscribe, delete
  account and similar buttons, and submitting a form that holds card details;
- anything on a payment gateway or bank page (Razorpay, Stripe Checkout,
  PayPal, PayU, Paytm, PhonePe, Cashfree, Juspay, the big Indian banks…), and
  CAPTCHAs (reCAPTCHA, hCaptcha, Cloudflare Turnstile).

What happens:

1. **A notification goes out the moment the wait starts:** "claude needs you:
   Complete the payment yourself on example.com", with **Show me**, **Done**
   and **I won't**.
2. The tab comes to the front with a **yellow border** and a **Your turn** card
   on the page, saying what to do and why the agent wanted it.
3. You do it in the page, then press **Done** (on the card, in the toolbar
   panel or in the notification). The agent gets `handoff-done` and carries on;
   **I won't** tells it to stop and ask you.
4. A reminder after 5 minutes; after 15 the agent is told you didn't finish.

Agents can also hand you a step themselves with the `handoff` tool (log in,
solve a CAPTCHA, approve a 2FA prompt).

**Send, publish, post, delete, merge, accept, book** and similar buttons are a
lighter case: you press **Allow** and the agent clicks it. So are `eval_js`,
reading cookies or the clipboard, `tab_attach` and `os_input`. A site you
trust can skip the question (toolbar panel, or [settings](#settings)).

The card's buttons live in a closed shadow root and only answer real clicks,
so a page can't press **Done** or **Allow** for you.

## Tools

| Tool | Does |
|---|---|
| `browsers` | list connected browsers, pick one |
| `tabs`, `tab_open`, `tab_close`, `tab_focus`, `tab_update` | tabs (pin, mute, zoom, duplicate) |
| `tab_attach` | borrow one of your tabs (you approve) |
| `navigate` | URL, back, forward, reload; waits for the load |
| `snapshot` | the page as roles, names, states and refs (frames and shadow DOM included) |
| `page_text` | the main content as Markdown |
| `screenshot` | viewport, full page or one element |
| `find` | elements by text, name, role or CSS |
| `act` | click, hover, move, type, press, select, check, fill, clear, focus, scroll, drag, upload, wait |
| `dialog` | how to answer the next alert/confirm/prompt |
| `eval_js` | run JavaScript (you approve) |
| `console_read`, `network_read` | the page's console and requests |
| `wait_for` | text, element, gone, URL, network idle, download |
| `downloads` | list, start, wait, read |
| `page_pdf` | save as PDF |
| `window` | list, new (private) window, resize, maximize |
| `clipboard` | set; read (you approve) |
| `bookmarks`, `history`, `cookies` | browser data (cookies: you approve) |
| `record` | GIF or WebM of a tab |
| `handoff` | give a step to you and wait |
| `os_input` | real mouse and keyboard on the browser window (you approve) |
| `log` | the session's recent actions |

Everything Claude in Chrome's tools did maps here: `read_page` → `snapshot`,
`get_page_text` → `page_text`, `computer` → `act` + `screenshot`, `form_input` →
`act fill`, `javascript_tool` → `eval_js`, `gif_creator` → `record`,
`browser_batch` → `act`, `tabs_context_mcp` → `tabs`, `select_browser` → `browsers`.

## Command line

```
sutradhar status              what's connected: browsers, agent sessions, waiting steps
sutradhar stop                stop every agent now
sutradhar resume              let stopped agents carry on (from a terminal)
sutradhar log [-n N]          recent actions
sutradhar call TOOL [JSON]    call a tool as an agent would
sutradhar tools               the tools agents get
sutradhar install | uninstall | doctor
sutradhar mcp [--name NAME]   the MCP server (agents start this)
sutradhar daemon | host       the daemon; the native-messaging host
```

**Stop** is also the red button in the toolbar panel and on the page while an
agent acts. In Vayu, **Super+Shift+Escape** runs `sutradhar stop` from anywhere.
A stopped agent's calls fail with "the user pressed Stop" until you resume
(panel, or `sutradhar resume` in a terminal).

## Settings

`~/.config/sutradhar/config.toml` (all optional):

```toml
[handoff]
timeout_minutes = 15
reminder_minutes = 5
extra_hosts = ["pay.mybank.example"]   # more payment/bank hosts: every action there is yours

[approve]
timeout_minutes = 5

[os_input]
enabled = true       # real mouse/keyboard for Firefox/Zen and browser UI
auto_retry = true    # repeat a click the page ignored with the real mouse

[notify]
enabled = true

[sites."github.com"]
approve = "allow"    # send/publish/delete without asking here ("ask", "deny")
eval = "ask"
cookies = "deny"
```

The toolbar panel edits the `approve` and `eval` rules for the site you're on.

| Environment | |
|---|---|
| `SUTRADHAR_SOCKET` | the daemon's socket (default `$XDG_RUNTIME_DIR/sutradhar/sock`) |
| `SUTRADHAR_AGENT` | the agent's name for `mcp` and `call` |
| `SUTRADHAR_BROWSER` | the browser agents use first when several are connected (`zen`, `chrome`…) |
| `SUTRADHAR_NO_OS_INPUT` | turn the real mouse/keyboard off |

Files: the log is `~/.local/state/sutradhar/log.jsonl`; downloads saved by
`page_pdf` and `record` go to `~/Downloads/sutradhar/`.

## How it works

```
 agent ──MCP──▶ sutradhar mcp ─╮
 script ─────▶ sutradhar call ─┤  tRPC over a unix socket (0600)
                               ▼
                     sutradhar daemon  ── sessions, tab ownership, risk gates,
                               ▲          notifications, log, real mouse/keyboard
          tRPC over native messaging (through `sutradhar host`)
                               │
                  extension (Chrome MV3 / Firefox MV2)
                   background: tabs, downloads, CDP input
                   content script in every frame: snapshot, refs, actions,
                   risk checks, dialog guard, the "Your turn" card
```

- **tRPC on every hop.** One set of zod schemas is the input of each procedure
  and of each MCP tool, so the tool list can't drift from the code. Both ends
  serve a router: the extension serves `browserRouter` (the daemon calls it),
  the daemon serves `hub` (the extension calls it) and `agent` (agents call it),
  over one framed, two-way link (`packages/protocol/src/rpc.ts`).
- **Native messaging, not a localhost port.** Any website can reach a localhost
  port; only this extension's ID can start the native host.
- **Input.** Chrome: CDP `Input.*` (trusted). Firefox/Zen: synthetic events done
  carefully (`execCommand` for typing, so frameworks see it), and the real
  pointer/keyboard when needed. Firefox's popup blocker ignores synthetic clicks
  on new-tab links, so those open the way the click would have.
- **Dialogs** are answered in the page (alert: OK; confirm/prompt: Cancel unless
  the agent set an answer with `dialog`), so they never freeze an agent tab, and
  Chrome's debugger answers any that slip through. Outside agent tabs nothing
  changes.

Design notes are in [docs/adr](docs/adr/).

## Security

- Page content reaches agents inside `<untrusted>` blocks, and the MCP
  instructions tell them it is data, never orders.
- Password, card and OTP values never appear in snapshots, and the agent can't
  type into those fields.
- The socket is `0600` in your runtime dir; browsers may only call the browser
  side, agents only the agent side. A local program running as you can still
  reach the socket: sutradhar guards against web pages and misled agents, not
  against malware already on your account. `sutradhar resume` refuses to run
  without a terminal, so an agent's shell can't undo your Stop.

## Development

```sh
pnpm install
pnpm build          # dist/: daemon bundle, dist/chrome, dist/firefox, the .xpi
pnpm typecheck
pnpm test           # unit tests (vitest)
pnpm e2e            # Chromium, Zen and Firefox in throwaway headless profiles, plus MCP
tests/e2e/nested-sway.sh   # real mouse/keyboard in a private headless sway (never your desktop)
```

The end-to-end tests run every tool against a local fixture site with the hard
cases (shadow DOM, cross-origin frames, dialogs, uploads, drag and drop, fake
payment and password pages with made-up data). They never touch your real
browser, profile, daemon or desktop.

## Troubleshooting

- **"No browser is connected"**: the extension isn't installed, or the native
  host isn't: run `sutradhar doctor`. In the browser, the toolbar panel says
  whether it reached the daemon.
- **The panel says "Not connected"**: `sutradhar install` again (the host
  manifest must point at this checkout), then restart the browser.
- **Chrome shows "is debugging this browser"**: that's how Chrome gives trusted
  input; it goes away 20 seconds after the agent's last action.
- **A click on Firefox/Zen did nothing**: pass `trusted: true` on the step, or
  check `os_input.enabled` (needs sway and `wtype`).
- **Firefox won't install the .xpi**: release Firefox only takes signed add-ons;
  use the release's signed file, or Zen.

## License

[MIT](LICENSE)
