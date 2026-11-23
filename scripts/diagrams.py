#!/usr/bin/env python3
"""Generates the README's diagrams as SVG (assets/diagrams/*.svg).

    python3 scripts/diagrams.py           # write them
    python3 scripts/diagrams.py --check   # exit 1 if they'd change

Each SVG carries both themes (Catppuccin Latte and Mocha) through
prefers-color-scheme, has rounded corners everywhere, and uses system fonts.
Standard library only.
"""
import html
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "diagrams")

LIGHT = dict(bg="#eff1f5", panel="#e6e9ef", card="#ffffff", line="#bcc0cc", text="#4c4f69", sub="#6c6f85",
             accent="#8839ef", green="#40a02b", yellow="#df8e1d", red="#d20f39")
DARK = dict(bg="#1e1e2e", panel="#181825", card="#313244", line="#585b70", text="#cdd6f4", sub="#a6adc8",
            accent="#cba6f7", green="#a6e3a1", yellow="#f9e2af", red="#f38ba8")


def colours(c):
    """Every colour rule for one theme (plain values: no CSS variables, so any SVG renderer gets them)."""
    return f"""
    text {{ fill: {c['text']}; }}
    .bg {{ fill: {c['bg']}; }}
    .panel {{ fill: {c['panel']}; stroke: {c['line']}; }}
    .card {{ fill: {c['card']}; stroke: {c['line']}; }}
    .s, .lbl {{ fill: {c['sub']}; }}
    .lbl {{ stroke: {c['bg']}; }}
    .edge {{ stroke: {c['sub']}; }}
    .edge.accent {{ stroke: {c['accent']}; }} .edge.yellow {{ stroke: {c['yellow']}; }} .edge.green {{ stroke: {c['green']}; }}
    .life {{ stroke: {c['line']}; }}
    .accentfill {{ fill: {c['accent']}; }} .yellowfill {{ fill: {c['yellow']}; }} .greenfill {{ fill: {c['green']}; }} .subfill {{ fill: {c['sub']}; }}
    .ring-accent {{ stroke: {c['accent']}; }} .ring-yellow {{ stroke: {c['yellow']}; }} .ring-green {{ stroke: {c['green']}; }} .ring-red {{ stroke: {c['red']}; }}
    .lbl-accent {{ fill: {c['accent']}; }} .lbl-yellow {{ fill: {c['yellow']}; }} .lbl-green {{ fill: {c['green']}; }} .lbl-red {{ fill: {c['red']}; }}"""


STYLE = """
  <style>
    text { font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif; }
    .panel, .card { stroke-width: 1.2; }
    .title { font-size: 15px; font-weight: 700; }
    .h { font-size: 13.5px; font-weight: 650; }
    .t { font-size: 12.5px; }
    .s { font-size: 11.5px; }
    .mono { font-family: ui-monospace, "JetBrains Mono", "Noto Sans Mono", monospace; font-size: 11.5px; }
    .edge { stroke-width: 1.6; fill: none; }
    .edge.dash { stroke-dasharray: 5 4; }
    .life { stroke-width: 1.4; stroke-dasharray: 4 5; }
    .ring-accent, .ring-yellow, .ring-green, .ring-red { stroke-width: 2; }
    .lbl { font-size: 11.5px; paint-order: stroke; stroke-width: 5px; stroke-linejoin: round; }""" + colours(LIGHT) + """
    @media (prefers-color-scheme: dark) {""" + colours(DARK) + """
    }
  </style>"""

ARROWS = """
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="subfill"/></marker>
    <marker id="aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="accentfill"/></marker>
    <marker id="ay" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="yellowfill"/></marker>
    <marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="greenfill"/></marker>
  </defs>"""

MARK = {"": "a", "accent": "aa", "yellow": "ay", "green": "ag"}


def esc(s):
    return html.escape(s, quote=True)


class SVG:
    def __init__(self, w, h, title, desc):
        self.w, self.h = w, h
        self.parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-labelledby="t d">',
            f'  <title id="t">{esc(title)}</title>',
            f'  <desc id="d">{esc(desc)}</desc>',
            STYLE, ARROWS,
            f'  <rect class="bg" x="0" y="0" width="{w}" height="{h}" rx="18"/>',
        ]

    def add(self, s):
        self.parts.append("  " + s)

    def box(self, x, y, w, h, cls="card", rx=12, ring=""):
        self.add(f'<rect class="{cls} {ring}" x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/>')

    def text(self, x, y, s, cls="t", anchor="start", extra=""):
        self.add(f'<text class="{cls} {extra}" x="{x}" y="{y}" text-anchor="{anchor}">{esc(s)}</text>')

    def lines(self, x, y, items, cls="t", gap=17, anchor="start"):
        for i, s in enumerate(items):
            self.text(x, y + i * gap, s, cls, anchor)

    def arrow(self, d, color="", dash=False, both=False):
        m = MARK[color]
        start = f' marker-start="url(#{m})"' if both else ""
        self.add(f'<path class="edge {color} {"dash" if dash else ""}" d="{d}" marker-end="url(#{m})"{start}/>')

    def label(self, x, y, s, color="", anchor="middle", bold=False):
        cls = "lbl" + (f" lbl-{color}" if color else "")
        weight = ' font-weight="650"' if bold else ""
        self.add(f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}"{weight}>{esc(s)}</text>')

    def save(self, name):
        self.parts.append("</svg>")
        return name, "\n".join(self.parts) + "\n"


# ---------------------------------------------------------------- architecture
def architecture():
    s = SVG(1000, 860, "sutradhar architecture",
            "Agents talk MCP to sutradhar mcp, which talks tRPC to the daemon over a unix socket; the daemon talks tRPC "
            "to the extension in each browser through native messaging; the extension acts in web pages; risky steps "
            "go to the user through notifications and a Your turn card; real mouse and keyboard go through sway.")
    W = 1000
    s.text(30, 44, "sutradhar: how a request travels", "title")
    s.text(30, 64, "Every hop is tRPC with the same zod schemas; arrows show who calls whom.", "s")

    # Row 1: agents
    s.box(30, 84, 690, 110, "panel", 16)
    s.text(48, 108, "AI agents", "h")
    for i, (h, sub) in enumerate([("Claude Code", "any account, any vesha profile"), ("Codex · opencode · Gemini", "every MCP client"), ("Scripts", "sutradhar call TOOL '{json}'")]):
        x = 48 + i * 224
        s.box(x, 120, 208, 58)
        s.text(x + 14, 144, h, "h")
        s.text(x + 14, 164, sub, "s")

    # Row 2: thin clients
    s.box(150, 240, 210, 52, "card", 12, "ring-accent")
    s.text(255, 262, "sutradhar mcp", "h", "middle")
    s.text(255, 280, "MCP server on stdio", "s", "middle")
    s.box(420, 240, 210, 52, "card", 12, "ring-accent")
    s.text(525, 262, "sutradhar call", "h", "middle")
    s.text(525, 280, "the CLI, same API", "s", "middle")
    s.arrow("M152 178 L220 240")
    s.arrow("M376 178 L280 240")
    s.arrow("M600 178 L540 240")
    s.label(120, 220, "MCP (stdio)", anchor="start")

    # Row 3: daemon
    s.box(30, 340, 690, 200, "panel", 16, "ring-accent")
    s.text(48, 366, "sutradhar daemon", "h")
    s.text(186, 366, "systemd user service · one per login · $XDG_RUNTIME_DIR/sutradhar/sock (0600)", "s")
    chips = [
        ("Sessions", "one per agent; its own tabs", "and tab group; locks"),
        ("Risk gates", "pay, passwords, OTPs:", "the user does it"),
        ("Notifications", "sent the moment a", "wait starts (akashvani)"),
        ("Action log", "every call, its result,", "~/.local/state/sutradhar"),
        ("Stop / resume", "one Stop cancels every", "call in every browser"),
        ("Real input", "virtual pointer + wtype", "for trusted clicks, browser UI"),
    ]
    for i, (h, a, b) in enumerate(chips):
        col, row = i % 3, i // 3
        x, y = 48 + col * 224, 382 + row * 76
        s.box(x, y, 208, 64)
        s.text(x + 14, y + 22, h, "h")
        s.text(x + 14, y + 40, a, "s")
        s.text(x + 14, y + 55, b, "s")
    s.arrow("M255 292 L255 340", "accent")
    s.arrow("M525 292 L525 340", "accent")
    s.label(268, 322, "tRPC  agent.*", "accent", "start", True)
    s.label(538, 322, "unix socket", "accent", "start")

    # Right column: the user, notifications, sway
    s.box(760, 84, 210, 200, "panel", 16, "ring-yellow")
    s.text(778, 108, "You", "h")
    s.lines(778, 130, ["Notification: “sutradhar needs", "you”, with Show me · Done ·", "I won’t", "", "In the tab: the yellow", "Your turn card, the panel,", "the Stop button; the page", "shows sutradhar, not the agent"], "s", 16)
    s.box(760, 340, 210, 96, "panel", 16)
    s.text(778, 364, "sway (Wayland)", "h")
    s.lines(778, 384, ["virtual pointer device", "wtype virtual keyboard", "window geometry"], "s", 16)
    s.arrow("M720 410 L760 400")
    s.arrow("M720 380 C 740 300, 740 250, 760 230", "yellow")
    s.label(748, 318, "notify", "yellow", "end")

    # Row 4: hosts
    s.arrow("M150 540 L150 584", "accent", both=True)
    s.arrow("M375 540 L375 584", "accent", both=True)
    s.arrow("M600 540 L600 584", "accent", both=True)
    s.label(612, 566, "tRPC both ways: browserRouter ⇄ hub.*", "accent", "start", True)
    for x in (70, 295, 520):
        s.box(x, 584, 160, 40, "card", 10)
        s.text(x + 80, 609, "sutradhar host", "mono", "middle")
    s.lines(722, 596, ["native messaging (stdio):", "only this extension's ID", "may start the host;", "frames over 1 MB are split"], "s", 15)
    s.arrow("M150 624 L150 664", both=True)
    s.arrow("M375 624 L375 664", both=True)
    s.arrow("M600 624 L600 664", both=True)

    # Row 5: browsers
    browsers = [("Chrome · Chromium · Brave", "MV3 service worker", "input through CDP (trusted)"),
                ("Firefox", "MV2 background page", "synthetic events + real input"),
                ("Zen", "MV2 background page", "synthetic events + real input")]
    for i, (h, a, b) in enumerate(browsers):
        x = 46 + i * 225
        s.box(x, 664, 208, 104, "panel", 14)
        s.text(x + 14, 688, h, "h")
        s.text(x + 14, 707, a, "s")
        s.text(x + 14, 723, b, "s")
        s.box(x + 12, 734, 184, 24, "card", 8)
        s.text(x + 104, 751, "content script in every frame", "s", "middle")
    s.arrow("M940 436 V716 H708", "", True)
    s.label(932, 694, "real clicks and keys", anchor="end")

    # Row 6: pages
    s.box(30, 790, 690, 50, "panel", 14)
    s.text(48, 820, "Web pages", "h")
    s.text(150, 820, "snapshot with refs · act · dialogs answered · risky fields and buttons checked · Your turn card", "s")
    for x in (150, 375, 600):
        s.arrow(f"M{x} 768 L{x} 790", both=True)
    s.box(760, 790, 210, 50, "card", 14, "ring-red")
    s.text(778, 813, "Never done by an agent", "h")
    s.text(778, 830, "pay · passwords · OTP · CAPTCHA", "s")
    return s.save("architecture.svg")


# ---------------------------------------------------------------- sequences
def sequence(name, title, desc, actors, steps, height, notes=()):
    cols = len(actors)
    W = 1000
    left, right = 130, W - 130
    xs = [left + i * (right - left) / (cols - 1) for i in range(cols)]
    s = SVG(W, height, title, desc)
    s.text(30, 40, title, "title")
    for (label, sub, ring), x in zip(actors, xs):
        s.box(x - 74, 58, 148, 50, "card", 12, ring)
        s.text(x, 80, label, "h", "middle")
        s.text(x, 98, sub, "s", "middle")
        s.add(f'<line class="life" x1="{x}" y1="108" x2="{x}" y2="{height - 30}"/>')
    y = 140
    for st in steps:
        kind = st[0]
        if kind == "msg":
            _, a, b, text, color = st[:5]
            sub = st[5] if len(st) > 5 else None
            x1, x2 = xs[a], xs[b]
            if a == b:
                s.arrow(f"M{x1} {y - 6} h46 v18 h-40", color)
                s.label(x1 + 54, y + 2, text, color, "start")
                y += 40
                continue
            d = 1 if x2 > x1 else -1
            s.arrow(f"M{x1 + 4 * d} {y} L{x2 - 4 * d} {y}", color, dash=st[-1] == "reply")
            s.label((x1 + x2) / 2, y - 8, text, color, "middle", True)
            if sub and sub != "reply":
                s.label((x1 + x2) / 2, y + 15, sub, "", "middle")
                y += 14
            y += 40
        elif kind == "note":
            _, a, b, text, ring = st
            need = len(text) * 6.9 + 36
            cx = (xs[a] + xs[b]) / 2
            half = max((max(xs[a], xs[b]) - min(xs[a], xs[b])) / 2 + 70, need / 2)
            x1, x2 = cx - half, cx + half
            if x2 > W - 20:
                x1, x2 = x1 - (x2 - W + 20), W - 20
            if x1 < 20:
                x1, x2 = 20, x2 + (20 - x1)
            s.box(x1, y - 16, x2 - x1, 28, "card", 10, ring)
            s.text((x1 + x2) / 2, y + 3, text, "t", "middle")
            y += 40
        elif kind == "gap":
            y += st[1]
    for x, yy, text in notes:
        s.text(x, yy, text, "s")
    return s.save(name)


def act_flow():
    A = [("Agent", "Claude, Codex…", ""), ("sutradhar mcp", "MCP server", "ring-accent"), ("Daemon", "sessions, gates", "ring-accent"),
         ("Extension", "background", ""), ("Page", "content script", "")]
    steps = [
        ("msg", 0, 1, 'act {steps: [click "Save"], why}', ""),
        ("msg", 1, 2, "tRPC agent.act", "accent", "unix socket"),
        ("msg", 2, 2, "this session owns the tab? not stopped?", ""),
        ("msg", 2, 3, "tRPC page.act", "accent", "native messaging"),
        ("msg", 3, 4, "prepare(target)", ""),
        ("note", 4, 4, "find · scroll into view · visible? covered? risk?", ""),
        ("msg", 4, 3, "element, point, risk = none", "", "reply"),
        ("msg", 3, 4, "input: CDP (Chrome) · events or real mouse (Firefox/Zen)", "green"),
        ("msg", 3, 2, "results, URL, dialogs seen", "", "reply"),
        ("msg", 2, 1, "logged, returned", "", "reply"),
        ("msg", 1, 0, "1. click: ok — clicked \"Save\"", "", "page text inside <untrusted>"),
    ]
    return sequence("act-flow.svg", "One act call, end to end",
                    "An agent's act call goes through the MCP server and the daemon to the extension, which prepares the "
                    "element in the page, checks its risk, sends the input, and returns the result.", A, steps, 600)


def handoff_flow():
    A = [("Agent", "asked to buy", ""), ("Daemon", "gate", "ring-accent"), ("Browser", "extension + page", ""), ("You", "at your desk", "ring-yellow")]
    steps = [
        ("msg", 0, 1, 'act: type into "Card number"', ""),
        ("msg", 1, 2, "page.act", "accent"),
        ("note", 2, 2, "risk = hand-off: a card field", "ring-yellow"),
        ("msg", 2, 1, "hub.gate (the step is NOT run)", "yellow"),
        ("msg", 1, 3, "notification at once: “sutradhar needs you”", "yellow", "Show me · Done · I won’t"),
        ("msg", 1, 2, "show the Your turn card, bring the tab forward", "yellow"),
        ("msg", 3, 2, "you type the card and pay yourself", "green"),
        ("msg", 3, 2, "Done (card, panel or notification)", "green"),
        ("msg", 2, 1, "hub.resolve: done", "green", "reply"),
        ("msg", 1, 0, "[handoff-done] the user did this step", "green", "reply"),
        ("gap", 4),
        ("note", 0, 3, "No answer: a reminder at 5 minutes, “timeout” at 15 · I won’t: “declined”, the agent stops and asks", ""),
        ("note", 0, 3, "Everything else goes ahead without asking (approvals can be turned on in settings)", ""),
    ]
    return sequence("handoff-flow.svg", "Your turn: a payment step",
                    "When an agent's step touches a card, password, OTP or pay button, the page refuses it, the daemon "
                    "notifies you at once and shows a Your turn card; you do it and press Done, and the agent is told.",
                    A, steps, 640)


def main():
    check = "--check" in sys.argv
    os.makedirs(OUT, exist_ok=True)
    changed = 0
    for name, content in (architecture(), act_flow(), handoff_flow()):
        path = os.path.join(OUT, name)
        old = open(path).read() if os.path.exists(path) else None
        if old != content:
            changed += 1
            if not check:
                open(path, "w").write(content)
    print(f"assets/diagrams: 3 diagrams, {changed} changed")
    if check and changed:
        sys.exit(1)


if __name__ == "__main__":
    main()
