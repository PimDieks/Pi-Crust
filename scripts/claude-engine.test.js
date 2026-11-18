// Tests for src/agents/claude/engine.js against a small fake tarball served by a local server. The real engine is never downloaded.
// The engine only talks https to registry.npmjs.org; the injected fetch maps that to the local test server and records every URL.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { createEngine, safeEntryPath } = require("../src/agents/claude/engine.js");

// --- a tiny tar writer ---
function tarHeader(name, size, type = "0", o = {}) {
	const h = Buffer.alloc(512);
	h.write(name, 0, 100, "utf8");
	if (o.prefix) h.write(o.prefix, 345, 155, "utf8");
	h.write("0000644\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(size.toString(8).padStart(11, "0") + "\0", 124);
	h.write("00000000000\0", 136);
	h.write("        ", 148);
	h.write(type, 156);
	h.write("ustar\0" + "00", 257);
	let sum = 0;
	for (const b of h) sum += b;
	h.write((o.badSum ? sum + 1 : sum).toString(8).padStart(6, "0") + "\0 ", 148);
	return h;
}
// entry: { name, data, type, prefix (ustar prefix field), hdrSize (size written in the header instead of data.length), badSum }
function tarBody(entries) {
	const parts = [];
	for (const e of entries) {
		const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
		parts.push(tarHeader(e.name, e.hdrSize ?? data.length, e.type || "0", e));
		if (data.length) {
			parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
		}
	}
	return Buffer.concat(parts);
}
const END = Buffer.alloc(1024);
function tarball(entries) {
	return zlib.gzipSync(Buffer.concat([tarBody(entries), END]));
}
// PAX records "<len> key=value\n" where len counts the whole record
function paxData(obj) {
	return Buffer.concat(
		Object.entries(obj).map(([k, v]) => {
			const rest = ` ${k}=${v}\n`;
			let len = Buffer.byteLength(rest) + 1;
			while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
			return Buffer.from(`${len}${rest}`);
		}),
	);
}
const sha512 = (b) => "sha512-" + crypto.createHash("sha512").update(b).digest("base64");

const GOOD = tarball([
	{ name: "package/", type: "5" },
	{ name: "package/package.json", data: '{"name":"fake"}' },
	{ name: "package/claude.exe", data: Buffer.alloc(3000, 7) },
	{ name: "package/sub/readme.txt", data: "hello" },
]);

function makePins(buf, over = {}) {
	return {
		sdkVersion: "9.9.9",
		host: "registry.npmjs.org",
		platforms: {
			"win32-x64": { package: "fake", url: "https://registry.npmjs.org/fake/-/fake-9.9.9.tgz", size: buf.length, unpackedSize: 4000, integrity: sha512(buf), binary: "claude.exe", ...over },
		},
	};
}

let server, port;
let routes = {};
let hits = [];
test.before(async () => {
	server = http.createServer((req, res) => {
		hits.push(req.url);
		const r = routes[req.url];
		if (!r) {
			res.writeHead(404).end();
			return;
		}
		r(req, res);
	});
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	port = server.address().port;
});
test.after(() => server.close());

async function setup(buf, { pinOver, engineOver = {}, route } = {}) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-engine-"));
	const engineDir = path.join(dir, "engine");
	hits = [];
	const requested = [];
	routes = { "/fake/-/fake-9.9.9.tgz": route || ((req, res) => res.writeHead(200, { "content-length": buf.length }).end(buf)) };
	const realFetch = globalThis.fetch;
	const fetch = (url, opts) => {
		const u = new URL(url);
		requested.push(u.host);
		return realFetch(`http://127.0.0.1:${port}${u.pathname}`, opts);
	};
	let n = 0;
	const engine = createEngine({ dir: engineDir, fetch, pins: makePins(buf, pinOver), platform: "win32", arch: "x64", musl: false, freeDisk: async () => 10 * 1024 ** 3, newToken: () => `tok${++n}`, ...engineOver });
	const cleanup = () => fsp.rm(dir, { recursive: true, force: true });
	return { engine, engineDir, requested, cleanup, fetch };
}
async function confirmed(engine) {
	const p = await engine.plan();
	assert.equal(p.ok, true);
	return p.token;
}
async function leftovers(dir) {
	try {
		return await fsp.readdir(dir);
	} catch {
		return [];
	}
}

test("good download: unpacks, status ready, path points at the binary", async () => {
	const t = await setup(GOOD);
	try {
		assert.deepEqual(await t.engine.status(), { state: "missing" });
		const seen = [];
		t.engine.onChange((s) => seen.push(s.state));
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, true, JSON.stringify(r));
		assert.equal(r.version, "9.9.9");
		assert.equal(r.path, path.join(t.engineDir, "9.9.9", "claude.exe"));
		assert.equal((await fsp.readFile(r.path)).length, 3000);
		assert.equal(await fsp.readFile(path.join(t.engineDir, "9.9.9", "sub", "readme.txt"), "utf8"), "hello");
		const st = await t.engine.status();
		assert.deepEqual(st, { state: "ready", path: r.path, version: "9.9.9" });
		assert.ok(seen.includes("downloading") && seen.at(-1) === "ready");
		assert.deepEqual(t.requested, ["registry.npmjs.org"]);
		assert.deepEqual((await leftovers(t.engineDir)).sort(), ["9.9.9"]); // no temp folder left
	} finally {
		await t.cleanup();
	}
});

test("a fresh engine object sees an installed engine as ready", async () => {
	const t = await setup(GOOD);
	try {
		await t.engine.download({ token: await confirmed(t.engine) });
		const again = createEngine({ dir: t.engineDir, pins: makePins(GOOD), platform: "win32", arch: "x64", musl: false });
		assert.equal((await again.status()).state, "ready");
	} finally {
		await t.cleanup();
	}
});

test("old versions are removed after a good install", async () => {
	const t = await setup(GOOD);
	try {
		await fsp.mkdir(path.join(t.engineDir, "0.1.0"), { recursive: true });
		await fsp.writeFile(path.join(t.engineDir, "0.1.0", "claude.exe"), "old");
		await fsp.mkdir(path.join(t.engineDir, ".tmp-stale"), { recursive: true });
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, true);
		assert.deepEqual((await leftovers(t.engineDir)).sort(), ["9.9.9"]);
	} finally {
		await t.cleanup();
	}
});

test("wrong hash: download deleted, reported, nothing installed", async () => {
	const t = await setup(GOOD, { pinOver: { integrity: sha512(Buffer.from("something else")) } });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "hash");
		assert.match(r.error, /checksum/);
		assert.match(r.error, /deleted/);
		assert.deepEqual(await leftovers(t.engineDir), []);
		const st = await t.engine.status();
		assert.equal(st.state, "failed");
		assert.match(st.reason, /checksum/);
	} finally {
		await t.cleanup();
	}
});

test("too large: stops at the pinned size (declared and undeclared), leaves nothing", async () => {
	const big = Buffer.concat([GOOD, Buffer.alloc(5000, 1)]);
	// declared length larger than the pin
	let t = await setup(GOOD, { route: (req, res) => res.writeHead(200, { "content-length": big.length }).end(big) });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "too-large");
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
	// no length header (chunked), body larger than the pin
	t = await setup(GOOD, {
		route: (req, res) => {
			res.writeHead(200);
			res.write(big.subarray(0, GOOD.length));
			res.end(big.subarray(GOOD.length));
		},
	});
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "too-large");
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});

test("redirect to another host is refused and never requested", async () => {
	const t = await setup(GOOD, { route: (req, res) => res.writeHead(302, { location: "https://evil.example/x.tgz" }).end() });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "redirect");
		assert.match(r.error, /evil\.example/);
		assert.deepEqual(t.requested, ["registry.npmjs.org"]); // evil.example was never contacted
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});

test("redirect to plain http on the same host is refused; a same-host https redirect is followed", async () => {
	let t = await setup(GOOD, { route: (req, res) => res.writeHead(302, { location: "http://registry.npmjs.org/fake/-/fake-9.9.9.tgz" }).end() });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.code, "redirect");
	} finally {
		await t.cleanup();
	}
	t = await setup(GOOD);
	try {
		routes["/fake/-/fake-9.9.9.tgz"] = (req, res) => res.writeHead(302, { location: "https://registry.npmjs.org/real.tgz" }).end();
		routes["/real.tgz"] = (req, res) => res.writeHead(200, { "content-length": GOOD.length }).end(GOOD);
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, true, JSON.stringify(r));
	} finally {
		await t.cleanup();
	}
});

test("a tarball entry with .. is refused, nothing written outside or left behind", async () => {
	const evil = tarball([
		{ name: "package/claude.exe", data: "x" },
		{ name: "package/../../escaped.txt", data: "pwned" },
	]);
	const t = await setup(evil);
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "unsafe-path");
		assert.deepEqual(await leftovers(t.engineDir), []);
		assert.equal(fs.existsSync(path.join(t.engineDir, "escaped.txt")), false);
		assert.equal(fs.existsSync(path.join(path.dirname(t.engineDir), "escaped.txt")), false);
	} finally {
		await t.cleanup();
	}
});

test("absolute paths, links and entries outside package/ are refused", async () => {
	for (const [label, entries, code] of [
		["absolute", [{ name: "/etc/evil", data: "x" }], "unsafe-path"],
		["drive letter", [{ name: "C:/evil", data: "x" }], "unsafe-path"],
		["backslash", [{ name: "package\\..\\evil", data: "x" }], "unsafe-path"],
		["outside package", [{ name: "other/claude.exe", data: "x" }], "unsafe-path"],
		["symlink", [{ name: "package/link", type: "2" }], "unsafe-entry"],
		["hardlink", [{ name: "package/link", type: "1" }], "unsafe-entry"],
	]) {
		const t = await setup(tarball(entries));
		try {
			const r = await t.engine.download({ token: await confirmed(t.engine) });
			assert.equal(r.ok, false, label);
			assert.equal(r.code, code, label);
			assert.deepEqual(await leftovers(t.engineDir), [], label);
		} finally {
			await t.cleanup();
		}
	}
	assert.equal(safeEntryPath("package/a/b.txt"), "a/b.txt");
	assert.equal(safeEntryPath("package/a/../b"), null);
});

test("a package without the engine program is refused", async () => {
	const t = await setup(tarball([{ name: "package/package.json", data: "{}" }]));
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "bad-archive");
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});

test("cancel mid-way: stops, removes the temp files, status missing", async () => {
	let started;
	const gotFirst = new Promise((ok) => (started = ok));
	const t = await setup(GOOD, {
		route: (req, res) => {
			res.writeHead(200, { "content-length": GOOD.length });
			res.write(GOOD.subarray(0, 40));
			started();
			// the rest never comes
			req.on("close", () => res.destroy());
		},
	});
	try {
		const p = t.engine.download({ token: await confirmed(t.engine) });
		await gotFirst;
		await new Promise((r) => setTimeout(r, 50));
		assert.equal((await t.engine.status()).state, "downloading");
		assert.deepEqual(t.engine.cancel(), { ok: true });
		const r = await p;
		assert.equal(r.ok, false);
		assert.equal(r.code, "cancelled");
		assert.deepEqual(await leftovers(t.engineDir), []);
		assert.deepEqual(await t.engine.status(), { state: "missing" });
		assert.deepEqual(t.engine.cancel(), { ok: false }); // nothing running now
	} finally {
		await t.cleanup();
	}
});

test("no confirm, no download", async () => {
	const t = await setup(GOOD);
	try {
		// never asked
		let r = await t.engine.download({ token: "tok1" });
		assert.equal(r.ok, false);
		assert.equal(r.code, "no-confirm");
		r = await t.engine.download();
		assert.equal(r.code, "no-confirm");
		// asked, but a wrong token
		const plan = await t.engine.plan();
		assert.match(plan.text, /9\.9\.9/);
		assert.match(plan.text, /registry\.npmjs\.org/);
		const token = plan.token;
		r = await t.engine.download({ token: token + "x" });
		assert.equal(r.code, "no-confirm");
		assert.equal(t.requested.length, 0);
		assert.equal(hits.length, 0);
		assert.deepEqual(await leftovers(t.engineDir), []);
		// a wrong token spent that plan: the right token of the same plan no longer works either
		assert.equal((await t.engine.download({ token })).code, "no-confirm");
		// a new plan, and its token works once only
		const token2 = (await t.engine.plan()).token;
		r = await t.engine.download({ token: token2 });
		assert.equal(r.ok, true, JSON.stringify(r));
		const again = await t.engine.download({ token: token2 });
		assert.equal(again.code, "no-confirm");
		// the plan text names version, size and host
		const p = await t.engine.plan();
		assert.equal(p.ok, false); // installed now
	} finally {
		await t.cleanup();
	}
});

test("a second download while one runs is refused", async () => {
	let release;
	const held = new Promise((ok) => (release = ok));
	const t = await setup(GOOD, { route: (req, res) => held.then(() => res.writeHead(200, { "content-length": GOOD.length }).end(GOOD)) });
	try {
		const first = t.engine.download({ token: await confirmed(t.engine) });
		const second = await t.engine.download({ token: "tok2" });
		assert.equal(second.ok, false);
		release();
		assert.equal((await first).ok, true);
	} finally {
		await t.cleanup();
	}
});

test("disk full: not enough free space is refused before any request", async () => {
	const t = await setup(GOOD, { engineOver: { freeDisk: async () => 1024 } });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "disk");
		assert.match(r.error, /free disk space/);
		assert.equal(hits.length, 0);
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});

test("disk full: a write that fails with ENOSPC midway leaves nothing", async () => {
	const wrapped = {
		...fsp,
		open: async (file, ...rest) => {
			const fh = await fsp.open(file, ...rest);
			if (String(file).endsWith("engine.tgz")) {
				const write = fh.write.bind(fh);
				let n = 0;
				fh.write = async (...a) => {
					if (++n > 1) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
					return write(...a);
				};
			}
			return fh;
		},
	};
	const t = await setup(GOOD, {
		engineOver: { fsApi: wrapped },
		route: (req, res) => {
			res.writeHead(200, { "content-length": GOOD.length });
			res.write(GOOD.subarray(0, 100));
			setTimeout(() => res.end(GOOD.subarray(100)), 30);
		},
	});
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.match(r.error, /disk is full/);
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});

test("a server error and a short download both fail cleanly", async () => {
	let t = await setup(GOOD, { route: (req, res) => res.writeHead(500).end() });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.code, "http");
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
	t = await setup(GOOD, { route: (req, res) => res.writeHead(200).end(GOOD.subarray(0, 100)) });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});

test("a platform without a published engine reports it", async () => {
	const t = await setup(GOOD, { engineOver: { platform: "freebsd", arch: "x64" } });
	try {
		const st = await t.engine.status();
		assert.equal(st.state, "failed");
		assert.match(st.reason, /freebsd-x64/);
		assert.equal((await t.engine.plan()).ok, false);
	} finally {
		await t.cleanup();
	}
});

test("the shipped pins are well formed: https, pinned host, sha512, a platform entry each", () => {
	const pins = require("../src/agents/claude/engine-pins.json");
	assert.equal(pins.host, "registry.npmjs.org");
	assert.equal(pins.sdkVersion, require("../package.json").dependencies["@anthropic-ai/claude-agent-sdk"]);
	assert.equal(Object.keys(pins.platforms).length, 8);
	for (const [k, p] of Object.entries(pins.platforms)) {
		const u = new URL(p.url);
		assert.equal(u.protocol, "https:", k);
		assert.equal(u.host, pins.host, k);
		assert.ok(p.url.includes(`-${pins.sdkVersion}.tgz`), k);
		assert.match(p.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, k);
		assert.ok(p.size > 1e7 && p.unpackedSize > p.size, k);
		assert.ok(p.binary === "claude" || p.binary === "claude.exe", k);
	}
});

test("the built app does not bundle the engine (build.files excludes the per-platform packages)", () => {
	const files = require("../package.json").build.files;
	assert.ok(files.includes("!node_modules/@anthropic-ai/claude-agent-sdk-*/**"));
});

// ---------------------------------------------------------------------------------------------------------------------
// Review round: each test below is tied to one guard in engine.js and goes red when that guard is removed (see the list in the
// review report). Helpers first.
async function installGood(t) {
	const r = await t.engine.download({ token: await confirmed(t.engine) });
	assert.equal(r.ok, true, JSON.stringify(r));
	return r;
}
async function runFail(buf, opts, code, label) {
	const t = await setup(buf, opts);
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`);
		if (code) assert.equal(r.code, code, `${label}: ${JSON.stringify(r)}`);
		assert.deepEqual(await leftovers(t.engineDir), [], label);
		return r;
	} finally {
		await t.cleanup();
	}
}
async function runOk(buf, opts, label) {
	const t = await setup(buf, opts);
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
		return { r, t };
	} catch (e) {
		await t.cleanup();
		throw e;
	}
}
const exe = (n = 3000) => ({ name: "package/claude.exe", data: Buffer.alloc(n, 7) });

// --- 1. an installed engine is checked against the size it had at install ---------------------------------------------
test("status: a truncated engine file is failed with a reason and a way to download again", async () => {
	const t = await setup(GOOD);
	try {
		const r = await installGood(t);
		assert.equal(JSON.parse(await fsp.readFile(path.join(t.engineDir, "9.9.9", "engine.json"), "utf8")).size, 3000);
		await fsp.writeFile(r.path, Buffer.alloc(100, 7)); // truncated, or replaced by a quarantine stub
		const again = createEngine({ dir: t.engineDir, fetch: t.fetch, pins: makePins(GOOD), platform: "win32", arch: "x64", musl: false, freeDisk: async () => 10 * 1024 ** 3 });
		const st = await again.status();
		assert.equal(st.state, "failed");
		assert.match(st.reason, /damaged/);
		assert.match(st.reason, /Download it again/);
		assert.equal(st.canDownloadAgain, true);
		// and the way out works: plan() does not say "already installed", a new download replaces the damaged folder
		const p = await again.plan();
		assert.equal(p.ok, true, JSON.stringify(p));
		const d = await again.download({ token: p.token });
		assert.equal(d.ok, true, JSON.stringify(d));
		assert.equal((await fsp.stat(d.path)).size, 3000);
		assert.equal((await again.status()).state, "ready");
	} finally {
		await t.cleanup();
	}
});

test("status: engine.json that is missing, unreadable, from another version or checksum, or without a size is not ready", async () => {
	const t = await setup(GOOD);
	try {
		await installGood(t);
		const metaFile = path.join(t.engineDir, "9.9.9", "engine.json");
		const good = JSON.parse(await fsp.readFile(metaFile, "utf8"));
		const fresh = () => createEngine({ dir: t.engineDir, pins: makePins(GOOD), platform: "win32", arch: "x64", musl: false });
		assert.equal((await fresh().status()).state, "ready");
		const { size: _drop, ...noSize } = good;
		for (const [label, content] of [
			["other checksum", JSON.stringify({ ...good, integrity: sha512(Buffer.from("other")) })],
			["other version", JSON.stringify({ ...good, version: "9.9.8" })],
			["no size", JSON.stringify(noSize)],
			["not json", "{nope"],
		]) {
			await fsp.writeFile(metaFile, content);
			assert.deepEqual(await fresh().status(), { state: "missing" }, label);
		}
		await fsp.rm(metaFile);
		assert.deepEqual(await fresh().status(), { state: "missing" }, "no engine.json");
		await fsp.writeFile(metaFile, JSON.stringify(good));
		assert.equal((await fresh().status()).state, "ready");
		// the engine "file" is a folder: not ready, and plan() is allowed to replace it
		await fsp.rm(path.join(t.engineDir, "9.9.9", "claude.exe"));
		await fsp.mkdir(path.join(t.engineDir, "9.9.9", "claude.exe"));
		assert.deepEqual(await fresh().status(), { state: "missing" }, "folder instead of file");
		assert.equal((await fresh().plan()).ok, true);
	} finally {
		await t.cleanup();
	}
});

// --- 2. the written file is what counts --------------------------------------------------------------------------------
function wrapTgzWrite(mutate) {
	return {
		...fsp,
		open: async (file, ...rest) => {
			const fh = await fsp.open(file, ...rest);
			if (String(file).endsWith("engine.tgz") && rest[0] === "wx") {
				const write = fh.write.bind(fh);
				fh.write = async (chunk, ...a) => mutate(write, chunk, a);
			}
			return fh;
		},
	};
}
test("a write that reports fewer bytes than given fails the download (short write)", async () => {
	const fsApi = wrapTgzWrite(async (write, chunk, a) => {
		const r = await write(chunk, ...a);
		return { ...r, bytesWritten: r.bytesWritten - 1 };
	});
	await runFail(GOOD, { engineOver: { fsApi } }, "short", "short write");
});
test("a write that reports success but stores nothing is caught by the size of the file on disk", async () => {
	const fsApi = wrapTgzWrite(async (write, chunk) => ({ bytesWritten: chunk.length, buffer: chunk }));
	await runFail(GOOD, { engineOver: { fsApi } }, "short", "silent drop");
});
test("the checksum is taken from the file on disk, not from the stream", async () => {
	// the stream matches the pin, the disk gets one flipped byte
	const fsApi = wrapTgzWrite(async (write, chunk, a) => {
		const bad = Buffer.from(chunk);
		bad[0] ^= 0xff;
		await write(bad, ...a);
		return { bytesWritten: chunk.length, buffer: chunk };
	});
	const r = await runFail(GOOD, { engineOver: { fsApi } }, "hash", "flipped byte on disk");
	assert.match(r.error, /checksum/);
});
test("files are only ever created, never overwritten (wx): the download file and every unpacked file", async () => {
	const flags = [];
	const fsApi = {
		...fsp,
		open: async (file, f, ...rest) => {
			if (f !== "r") flags.push([path.basename(String(file)), f]);
			return fsp.open(file, f, ...rest);
		},
	};
	const { t } = await runOk(GOOD, { engineOver: { fsApi } }, "flags");
	try {
		assert.ok(flags.some(([n]) => n === "engine.tgz") && flags.some(([n]) => n === "claude.exe"), JSON.stringify(flags));
		assert.deepEqual(flags.filter(([, f]) => f !== "wx"), []);
	} finally {
		await t.cleanup();
	}
	// the same name twice in one archive: the second create fails instead of overwriting
	await runFail(tarball([exe(), { name: "package/a.txt", data: "one" }, { name: "package/a.txt", data: "two" }]), {}, undefined, "duplicate entry");
});

// --- download limits ----------------------------------------------------------------------------------------------------
test("a declared content-length above the pin stops the download before any body is read", { timeout: 8000 }, async () => {
	const t = await setup(GOOD, {
		route: (req, res) => {
			res.writeHead(200, { "content-length": GOOD.length + 5000 });
			res.flushHeaders();
			setTimeout(() => res.destroy(), 2000); // the body never comes
		},
	});
	try {
		const t0 = Date.now();
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.code, "too-large", JSON.stringify(r));
		assert.ok(Date.now() - t0 < 1500, "stopped on the header, did not wait for the body");
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});
test("a download that ends early is reported as short, not as a checksum problem", async () => {
	const r = await runFail(GOOD, { route: (req, res) => res.writeHead(200).end(GOOD.subarray(0, 100)) }, "short", "short body");
	assert.match(r.error, /ended early/);
});
test("redirects: at most three hops, then refused", { timeout: 8000 }, async () => {
	const t = await setup(GOOD, { route: (req, res) => res.writeHead(302, { location: "https://registry.npmjs.org/fake/-/fake-9.9.9.tgz" }).end() });
	try {
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.ok, false);
		assert.equal(r.code, "redirect");
		assert.match(r.error, /too many times/);
		assert.equal(hits.length, 4); // the first request and three hops, no more
		assert.deepEqual(await leftovers(t.engineDir), []);
	} finally {
		await t.cleanup();
	}
});
test("an address with user name or password is refused: as a redirect target and as the pin", async () => {
	for (const loc of ["https://user:pw@registry.npmjs.org/real.tgz", "https://user@registry.npmjs.org/real.tgz", "https://:pw@registry.npmjs.org/real.tgz"]) {
		const t = await setup(GOOD, { route: (req, res) => res.writeHead(302, { location: loc }).end() });
		try {
			routes["/real.tgz"] = (req, res) => res.writeHead(200, { "content-length": GOOD.length }).end(GOOD);
			const r = await t.engine.download({ token: await confirmed(t.engine) });
			assert.equal(r.code, "redirect", loc);
			assert.ok(!hits.includes("/real.tgz"), loc);
		} finally {
			await t.cleanup();
		}
	}
	for (const url of ["https://user:pw@registry.npmjs.org/fake/-/fake-9.9.9.tgz", "https://user@registry.npmjs.org/fake/-/fake-9.9.9.tgz", "https://:pw@registry.npmjs.org/fake/-/fake-9.9.9.tgz"]) {
		const t = await setup(GOOD, { pinOver: { url } });
		try {
			const p = await t.engine.plan();
			assert.equal(p.ok, false, url);
			assert.match(p.error, /pinned host/, url);
			assert.equal((await t.engine.status()).state, "failed", url);
			assert.equal(hits.length, 0);
		} finally {
			await t.cleanup();
		}
	}
});
test("leftover .tmp-* folders of an earlier crash are removed at the start, even when this download fails; other folders stay", async () => {
	const t = await setup(GOOD, { route: (req, res) => res.writeHead(500).end() });
	try {
		await fsp.mkdir(path.join(t.engineDir, ".tmp-crashed"), { recursive: true });
		await fsp.writeFile(path.join(t.engineDir, ".tmp-crashed", "engine.tgz"), "half");
		await fsp.mkdir(path.join(t.engineDir, "keep-me"));
		const r = await t.engine.download({ token: await confirmed(t.engine) });
		assert.equal(r.code, "http");
		assert.deepEqual(await leftovers(t.engineDir), ["keep-me"]);
	} finally {
		await t.cleanup();
	}
});

// --- unpacking limits ---------------------------------------------------------------------------------------------------
test("unpacked size: up to the pinned size plus 2% is allowed, one byte more is refused", async () => {
	// the fake pin says 4000 unpacked: the limit is ceil(4000 * 1.02) = 4080
	const ok = await runOk(tarball([exe(4080)]), {}, "4080");
	await ok.t.cleanup();
	const r = await runFail(tarball([exe(4081)]), {}, "too-large", "4081");
	assert.match(r.error, /more than expected/);
});
test("entry count: 500 entries are fine, 501 are refused", async () => {
	const many = (n) => [exe(10), ...Array.from({ length: n - 1 }, (_, i) => ({ name: `package/f${i}.txt`, data: "" }))];
	const ok = await runOk(tarball(many(500)), {}, "500 entries");
	await ok.t.cleanup();
	const r = await runFail(tarball(many(501)), {}, "bad-archive", "501 entries");
	assert.match(r.error, /too many files/);
});
test("the unpacker's own containment check refuses a resolved path outside the target (even if the name check were fooled)", async () => {
	// A path API whose resolve() puts one name outside the folder: the name looks fine to safeEntryPath, the result does not.
	for (const [label, outside] of [
		["parent folder", (root) => path.resolve(root, "..", "outside.txt")],
		["sibling with the same prefix", (root) => `${root}-evil${path.sep}x.txt`],
	]) {
		const pathApi = { ...path, resolve: (...a) => (a.length > 1 && a.at(-1) === "trick.txt" ? outside(a[0]) : path.resolve(...a)) };
		await runFail(tarball([exe(), { name: "package/trick.txt", data: "x" }]), { engineOver: { pathApi } }, "unsafe-path", label);
	}
});

// --- tar parsing --------------------------------------------------------------------------------------------------------
test("a tar header with a wrong checksum is refused", async () => {
	const r = await runFail(tarball([exe(), { name: "package/b.txt", data: "x", badSum: true }]), {}, "bad-archive", "bad sum");
	assert.match(r.error, /bad header/);
});
const LONG_DIR = `${"d".repeat(60)}/${"e".repeat(60)}`; // "package/" + this + "/file.txt" is more than 100 characters
async function expectLong(entries, label) {
	const { r, t } = await runOk(tarball([exe(), ...entries]), {}, label);
	try {
		assert.equal(await fsp.readFile(path.join(path.dirname(r.path), ...LONG_DIR.split("/"), "file.txt"), "utf8"), "long", label);
	} finally {
		await t.cleanup();
	}
}
test("a long path in a PAX header (the usual case for deep node_modules), a GNU long name and a ustar prefix all land at the full path", async () => {
	const full = `package/${LONG_DIR}/file.txt`;
	assert.ok(full.length > 100);
	await expectLong([{ name: "package/PaxHeader", type: "x", data: paxData({ path: full, mtime: "1" }) }, { name: full.slice(0, 99), data: "long" }], "pax path");
	await expectLong([{ name: "././@LongLink", type: "L", data: Buffer.from(full + "\0") }, { name: full.slice(0, 99), data: "long" }], "gnu long name");
	await expectLong([{ name: "file.txt", prefix: `package/${LONG_DIR}`, data: "long" }], "ustar prefix");
	// a PAX or GNU long name is judged like any other name
	await runFail(tarball([exe(), { name: "x", type: "x", data: paxData({ path: "package/../../evil.txt" }) }, { name: "package/ok.txt", data: "x" }]), {}, "unsafe-path", "pax dotdot");
	await runFail(tarball([exe(), { name: "x", type: "L", data: Buffer.from("/etc/evil\0") }, { name: "package/ok.txt", data: "x" }]), {}, "unsafe-path", "gnu absolute");
});
test("a PAX size record is honoured (header size field smaller than the data)", async () => {
	const { r, t } = await runOk(tarball([{ name: "x", type: "x", data: paxData({ size: "3000" }) }, { name: "package/claude.exe", hdrSize: 0, data: Buffer.alloc(3000, 7) }, { name: "package/after.txt", data: "after" }]), {}, "pax size");
	try {
		assert.equal((await fsp.readFile(r.path)).length, 3000);
		assert.equal(await fsp.readFile(path.join(path.dirname(r.path), "after.txt"), "utf8"), "after");
	} finally {
		await t.cleanup();
	}
	await runFail(tarball([exe(), { name: "x", type: "x", data: paxData({ size: "12abc" }) }, { name: "package/a.txt", data: "x" }]), {}, "bad-archive", "bad pax size");
	await runFail(tarball([exe(), { name: "x", type: "x", data: Buffer.from("99 path=package/x\n") }, { name: "package/a.txt", data: "x" }]), {}, "bad-archive", "bad pax record");
});
test("nothing may follow the end-of-archive marker: no second gzip member, no more entries; zero padding is fine", async () => {
	const first = [exe(), { name: "package/a.txt", data: "a" }];
	const extra = [{ name: "package/extra.txt", data: "late" }];
	// a second gzip member holding another archive
	let r = await runFail(Buffer.concat([tarball(first), tarball(extra)]), {}, "bad-archive", "second member");
	assert.match(r.error, /after the end/);
	// more entries in the same member, after the two zero blocks
	r = await runFail(zlib.gzipSync(Buffer.concat([tarBody(first), END, tarBody(extra), END])), {}, "bad-archive", "entries after end");
	assert.match(r.error, /after the end/);
	// non-zero junk after the marker
	await runFail(zlib.gzipSync(Buffer.concat([tarBody(first), END, Buffer.from("junk")])), {}, "bad-archive", "junk after end");
	// npm pads the archive to a multiple of 10240 bytes with zeros
	const body = Buffer.concat([tarBody(first), END]);
	const padded = Buffer.concat([body, Buffer.alloc(10240 * 2 - (body.length % 10240))]);
	const ok = await runOk(zlib.gzipSync(padded), {}, "zero padding");
	await ok.t.cleanup();
});

// --- names --------------------------------------------------------------------------------------------------------------
test("safeEntryPath refuses colons, Windows device names (with or without extension), trailing dot or space, and keeps the old rules", () => {
	for (const bad of [
		"C:/evil", "c:evil", "package/C:/x", // drive letters
		"package/a:b", "package/file.txt:stream", // colon anywhere
		"package/NUL", "package/nul", "package/aux.txt", "package/AUX.tar.gz", "package/COM1", "package/com9.txt", "package/LPT1", "package/lpt3.log", "package/CON", "package/PRN.x", "package/sub/Nul.txt", "package/NUL /x", // device names
		"package/x.", "package/x ", "package/dir./y", "package/dir /y", "package/...",
		"package\\x", "package/a\\..\\b", "package/a\0b", // backslash, NUL
		"package/./x", "package/a/./b", "package/../x", "/abs", "other/x", "", // the older rules
	]) assert.equal(safeEntryPath(bad), null, JSON.stringify(bad));
	for (const good of ["package/console.js", "package/auxiliary", "package/com10", "package/lpt", "package/nulls.txt", "package/a.b/c.d", "package/.hidden"]) assert.ok(safeEntryPath(good), good);
	assert.equal(safeEntryPath("package/claude.exe"), "claude.exe");
	assert.equal(safeEntryPath("package/"), "");
});
test("a device name in an archive is refused as unsafe-path", async () => {
	await runFail(tarball([exe(), { name: "package/aux.txt", data: "x" }]), {}, "unsafe-path", "aux.txt");
	await runFail(tarball([exe(), { name: "package/a:b", data: "x" }]), {}, "unsafe-path", "colon");
});

// --- cancel, stop, token ------------------------------------------------------------------------------------------------
test("stopNow waits until the temp folder is gone", async () => {
	let started;
	const gotFirst = new Promise((ok) => (started = ok));
	// removal is slow, so a stopNow that does not wait would return while the folder is still there
	const fsApi = { ...fsp, rm: async (...a) => (await new Promise((r) => setTimeout(r, 150)), fsp.rm(...a)) };
	const t = await setup(GOOD, {
		engineOver: { fsApi },
		route: (req, res) => {
			res.writeHead(200, { "content-length": GOOD.length });
			res.write(GOOD.subarray(0, 40));
			started();
			req.on("close", () => res.destroy());
		},
	});
	try {
		assert.equal(await t.engine.stopNow(), false); // nothing running
		const p = t.engine.download({ token: await confirmed(t.engine) });
		await gotFirst;
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(await t.engine.stopNow(), true);
		assert.deepEqual(await leftovers(t.engineDir), [], "no .tmp-* left when stopNow has returned");
		assert.equal(t.engine.isRunning(), false);
		assert.equal((await p).code, "cancelled");
	} finally {
		await t.cleanup();
	}
});
test("cancel() after the new folder is in place says the install finished, and the install stays", async () => {
	let eng;
	let cancelled;
	const fsApi = {
		...fsp,
		rename: async (from, to) => {
			await fsp.rename(from, to);
			if (String(to).endsWith("9.9.9")) cancelled = eng.cancel(); // right after the rename point
		},
	};
	const t = await setup(GOOD, { engineOver: { fsApi } });
	eng = t.engine;
	try {
		const r = await installGood(t);
		assert.deepEqual(cancelled, { ok: false, finished: true });
		assert.equal((await t.engine.status()).state, "ready");
		assert.equal((await fsp.readFile(r.path)).length, 3000);
		assert.deepEqual(t.engine.cancel(), { ok: false }); // idle again, nothing special
	} finally {
		await t.cleanup();
	}
});
test("the confirm token expires after ten minutes and is spent by any use, right or wrong", async () => {
	let clock = 1_000_000;
	const over = { engineOver: { now: () => clock } };
	// exactly ten minutes is still fine
	let t = await setup(GOOD, over);
	try {
		const token = await confirmed(t.engine);
		clock += 10 * 60 * 1000;
		assert.equal((await t.engine.download({ token })).ok, true);
	} finally {
		await t.cleanup();
	}
	// one millisecond later is not, and the plan is gone afterwards
	t = await setup(GOOD, over);
	try {
		const token = await confirmed(t.engine);
		clock += 10 * 60 * 1000 + 1;
		const r = await t.engine.download({ token });
		assert.equal(r.code, "no-confirm");
		assert.match(r.error, /out of date/);
		assert.equal(hits.length, 0);
		clock -= 10 * 60 * 1000; // even back in time the spent token does not work
		assert.equal((await t.engine.download({ token })).code, "no-confirm");
		// a wrong token spends the plan
		const token2 = await confirmed(t.engine);
		assert.equal((await t.engine.download({ token: "nope" })).code, "no-confirm");
		assert.equal((await t.engine.download({ token: token2 })).code, "no-confirm");
		assert.equal(hits.length, 0);
		// a new plan works
		assert.equal((await t.engine.download({ token: await confirmed(t.engine) })).ok, true);
	} finally {
		await t.cleanup();
	}
});
