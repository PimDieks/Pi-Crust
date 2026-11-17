#!/bin/sh
# Replace an installed Pi Crust.app with a freshly built one (macOS). Used by scripts/update.js and the in-app
# updater (src/update-main.js).
# Usage: mac-install-app.sh <new.app> <installed.app> [pid-to-wait-for|-] [open]
#   pid: wait until that process (the running Pi Crust) has exited first, so it never runs a half-replaced bundle.
#   open: start the new version afterwards.
# The old bundle is kept as <installed>.old until the new one is in place, and put back if the copy fails.
NEW=$1
DEST=$2
WAIT=${3:--}
OPEN=$4
LOG="$HOME/Library/Logs/pi-crust-update.log"
mkdir -p "$HOME/Library/Logs"
exec >>"$LOG" 2>&1
echo "--- $(date): install $NEW -> $DEST (wait for ${WAIT})"

if [ "$WAIT" != "-" ]; then
	while kill -0 "$WAIT" 2>/dev/null; do sleep 0.3; done
fi
[ -d "$NEW" ] || { echo "not found: $NEW"; exit 1; }

TMP="$DEST.updating"
mkdir -p "$(dirname "$DEST")"
rm -rf "$TMP" "$DEST.old"
if ! ditto "$NEW" "$TMP"; then
	echo "copy failed"
	rm -rf "$TMP"
	exit 1
fi
if [ -e "$DEST" ] && ! mv "$DEST" "$DEST.old"; then
	echo "cannot move the old app aside (no write access to $(dirname "$DEST")?)"
	rm -rf "$TMP"
	exit 1
fi
if mv "$TMP" "$DEST"; then
	rm -rf "$DEST.old"
	xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
	echo "installed"
else
	echo "install failed, putting the old app back"
	[ -e "$DEST.old" ] && mv "$DEST.old" "$DEST"
	exit 1
fi
[ "$OPEN" = "open" ] && open "$DEST"
exit 0
