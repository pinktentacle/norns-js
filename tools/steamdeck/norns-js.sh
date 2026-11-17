#!/usr/bin/env bash
# Launch norns-js on a Steam Deck: start the server, open a browser on it,
# and stop the server again when the browser closes.
#
# Put this file next to serve.py and app/, make it executable, and add it to
# Steam as a non-Steam game. Launching it from the library then launches the
# instrument.
#
#   chmod +x norns-js.sh
#
# WHY PYTHON AND NOT NODE: SteamOS ships Python and does not ship Node, and
# its root filesystem is immutable -- `pacman -S nodejs` does not survive a
# system update. Nothing needs installing for this to work.
#
# WHY A WRAPPER AND NOT JUST THE BROWSER: the page cannot be opened as a
# file. It needs two response headers or there is no audio engine at all, so
# something has to serve it. See serve.py.
#
# CONTROLLER LAYOUT, which is the one thing that is easy to get wrong: in
# Game Mode, set this shortcut's controller layout to a GAMEPAD template.
# The default for a non-Steam shortcut is often a desktop layout, which
# sends keyboard and mouse events -- and a browser then sees no gamepad at
# all, so none of the stick-and-button mapping exists. "Gamepad with Mouse
# Trackpad" is the one to pick (controller settings -> Browse Configs ->
# Templates): sticks and buttons reach the page, and the right trackpad
# still moves a pointer for the toolbar. Set that trackpad's CLICK to Left
# Mouse while you are there -- it is also the gesture that starts the audio,
# since a gamepad button is not a user gesture as far as a browser is
# concerned.
#
# The layout belongs to the SHORTCUT, not to the browser, so it has to be
# set on this entry. And if the pad is not seen at all, a Flatpak browser
# may be sandboxed away from the controller device:
#
#   flatpak override --user --filesystem=/run/udev:ro com.google.Chrome
#
# That is a permanent permission change to that app, so it is documented
# rather than done here.
#
# NOT RUN ON A STEAM DECK. Written from SteamOS's documented shape; the
# server underneath it is measured and works.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${NORNS_JS_PORT:-8080}"
URL="http://localhost:${PORT}/"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "no python3 on PATH — SteamOS normally has one" >&2
  exit 1
fi

"$PY" "$HERE/serve.py" "$HERE/app" "$PORT" &
SERVER=$!
# The server dies with this script however the script ends, including when
# the browser is closed from Game Mode's own menu.
trap 'kill "$SERVER" 2>/dev/null || true' EXIT INT TERM

# Wait for it to answer rather than sleeping a guess: a cold Deck takes
# longer than a warm one, and a browser that opens too early shows a
# connection error that looks like a broken install.
for _ in $(seq 1 100); do
  if curl -sf -o /dev/null "$URL"; then break; fi
  sleep 0.1
done

# The first browser that is actually installed. Chromium-based first: every
# measurement in this project was made on one, and Firefox is unverified.
run_flatpak() { flatpak info "$1" >/dev/null 2>&1; }

if run_flatpak com.google.Chrome; then
  flatpak run com.google.Chrome --app="$URL" --start-fullscreen
elif run_flatpak org.chromium.Chromium; then
  flatpak run org.chromium.Chromium --app="$URL" --start-fullscreen
elif run_flatpak com.brave.Browser; then
  flatpak run com.brave.Browser --app="$URL" --start-fullscreen
elif run_flatpak com.microsoft.Edge; then
  flatpak run com.microsoft.Edge --app="$URL" --start-fullscreen
elif run_flatpak org.mozilla.firefox; then
  flatpak run org.mozilla.firefox --kiosk "$URL"
elif command -v chromium >/dev/null 2>&1; then
  chromium --app="$URL" --start-fullscreen
elif command -v firefox >/dev/null 2>&1; then
  firefox --kiosk "$URL"
else
  echo "no browser found. Install one from Discover, then run this again." >&2
  echo "The server is up at $URL — open it yourself if you have one elsewhere." >&2
  wait "$SERVER"
fi
