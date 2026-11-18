#!/usr/bin/env bash
# Installs what Pi Crust needs and is missing: Node.js, Git and Pi. macOS (Homebrew). Used by the app's "Install" button
# after a confirm; same protocol as install-pi.ps1.
#
#   --needs node,git,pi   what to install (always done in that order); the app decides what is missing
#   --dry-run             print "WOULD <id>: <command>" and change nothing: no brew, no npm is started
#
# Output, one line each: STEP <id>: <title> | DONE <id> | FAIL <id>: <why> | WOULD <id>: <command> | RESULT ok / dry-run
# Exit codes: 0 worked, 1 a step failed, 2 bad --needs, 3 Homebrew is missing (the app then shows the manual steps).
# This script never installs Homebrew itself.
set -u

NEEDS=""
DRY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--needs) NEEDS="${2:-}"; shift 2 ;;
		--needs=*) NEEDS="${1#--needs=}"; shift ;;
		--dry-run) DRY=1; shift ;;
		*) echo "FAIL args: not understood: $1"; exit 2 ;;
	esac
done

# Keep in step with PLAN in src/health-install.js (scripts/install-pi.test.js compares the two).
title_of() {
	case "$1" in
		node) echo "Node.js (current)" ;;
		git) echo "Git" ;;
		pi) echo "Pi, the coding agent" ;;
	esac
}
command_of() {
	case "$1" in
		node) echo "brew install node" ;;
		git) echo "brew install git" ;;
		pi) echo "npm install -g @earendil-works/pi-coding-agent --allow-scripts=koffi,protobufjs,@google/genai" ;;
	esac
}

wanted=",$(echo "$NEEDS" | tr -d ' ' | tr 'A-Z' 'a-z'),"
bad=""
IFS=',' read -r -a parts <<< "$(echo "$NEEDS" | tr -d ' ' | tr 'A-Z' 'a-z')"
for p in "${parts[@]:-}"; do
	[ -z "$p" ] && continue
	case "$p" in node|git|pi) ;; *) bad="$bad $p" ;; esac
done
ids=""
for id in node git pi; do
	case "$wanted" in *",$id,"*) ids="$ids $id" ;; esac
done
if [ -n "$bad" ] || [ -z "$ids" ]; then
	if [ -n "$bad" ]; then echo "FAIL args: --needs must be a list of node, git, pi (not understood:$bad)"; else echo "FAIL args: --needs must be a list of node, git, pi (nothing was asked for)"; fi
	exit 2
fi

if [ "$DRY" = 1 ]; then
	for id in $ids; do echo "WOULD $id: $(command_of "$id")"; done
	echo "RESULT dry-run (nothing was changed)"
	exit 0
fi

# Homebrew lives outside the default PATH of an app started from the Dock.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for id in $ids; do
	echo "STEP $id: $(title_of "$id")"
	tool="$(command_of "$id" | cut -d' ' -f1)"
	if ! command -v "$tool" >/dev/null 2>&1; then
		if [ "$tool" = "brew" ]; then
			echo "FAIL $id: Homebrew was not found on this computer"
			exit 3
		fi
		echo "FAIL $id: npm was not found (Node.js is not installed yet)"
		exit 1
	fi
	# shellcheck disable=SC2046
	$(command_of "$id") 2>&1
	code=$?
	if [ "$code" -ne 0 ]; then
		echo "FAIL $id: exit $code"
		exit 1
	fi
	echo "DONE $id"
done
echo "RESULT ok"
exit 0
