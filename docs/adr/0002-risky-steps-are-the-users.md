# 2. Risky steps are the user's, checked in the page

Date: 2026-11-23. Status: accepted.

## Decision

Payments, passwords, card numbers, OTPs, CAPTCHAs and account deletion are
never done by an agent. The content script classifies every step against the
element it will touch (field type, autocomplete, names and labels, the
button's accessible name, the page's host) and the daemon gates it, so it
doesn't depend on the agent asking. Two levels:

- **handoff**: the user does the step; the agent gets done / declined / timeout.
- **approve**: the user says Allow and the agent does it (send, publish,
  delete, merge, book, eval_js, cookies, clipboard read, tab_attach, os_input).

The notification goes out the moment the wait starts; the tab comes forward
with a "Your turn" card whose buttons only answer trusted clicks.

## Consequences

Word lists can miss a site's wording or catch a harmless button; site rules in
config.toml and the panel adjust `approve`, and `extra_hosts` adds payment
hosts. A local process as the same user can still reach the daemon's socket.
