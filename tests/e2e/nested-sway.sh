#!/bin/sh
# Runs osinput.test.mjs inside a private headless sway, so the real mouse and
# keyboard tests never touch the user's desktop. Kills only its own sway.
set -eu
unset SWAYSOCK I3SOCK WAYLAND_DISPLAY DISPLAY
here=$(cd "$(dirname "$0")/../.." && pwd)
# The private runtime folder is set before the bus starts, so nothing the
# bus starts (a portal) touches the real one.
real_rt="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"   # where the user's systemd is
rt="/run/user/$(id -u)/sdt$$"
mkdir -m 700 "$rt"
# Everything runs in a systemd scope of its own, stopped at the end: what the
# bus or sway started (portals, a stray child) goes with it instead of
# outliving the run (they once sat for days). Then the FUSE folder a
# document portal may have mounted here, then the folder.
unit="sutradhar-e2e-$$"
trap 'XDG_RUNTIME_DIR="$real_rt" systemctl --user stop "$unit.scope" 2>/dev/null || true; for m in $(grep -o " $rt/[^ ]*" /proc/mounts); do fusermount3 -uz "$m" 2>/dev/null || fusermount -uz "$m" 2>/dev/null; done; rm -rf "$rt"' EXIT
trap 'exit 130' INT TERM
export XDG_RUNTIME_DIR="$rt" GTK_A11Y=none NO_AT_BRIDGE=1 GTK_USE_PORTAL=0 GDK_DEBUG=no-portals
scope=""
if XDG_RUNTIME_DIR="$real_rt" systemd-run --user --scope --collect -q -u "$unit-probe" true 2>/dev/null; then
  scope="env XDG_RUNTIME_DIR=$real_rt systemd-run --user --scope --collect -q -u $unit -- env XDG_RUNTIME_DIR=$rt"
fi
$scope dbus-run-session -- sh -eu -c '
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
