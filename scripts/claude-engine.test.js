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
function tarHeader(name, size, type = "0") {
	const h = Buffer.alloc(512);
	h.write(name, 0, 100, "utf8");
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
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return h;
}
function tarball(entries) {
	const parts = [];
	for (const e of entries) {
		const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
		parts.push(tarHeader(e.name, data.length, e.type || "0"));
		if (data.length) {
			parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
		}
	}
	parts.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(parts));
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
	return { engine, engineDir, requested, cleanup };
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
		// the right token works once only
		r = await t.engine.download({ token });
		assert.equal(r.ok, true, JSON.stringify(r));
		const again = await t.engine.download({ token });
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
