#!/bin/sh
# Runs osinput.test.mjs inside a private headless sway, so the real mouse and
# keyboard tests never touch the user's desktop. Kills only its own sway.
set -eu
unset SWAYSOCK I3SOCK WAYLAND_DISPLAY DISPLAY
here=$(cd "$(dirname "$0")/../.." && pwd)
rt="/run/user/$(id -u)/sdt$$"
mkdir -m 700 "$rt"
trap 'rm -rf "$rt"' EXIT
export XDG_RUNTIME_DIR="$rt" GTK_A11Y=none NO_AT_BRIDGE=1 GTK_USE_PORTAL=0 GDK_DEBUG=no-portals
dbus-run-session -- sh -eu -c '
  cfg="$XDG_RUNTIME_DIR/sway.conf"
  printf "output HEADLESS-1 resolution 1280x900\nseat * hide_cursor 0\n" > "$cfg"
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c "$cfg" >"$XDG_RUNTIME_DIR/sway.log" 2>&1 &
  pid=$!
  for i in $(seq 50); do sock=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock 2>/dev/null | head -1); [ -n "$sock" ] && break; sleep 0.1; done
  export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep -E "^wayland-[0-9]+$" | head -1)
  status=0
  SUTRADHAR_NESTED_SWAYSOCK="$sock" node --test --test-reporter=spec "$0/tests/e2e/osinput.test.mjs" || status=$?
  kill $pid 2>/dev/null || true
  exit $status
' "$here"
status=$?
exit $status
