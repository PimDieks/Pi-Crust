// Gate in front of websockify (noVNC page + VNC over WebSocket), the only thing published on port 6080.
// WebSockets aren't covered by CORS, so without this any web page in your browser could open
// ws://localhost:6080/websockify and type into Pi Crust. Requests are only let through when
//  - Host is localhost / 127.0.0.1 / [::1] (or a name in ALLOWED_HOSTS), which stops DNS rebinding, and
//  - a WebSocket's Origin is one of those hosts too, which stops other sites.
// Everything else is answered with 403. Plain Node, no dependencies.
"use strict";

const http = require("node:http");
const net = require("node:net");

const LISTEN_PORT = Number(process.env.GATE_PORT || 6080);
const TARGET_PORT = Number(process.env.GATE_TARGET_PORT || 6090); // websockify on 127.0.0.1
const allowed = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ...(process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);

function hostname(hostHeader) {
	if (!hostHeader) return "";
	try {
		return new URL(`http://${hostHeader}`).hostname.toLowerCase();
	} catch {
		return "";
	}
}
function originOk(origin) {
	if (!origin) return false;
	try {
		const u = new URL(origin);
		return (u.protocol === "http:" || u.protocol === "https:") && allowed.has(u.hostname.toLowerCase());
	} catch {
		return false;
	}
}
const hostOk = (req) => allowed.has(hostname(req.headers.host));

const server = http.createServer((req, res) => {
	if (!hostOk(req)) {
		res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden: open Pi Crust through http://localhost\n");
		return;
	}
	const upstream = http.request({ host: "127.0.0.1", port: TARGET_PORT, method: req.method, path: req.url, headers: req.headers }, (up) => {
		res.writeHead(up.statusCode || 502, { ...up.headers, "x-frame-options": "DENY", "cache-control": "no-store" });
		up.pipe(res);
	});
	upstream.on("error", () => res.writeHead(502).end("Pi Crust is starting…\n"));
	req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
	if (!hostOk(req) || !originOk(req.headers.origin)) {
		socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		return;
	}
	const up = net.connect(TARGET_PORT, "127.0.0.1", () => {
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
		up.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head?.length) up.write(head);
		socket.pipe(up).pipe(socket);
	});
	const end = () => {
		socket.destroy();
		up.destroy();
	};
	up.on("error", end);
	socket.on("error", end);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => console.log(`gate: :${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT} (hosts: ${[...allowed].join(", ")})`));
