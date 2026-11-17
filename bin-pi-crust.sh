#!/bin/bash
# Start Pi Crust (or bring it to the front). Usage: pi-crust [repo-path]
# Without a path you pick the repo in the app; with one it opens that repo (also when already running).
# Prefers an installed Pi Crust.app (/Applications or ~/Applications; built by npm run dist:mac, or an older one made
# by hand), else runs the folder copy in ~/Documents/pi-crust.
LOG="$HOME/Library/Logs/pi-crust.log"
mkdir -p "$HOME/Library/Logs"
ARGS=()
[ -n "$1" ] && ARGS+=("--repo=$(cd "$1" && pwd)")
EXE=""
for APP in "/Applications/Pi Crust.app" "$HOME/Applications/Pi Crust.app"; do
	for BIN in "Pi Crust" "Electron"; do
		if [ -z "$EXE" ] && [ -x "$APP/Contents/MacOS/$BIN" ]; then EXE="$APP/Contents/MacOS/$BIN"; fi
	done
done
if [ -n "$EXE" ]; then
	nohup "$EXE" "${ARGS[@]}" >"$LOG" 2>&1 &
else
	cd "$HOME/Documents/pi-crust" && nohup ./node_modules/.bin/electron . "${ARGS[@]}" >"$LOG" 2>&1 &
fi
disown
