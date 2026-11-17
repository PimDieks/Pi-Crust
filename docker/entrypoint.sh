#!/bin/bash
# Start the virtual display (TigerVNC Xvnc), a window manager, noVNC behind the gate, port forwards to the host,
# then Pi Crust. Extra arguments go to Electron.
set -e
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Your Pi setup from the host (mounted read-only at /host-pi): extensions, subagents, prompts, skills, settings,
# models.json, MCP config, system prompt additions. Copied on every start, so the host stays the source of truth.
# Not copied: sessions, logins (unless PI_IMPORT_AUTH=1), bin/ (host binaries) and browser profiles.
if [ -d /host-pi ]; then
	mkdir -p /root/.pi/agent
	for d in extensions agents prompts skills themes; do
		[ -d "/host-pi/$d" ] && rsync -a --delete "/host-pi/$d/" "/root/.pi/agent/$d/"
	done
	for f in settings.json models.json mcp.json APPEND_SYSTEM.md SYSTEM.md AGENTS.md keybindings.json; do
		[ -f "/host-pi/$f" ] && cp "/host-pi/$f" "/root/.pi/agent/$f"
	done
	# Logins: copy the host's auth.json once, when the container has none yet
	if [ "${PI_IMPORT_AUTH:-0}" = "1" ] && [ -s /host-pi/auth.json ] && ! grep -q '[a-z]' /root/.pi/agent/auth.json 2>/dev/null; then
		cp /host-pi/auth.json /root/.pi/agent/auth.json && chmod 600 /root/.pi/agent/auth.json
		echo "Pi: imported the logins from the host"
	fi
	echo "Pi: using the host's Pi setup"
fi

# git: your host config (name, email, aliases; mounted at /host-gitconfig) plus overrides for things that only work on
# the host: commit signing through a Mac program and the macOS keychain credential helper.
{
	[ -f /host-gitconfig ] && printf '[include]\n\tpath = /host-gitconfig\n'
	printf '[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[credential]\n\thelper =\n'
} > "${GIT_CONFIG_GLOBAL:=/root/.gitconfig-container}"
export GIT_CONFIG_GLOBAL

# HOST_PORTS=5432,9092,3000: localhost:<port> in here reaches <port> on the host (services in other containers or on
# your computer), so a repo's config with localhost URLs works unchanged. Don't list a port something in here listens on.
IFS=', ' read -ra PORTS <<< "${HOST_PORTS:-}"
for port in "${PORTS[@]}"; do
	if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
		echo "HOST_PORTS: skipping '$port' (not a port number)"
		continue
	fi
	socat "TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr" "TCP:${HOST_ADDR:-host.docker.internal}:$port" &
	echo "localhost:$port -> ${HOST_ADDR:-host.docker.internal}:$port"
done

# Xvnc on loopback only (the browser reaches it through the gate): resizes to the browser window
# (AcceptSetDesktopSize) and sends only real copies to the clipboard (SendPrimary=0).
Xvnc :99 -localhost -geometry "${SCREEN:-1600x1000}" -depth 24 -rfbport 5900 -SecurityTypes None -AlwaysShared \
	-AcceptSetDesktopSize=1 -SendPrimary=0 -SetPrimary=0 -desktop "Pi Crust" >/tmp/xvnc.log 2>&1 &
for i in $(seq 100); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
if [ ! -e /tmp/.X11-unix/X99 ]; then
	echo "Xvnc didn't start:"
	tail -20 /tmp/xvnc.log
	exit 1
fi
vncconfig -nowin & # clipboard sync between X and VNC clients
openbox &
# A session bus keeps Chromium's D-Bus errors out of the log
eval "$(dbus-launch --sh-syntax)" 2>/dev/null || true
websockify --web /usr/share/novnc 127.0.0.1:6090 localhost:5900 >/dev/null 2>&1 &
# The gate on :6080: only localhost pages may connect (see gate.js)
node /opt/pi-crust/docker/gate.js &
echo "Pi Crust: open http://localhost:${PORT:-6080}/"

cd /opt/pi-crust
# --no-sandbox: Chromium's sandbox can't run as root in a container. Restart the app when it quits.
while true; do
	./node_modules/.bin/electron . --no-sandbox --disable-dev-shm-usage "$@" || true
	[ "${PI_CRUST_RESTART:-1}" = "1" ] || break
	sleep 1
done
