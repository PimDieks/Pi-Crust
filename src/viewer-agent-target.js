"use strict";
// The argument of the agent's tool `show_in_viewer`, the part with no dependencies (the permission logic and the Pi extension load it too):
// one text, a path of a file in the open project or a localhost address. Nothing here touches the disk or decides what may be shown; the
// main process does that (viewer-agent-logic.js). This only tells the three kinds apart, in one place, so the permission rule and the
// main-side check cannot disagree about which text is an address.
//   parse(text)  -> { kind: "invalid" } | { kind: "scheme" } | { kind: "address", url, local } | { kind: "path", text }
// The addresses that count as local are exactly the ones the app's own `isLocal` trusts (src/main.js LOCAL_HOSTS).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_TARGET = 1024; // the same limit as a project path (project-files.js MAX_PATH)
const CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
// "http:", "file:", "pi-project:" ... but "localhost:3000" and "example.com:8080/x" are host:port, not a scheme (as in viewer-open-logic.js).
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i;
// Text with no scheme that the bar would turn into a web address and that names a local host: "localhost:3000", "127.0.0.1:5173/app".
const BARE_LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;

function address(text) {
	let u;
	try {
		u = new URL(text);
	} catch {
		return { kind: "invalid" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "scheme" };
	// A name that only starts like a local one ("localhost.evil.test"), a user name in front of another host ("http://localhost@evil.test")
	// and every other IP are not local: the host, as the URL parser reads it, must be one of the three, with no user name or password.
	const local = u.username === "" && u.password === "" && LOCAL_HOSTS.has(u.hostname);
	return { kind: "address", url: u.href, local };
}

function parse(raw) {
	if (typeof raw !== "string") return { kind: "invalid" };
	const text = raw.trim();
	if (!text || text.length > MAX_TARGET || CONTROL.test(text)) return { kind: "invalid" };
	const m = SCHEME.exec(text);
	if (m && m[1].length > 1) {
		const scheme = m[1].toLowerCase();
		return scheme === "http" || scheme === "https" ? address(text) : { kind: "scheme" };
	}
	if (BARE_LOCAL.test(text)) return address("http://" + text);
	return { kind: "path", text };
}

// The port of an http(s) address, with the default of its scheme.
const portOf = (url) => {
	const u = new URL(url);
	return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
};
// The ports of the app's own Remote server, from the app context (ctx.remotePorts, set by remote-main.js): [] while there is none or it
// throws. The one place the agent tool and the remembered tabs read them from (src/main.js hands this to both).
const remotePortsOf = (ctx) => {
	try { return (ctx && typeof ctx.remotePorts === "function" ? ctx.remotePorts() : []) || []; } catch { return []; }
};

module.exports = { parse, LOCAL_HOSTS, MAX_TARGET, portOf, remotePortsOf };
