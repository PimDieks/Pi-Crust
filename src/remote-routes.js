// Remote access: what the HTTP server serves and accepts. Pure helpers (no Electron, no sockets) so they can be unit-tested.
"use strict";

const path = require("node:path");

const file = (...p) => path.join(__dirname, ...p);

// Exact URL -> file. User input is only ever a lookup key, never part of a path.
const STATIC = Object.freeze({
	"/": { file: file("remote", "index.html"), type: "text/html; charset=utf-8" },
	"/index.html": { file: file("remote", "index.html"), type: "text/html; charset=utf-8" },
	"/app.js": { file: file("remote", "app.js"), type: "text/javascript; charset=utf-8" },
	"/style.css": { file: file("remote", "style.css"), type: "text/css; charset=utf-8" },
	"/sw.js": { file: file("remote", "sw.js"), type: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": { file: file("remote", "manifest.webmanifest"), type: "application/manifest+json" },
	"/icon.svg": { file: file("remote", "icon.svg"), type: "image/svg+xml" },
	"/icon.png": { file: file("remote", "icon.png"), type: "image/png" },
	"/vendor/marked.js": { file: file("..", "node_modules", "marked", "lib", "marked.umd.js"), type: "text/javascript; charset=utf-8" },
	"/vendor/purify.js": { file: file("..", "node_modules", "dompurify", "dist", "purify.min.js"), type: "text/javascript; charset=utf-8" },
});

function resolveStatic(pathname) {
	return typeof pathname === "string" && Object.hasOwn(STATIC, pathname) ? STATIC[pathname] : null;
}

const CHAT = "(chat-\\d{1,9})";
const UIID = "([\\w.:-]{1,128})";
const ROUTES = [
	["POST", /^\/api\/pair$/, "pair", []],
	["POST", /^\/api\/unpair$/, "unpair", []],
	["GET", /^\/api\/state$/, "state", []],
	["GET", /^\/api\/events$/, "events", []],
	["POST", /^\/api\/chats$/, "newChat", []],
	["GET", new RegExp(`^/api/chats/${CHAT}/messages$`), "messages", ["id"]],
	["POST", new RegExp(`^/api/chats/${CHAT}/prompt$`), "prompt", ["id"]],
	["POST", new RegExp(`^/api/chats/${CHAT}/abort$`), "abort", ["id"]],
	["POST", new RegExp(`^/api/chats/${CHAT}/held/take$`), "heldTake", ["id"]],
	["POST", new RegExp(`^/api/chats/${CHAT}/ui/${UIID}$`), "ui", ["id", "reqId"]],
	["POST", new RegExp(`^/api/chats/${CHAT}/restart$`), "restart", ["id"]],
	["GET", new RegExp(`^/api/chats/${CHAT}/settings$`), "settings", ["id"]],
	["POST", new RegExp(`^/api/chats/${CHAT}/settings$`), "setSettings", ["id"]],
	["POST", /^\/api\/push\/subscribe$/, "pushSubscribe", []],
	["POST", /^\/api\/push\/unsubscribe$/, "pushUnsubscribe", []],
];

// -> { name, params } | null. A known path with the wrong method is null too (the server answers 404).
function matchRoute(method, pathname) {
	for (const [m, re, name, keys] of ROUTES) {
		if (m !== method) continue;
		const hit = re.exec(String(pathname));
		if (hit) return { name, params: Object.fromEntries(keys.map((k, i) => [k, hit[i + 1]])) };
	}
	return null;
}

// Host header values we answer to (blocks DNS rebinding). `tailscale serve` may or may not keep the Host header,
// so the real protection for writes is the Origin + custom-header check.
function allowedHosts({ mode, port, httpsPort = 443, tailnetHost, lanAddress } = {}) {
	const set = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	if (mode === "tailscale" && tailnetHost) {
		const h = String(tailnetHost).toLowerCase();
		set.add(h);
		if (httpsPort !== 443) set.add(`${h}:${httpsPort}`);
	}
	if (mode === "lan" && lanAddress) set.add(`${lanAddress}:${port}`.toLowerCase());
	return set;
}

function allowedOrigins({ mode, port, httpsPort = 443, tailnetHost, lanAddress } = {}) {
	const set = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
	if (mode === "tailscale" && tailnetHost) set.add(`https://${String(tailnetHost).toLowerCase()}${httpsPort === 443 ? "" : `:${httpsPort}`}`);
	if (mode === "lan" && lanAddress) set.add(`http://${lanAddress}:${port}`.toLowerCase());
	return set;
}

const checkHost = (hostHeader, set) => typeof hostHeader === "string" && set.has(hostHeader.toLowerCase());
// A missing Origin fails: browsers always send it on cross-site POSTs, and our own page does too.
const checkOrigin = (originHeader, set) => typeof originHeader === "string" && set.has(originHeader.toLowerCase());

// Private LAN IPv4 only: 10/8, 172.16/12, 192.168/16. Not Tailscale's 100.64/10, not link-local, not internal.
function isPrivateLan(addr) {
	const p = String(addr).split(".").map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

// Adapters that carry VPN/VM/container traffic, not the Wi-Fi or Ethernet a phone can reach.
const VIRTUAL_NAME = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|^br-|^veth|^utun|^tun|^tap|^wg|^zt|tailscale|vpn|npcap|loopback/i;
const PHYSICAL_NAME = /wi-?fi|wlan|ethernet|^en[01]$|^eth|^wlan/i;

// -> [{ name, address }]: private IPv4 on real adapters, likely physical ones first (the sort is stable).
function listLanCandidates(networkInterfaces) {
	const out = [];
	for (const [name, list] of Object.entries(networkInterfaces || {})) {
		if (VIRTUAL_NAME.test(name)) continue;
		for (const a of list || []) {
			if ((a.family === "IPv4" || a.family === 4) && !a.internal && isPrivateLan(a.address)) out.push({ name, address: a.address });
		}
	}
	return out.map((c, i) => ({ c, i, r: PHYSICAL_NAME.test(c.name) ? 0 : 1 })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

function pickLanAddress(networkInterfaces, preferred) {
	const all = listLanCandidates(networkInterfaces);
	if (preferred && all.some((c) => c.address === preferred)) return preferred;
	return all[0]?.address || null;
}

// 127.0.0.0/8: where the server listens behind `tailscale serve`.
const isLoopback = (addr) => /^127\.\d+\.\d+\.\d+$/.test(String(addr));

function readJson(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let done = false;
		const fail = (status, error) => {
			if (done) return;
			done = true;
			reject({ status, error });
		};
		req.on("data", (c) => {
			if (done) return;
			size += c.length;
			if (size > limit) {
				chunks.length = 0;
				req.pause?.(); // stop reading; the server answers 413 with Connection: close and drops the socket
				fail(413, "Request too large");
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (done) return;
			done = true;
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) return resolve({});
			try {
				const v = JSON.parse(text);
				if (!v || typeof v !== "object" || Array.isArray(v)) return reject({ status: 400, error: "Expected a JSON object" });
				resolve(v);
			} catch {
				reject({ status: 400, error: "Invalid JSON" });
			}
		});
		req.on("error", () => fail(400, "Request failed"));
	});
}

const SECURITY_HEADERS = Object.freeze({
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

const PAGE_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Slash commands that only make sense on the desktop (mirrors BUILTIN_COMMANDS and TERMINAL_ONLY in slash.js, plus /remote).
// /compact is not here: the phone maps it onto the RPC command.
const DESKTOP_ONLY_COMMANDS = new Set([
	"reload", "new", "resume", "model", "thinking", "name", "session", "fork", "rewind", "clone", "export", "copy", "quit", "remote",
	"settings", "scoped-models", "login", "logout", "llama", "tree", "import", "share", "bug", "trust", "hotkeys", "changelog",
]);

// "/name rest of the text" -> { name, arg } | null. Paths like "/usr/bin" aren't commands.
function parseSlash(text) {
	const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
	return m ? { name: m[1].toLowerCase(), arg: (m[2] || "").trim() } : null;
}

// Permission modes of the permission-modes extension (switched with /mode <id>).
const PERMISSION_MODES = new Set(["plan", "ask-edits", "ask-commands", "trusted"]);

module.exports = {
	PERMISSION_MODES,
	STATIC,
	resolveStatic,
	matchRoute,
	allowedHosts,
	allowedOrigins,
	checkHost,
	checkOrigin,
	isPrivateLan,
	isLoopback,
	listLanCandidates,
	pickLanAddress,
	readJson,
	SECURITY_HEADERS,
	PAGE_CSP,
	DESKTOP_ONLY_COMMANDS,
	parseSlash,
};
