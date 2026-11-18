#!/usr/bin/env node
// Static file server for update tests: `node scripts/update-feed-server.js <folder> [port]`.
// Serves a folder (latest.yml, installers, .blockmap files) on 127.0.0.1, with Range support (the updater's
// differential download asks for byte ranges). No dependencies. Prints one line per request.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || process.env.PORT || 8099);

const server = http.createServer((req, res) => {
	let name;
	try {
		name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
	} catch {
		return end(400); // malformed %-escape
	}
	const file = path.resolve(dir, name);
	if (file !== dir && !file.startsWith(dir + path.sep)) return end(403);
	let st;
	try {
		st = fs.statSync(file);
	} catch {
		return end(404);
	}
	if (!st.isFile()) return end(404);
	if (/^bytes=\d+-\d+(,\s*\d+-\d+)+$/.test(req.headers.range || "")) {
		// several ranges at once: the updater's differential download expects multipart/byteranges
		const ranges = req.headers.range.slice(6).split(",").map((r) => r.trim().split("-").map(Number));
		if (ranges.some(([a, b]) => a > b || a >= st.size)) return end(416);
		const boundary = "feedboundary" + Date.now().toString(36);
		const lens = ranges.map(([a, b]) => Math.min(b, st.size - 1) - a + 1);
		const heads = ranges.map(([a, b]) => Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${a}-${Math.min(b, st.size - 1)}/${st.size}\r\n\r\n`));
		const tail = Buffer.from(`--${boundary}--\r\n`);
		const total = heads.reduce((n, h, i) => n + h.length + lens[i] + 2, 0) + tail.length;
		log(req, 206, `multi ${ranges.length} ranges, ${lens.reduce((x, y) => x + y, 0)} bytes`);
		res.writeHead(206, { "Content-Type": `multipart/byteranges; boundary=${boundary}`, "Content-Length": total, "Accept-Ranges": "bytes" });
		const fd = fs.openSync(file, "r");
		for (let i = 0; i < ranges.length; i++) {
			const buf = Buffer.alloc(lens[i]);
			fs.readSync(fd, buf, 0, lens[i], ranges[i][0]);
			res.write(heads[i]);
			res.write(buf);
			res.write("\r\n");
		}
		fs.closeSync(fd);
		return res.end(tail);
	}
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
	if (m && (m[1] || m[2])) {
		const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
		const stop = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
		if (start > stop || start >= st.size) return end(416);
		log(req, 206, `${start}-${stop}`);
		res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Length": stop - start + 1, "Content-Range": `bytes ${start}-${stop}/${st.size}`, "Accept-Ranges": "bytes" });
		return fs.createReadStream(file, { start, end: stop }).pipe(res);
	}
	log(req, 200, "full");
	res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size, "Accept-Ranges": "bytes" });
	fs.createReadStream(file).pipe(res);

	function end(code) {
		log(req, code, "");
		res.writeHead(code);
		res.end();
	}
});
function log(req, code, note) {
	console.log(`[feed] ${req.method} ${req.url} -> ${code} ${note}`.trim());
}
server.listen(port, "127.0.0.1", () => console.log(`[feed] serving ${dir} on http://127.0.0.1:${port}/`));
