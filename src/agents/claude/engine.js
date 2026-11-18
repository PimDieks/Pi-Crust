// Download of the Claude engine (the native program the Claude Agent SDK drives), main process only. The engine is NOT in the installer
// (it is about 360 MB): the first time someone picks Claude Agent the app asks, then downloads a pinned, checksum-verified version.
// What is pinned (version, host, size, sha512) lives in engine-pins.json. fetch, fs, paths, disk space and the token source are passed
// in, so tests run against a local server and a fake disk. No IPC and no UI here; the caller wires the handlers.
//
//   plan()           -> { ok, token, text, version, host, downloadBytes, installedBytes } | { ok: false, error }
//                       The list for the confirm. The token is one-time and bound to this plan; download() needs it.
//   download({token})-> { ok: true, path, version } | { ok: false, error, code }. Without a token issued by plan(): nothing is fetched.
//   cancel()         -> { ok } stops a running download and removes everything it wrote.
//   status()         -> { state: "missing" } | { state: "downloading", received, total, percent }
//                       | { state: "ready", path, version } | { state: "failed", reason }
//   onChange(fn)     -> unsubscribe; fn gets the status on every change (progress is throttled).
//
// Safety: HTTPS only, the pinned host only (a redirect to another host is refused, never followed), the pinned size is a hard limit,
// free disk is checked first, the sha512 is checked before a single byte is unpacked, the unpacker refuses any path that leaves the
// target folder and any link or special file, everything is written to a temp folder next to the final one and renamed, old versions
// are removed after a good install. Any failure removes the temp folder: no partial files are left.
"use strict";

const nodeFs = require("node:fs/promises");
const nodePath = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const defaultPins = require("./engine-pins.json");

const MAX_REDIRECTS = 3;
const MAX_ENTRIES = 500;
const TMP_PREFIX = ".tmp-";
const MB = 1024 * 1024;

class EngineError extends Error {
	constructor(message, code) {
		super(message);
		this.name = "EngineError";
		this.code = code;
	}
}

function mbText(bytes) {
	return `${Math.round(bytes / MB)} MB`;
}

function detectMusl() {
	try {
		const r = process.report?.getReport?.();
		return process.platform === "linux" && !r?.header?.glibcVersionRuntime;
	} catch {
		return false;
	}
}

function platformKey(platform, arch, musl) {
	return `${platform}-${arch}${platform === "linux" && musl ? "-musl" : ""}`;
}

async function defaultFreeDisk(dir, fsApi) {
	const s = await fsApi.statfs(dir);
	return Number(s.bavail) * Number(s.bsize);
}

// Parse "sha512-<base64>" to a Buffer, or null.
function parseIntegrity(text) {
	const m = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(String(text));
	return m ? Buffer.from(m[1], "base64") : null;
}

// The relative path inside the engine folder for a tarball entry name ("package/claude.exe" -> "claude.exe"), or null when the
// name is not safe. Refuses: absolute paths, drive letters, backslashes, NUL, "." and ".." parts, an empty result.
function safeEntryPath(name) {
	if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\")) return null;
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
	const parts = name.split("/").filter((p) => p !== "");
	if (parts.some((p) => p === ".." || p === ".")) return null;
	if (parts[0] !== "package") return null; // npm tarballs keep everything under package/
	const rest = parts.slice(1);
	return rest.length ? rest.join("/") : "";
}

function octal(buf) {
	const s = buf.toString("latin1").replace(/\0.*$/s, "").trim();
	if (!s) return 0;
	if (!/^[0-7]+$/.test(s)) throw new EngineError("The download is not a valid package (bad size field).", "bad-archive");
	return parseInt(s, 8);
}

function cstr(buf) {
	return buf.toString("utf8").replace(/\0.*$/s, "");
}

// Reads a tar stream (already gunzipped) and calls handlers. Async iterator of Buffers in; handlers:
//   onFile(relPath, size, mode) -> returns { write(chunk), end() }   onDir(relPath)
async function readTar(chunks, { onFile, onDir, maxEntries = MAX_ENTRIES, maxTotal }) {
	let buf = Buffer.alloc(0);
	const it = chunks[Symbol.asyncIterator]();
	let ended = false;
	async function fill(n) {
		while (buf.length < n && !ended) {
			const { value, done } = await it.next();
			if (done) ended = true;
			else buf = buf.length ? Buffer.concat([buf, value]) : value;
		}
		return buf.length >= n;
	}
	let entries = 0;
	let total = 0;
	let longName = null;
	let paxPath = null;
	for (;;) {
		if (!(await fill(512))) break;
		const h = buf.subarray(0, 512);
		buf = buf.subarray(512);
		if (h.every((b) => b === 0)) continue; // end blocks
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
		if (sum !== octal(h.subarray(148, 156))) throw new EngineError("The download is not a valid package (bad header).", "bad-archive");
		const type = String.fromCharCode(h[156] || 48);
		const size = octal(h.subarray(124, 136));
		const prefix = cstr(h.subarray(345, 500));
		let name = cstr(h.subarray(0, 100));
		if (prefix) name = `${prefix}/${name}`;
		const padded = Math.ceil(size / 512) * 512;
		if (type === "x" || type === "L" || type === "g") {
			if (size > 65536) throw new EngineError("The download is not a valid package (oversized header).", "bad-archive");
			if (!(await fill(padded))) throw new EngineError("The download ended early.", "bad-archive");
			const data = buf.subarray(0, size);
			buf = buf.subarray(padded);
			if (type === "L") longName = cstr(data);
			else if (type === "x") {
				const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
				paxPath = m ? m[1] : null;
			}
			continue;
		}
		if (paxPath !== null) name = paxPath;
		else if (longName !== null) name = longName;
		paxPath = longName = null;
		if (++entries > maxEntries) throw new EngineError("The download holds too many files.", "bad-archive");
		const rel = safeEntryPath(name);
		if (rel === null) throw new EngineError(`The download holds an unsafe path (${JSON.stringify(name.slice(0, 80))}) and was refused.`, "unsafe-path");
		if (type === "5") {
			if (rel) await onDir(rel);
			continue;
		}
		if (type !== "0" && type !== "7") throw new EngineError("The download holds a link or special file and was refused.", "unsafe-entry");
		if (!rel) throw new EngineError("The download holds an unsafe path and was refused.", "unsafe-path");
		total += size;
		if (maxTotal !== undefined && total > maxTotal) throw new EngineError("The download unpacks to more than expected and was refused.", "too-large");
		const sink = await onFile(rel, size, octal(h.subarray(100, 108)));
		try {
			let left = size;
			while (left > 0) {
				if (!buf.length && !(await fill(1))) throw new EngineError("The download ended early.", "bad-archive");
				const take = Math.min(left, buf.length);
				await sink.write(buf.subarray(0, take));
				buf = buf.subarray(take);
				left -= take;
			}
		} catch (e) {
			await sink.end().catch(() => {});
			throw e;
		}
		await sink.end();
		const pad = padded - size;
		if (pad && !(await fill(pad))) throw new EngineError("The download ended early.", "bad-archive");
		buf = buf.subarray(pad);
	}
}

function createEngine({
	dir,
	fetch: fetchFn = globalThis.fetch,
	fsApi = nodeFs,
	pins = defaultPins,
	platform = process.platform,
	arch = process.arch,
	musl = detectMusl(),
	freeDisk,
	newToken = () => crypto.randomBytes(16).toString("hex"),
	pathApi = nodePath,
} = {}) {
	if (typeof dir !== "string" || !dir) throw new TypeError("createEngine needs a folder");
	const key = platformKey(platform, arch, musl);
	const pin = pins.platforms?.[key] || null;
	const version = pins.sdkVersion;
	const getFree = freeDisk || ((d) => defaultFreeDisk(d, fsApi));

	let state = { state: "missing" };
	let pending = null; // { token }: the one plan a confirm was shown for
	let running = false;
	let controller = null;
	const listeners = new Set();
	let lastEmit = 0;

	function emit(force) {
		const now = Date.now();
		if (!force && now - lastEmit < 100) return;
		lastEmit = now;
		for (const fn of listeners) {
			try {
				fn(state);
			} catch {}
		}
	}
	function setState(s, force = true) {
		state = s;
		emit(force);
	}

	const finalDir = () => pathApi.join(dir, version);
	const binaryPath = () => pathApi.join(finalDir(), pin.binary);

	async function installed() {
		try {
			const meta = JSON.parse(await fsApi.readFile(pathApi.join(finalDir(), "engine.json"), "utf8"));
			if (meta.version !== version || meta.integrity !== pin.integrity) return false;
			const st = await fsApi.stat(binaryPath());
			return st.isFile();
		} catch {
			return false;
		}
	}

	function checkPin() {
		if (!pin) return `No Claude engine is published for this computer (${key}).`;
		let u;
		try {
			u = new URL(pin.url);
		} catch {
			return "The pinned engine address is not valid.";
		}
		if (u.protocol !== "https:" || u.host !== pins.host || u.username || u.password) return "The pinned engine address is not an HTTPS address on the pinned host.";
		if (!parseIntegrity(pin.integrity) || !Number.isInteger(pin.size) || pin.size <= 0) return "The pinned engine checksum or size is not valid.";
		return null;
	}

	// Download with manual redirects: only https on the pinned host, a few hops at most.
	async function fetchPinned(signal) {
		let url = pin.url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const u = new URL(url);
			if (u.protocol !== "https:" || u.host !== pins.host || u.username || u.password) throw new EngineError(`The download tried to go to another address (${u.host}) and was stopped.`, "redirect");
			const res = await fetchFn(u.href, { redirect: "manual", signal, headers: { accept: "application/octet-stream" } });
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				try {
					await res.body?.cancel();
				} catch {}
				if (!loc) throw new EngineError("The download server sent a redirect without a target.", "redirect");
				url = new URL(loc, u).href;
				continue;
			}
			if (!res.ok) {
				try {
					await res.body?.cancel();
				} catch {}
				throw new EngineError(`The download server answered ${res.status}.`, "http");
			}
			return res;
		}
		throw new EngineError("The download was redirected too many times.", "redirect");
	}

	async function streamToFile(res, file, signal) {
		const declared = Number(res.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > pin.size) throw new EngineError(`The download is larger than expected (${mbText(declared)}, expected ${mbText(pin.size)}) and was stopped.`, "too-large");
		const hash = crypto.createHash("sha512");
		let received = 0;
		const fh = await fsApi.open(file, "wx");
		try {
			if (!res.body) throw new EngineError("The download server sent nothing.", "http");
			for await (const chunk of res.body) {
				if (signal.aborted) throw new EngineError("Cancelled.", "cancelled");
				received += chunk.length;
				if (received > pin.size) throw new EngineError(`The download is larger than expected (expected ${mbText(pin.size)}) and was stopped.`, "too-large");
				hash.update(chunk);
				await fh.write(chunk);
				setState({ state: "downloading", received, total: pin.size, percent: Math.min(100, Math.floor((received / pin.size) * 100)) }, false);
			}
		} finally {
			await fh.close().catch(() => {});
		}
		if (signal.aborted) throw new EngineError("Cancelled.", "cancelled");
		if (received !== pin.size) throw new EngineError("The download ended early. Try again.", "short");
		return hash.digest();
	}

	async function unpack(file, target, signal) {
		const fh = await fsApi.open(file, "r");
		try {
			const gunzip = zlib.createGunzip();
			const src = fh.createReadStream({ autoClose: false });
			const failed = pipeline(src, gunzip);
			failed.catch(() => {});
			const root = pathApi.resolve(target);
			const made = new Set();
			async function ensure(d) {
				if (made.has(d)) return;
				await fsApi.mkdir(d, { recursive: true });
				made.add(d);
			}
			const place = (rel) => {
				const full = pathApi.resolve(root, ...rel.split("/"));
				if (full !== root && !full.startsWith(root + pathApi.sep)) throw new EngineError("The download holds a path that leaves the target folder and was refused.", "unsafe-path");
				return full;
			};
			try {
				await readTar(gunzip, {
					maxTotal: Math.ceil(pin.unpackedSize * 1.02),
					onDir: async (rel) => ensure(place(rel)),
					onFile: async (rel, size, mode) => {
						const full = place(rel);
						await ensure(pathApi.dirname(full));
						const out = await fsApi.open(full, "wx", 0o644);
						return {
							write: (c) => {
								if (signal.aborted) throw new EngineError("Cancelled.", "cancelled");
								return out.write(c);
							},
							end: async () => {
								await out.close();
								if (platform !== "win32") await fsApi.chmod(full, mode & 0o111 ? 0o755 : 0o644).catch(() => {});
							},
						};
					},
				});
			} catch (e) {
				if (e instanceof EngineError) throw e;
				if (e && (e.code === "Z_DATA_ERROR" || e.code === "Z_BUF_ERROR" || /incorrect header|unexpected end/i.test(e.message || ""))) throw new EngineError("The download is not a valid package.", "bad-archive");
				throw e;
			}
			await failed.catch(() => {});
		} finally {
			await fh.close().catch(() => {});
		}
	}

	async function rmAll(p) {
		try {
			await fsApi.rm(p, { recursive: true, force: true });
		} catch {}
	}

	async function cleanOld(keepName) {
		let names = [];
		try {
			names = await fsApi.readdir(dir);
		} catch {
			return;
		}
		for (const n of names) if (n !== keepName && (n.startsWith(TMP_PREFIX) || /^\d+\.\d+\.\d+/.test(n))) await rmAll(pathApi.join(dir, n));
	}

	function readable(e) {
		if (e instanceof EngineError) return e.message;
		if (e && e.name === "AbortError") return "Cancelled.";
		if (e && (e.code === "ENOSPC" || e.code === "EDQUOT")) return "The disk is full. Free some space and try again.";
		if (e && (e.code === "EACCES" || e.code === "EPERM")) return "Pi Crust is not allowed to write to its engine folder.";
		if (e && /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|terminated/i.test(`${e.message} ${e.cause?.code || ""}`)) return "The download could not reach the server. Check the internet connection and try again.";
		return `The download failed: ${e && e.message ? e.message : String(e)}`;
	}

	return {
		async status() {
			if (running) return state;
			if (state.state === "failed") return state;
			const bad = checkPin();
			if (bad) return { state: "failed", reason: bad };
			if (await installed()) state = { state: "ready", path: binaryPath(), version };
			else state = { state: "missing" };
			return state;
		},
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		// The list for the confirm, and the token that lets exactly this plan be downloaded once.
		async plan() {
			const bad = checkPin();
			if (bad) return { ok: false, error: bad };
			if (state.state === "failed") state = { state: "missing" }; // a new try starts clean
			if (running) return { ok: false, error: "A download is already running." };
			if (await installed()) return { ok: false, error: "The Claude engine is already installed.", installed: true };
			const token = newToken();
			pending = { token };
			const text = `Pi Crust will download the Claude engine, version ${version} (${mbText(pin.size)} to download, ${mbText(pin.unpackedSize)} on disk), from ${pins.host}. It checks the download against a known checksum before it uses it. Nothing else on this computer is changed.`;
			return { ok: true, token, text, version, host: pins.host, downloadBytes: pin.size, installedBytes: pin.unpackedSize };
		},
		async download(o = {}) {
			// Everything up to `running = true` is synchronous: two calls in the same tick can't both get past it.
			if (running) return { ok: false, error: "A download is already running.", code: "busy" };
			const p = pending;
			if (!p || !o || typeof o.token !== "string" || o.token !== p.token) return { ok: false, error: "Nothing was confirmed. Look at the question again.", code: "no-confirm" };
			pending = null; // one time only
			const bad = checkPin();
			if (bad) {
				setState({ state: "failed", reason: bad });
				return { ok: false, error: bad, code: "pin" };
			}
			running = true;
			controller = new AbortController();
			const signal = controller.signal;
			const tmp = pathApi.join(dir, `${TMP_PREFIX}${crypto.randomBytes(6).toString("hex")}`);
			try {
				setState({ state: "downloading", received: 0, total: pin.size, percent: 0 });
				await fsApi.mkdir(dir, { recursive: true });
				for (const n of await fsApi.readdir(dir).catch(() => [])) if (n.startsWith(TMP_PREFIX)) await rmAll(pathApi.join(dir, n)); // leftovers of a crash
				const need = pin.size + pin.unpackedSize + 64 * MB;
				const free = await getFree(dir);
				if (free < need) throw new EngineError(`Not enough free disk space: ${mbText(need)} needed, ${mbText(free)} free.`, "disk");
				await fsApi.mkdir(tmp);
				const file = pathApi.join(tmp, "engine.tgz");
				const res = await fetchPinned(signal);
				const digest = await streamToFile(res, file, signal);
				const want = parseIntegrity(pin.integrity);
				if (digest.length !== want.length || !crypto.timingSafeEqual(digest, want)) {
					await rmAll(tmp);
					throw new EngineError("The download did not match the expected checksum. It was deleted and nothing was installed.", "hash");
				}
				const out = pathApi.join(tmp, "engine");
				await fsApi.mkdir(out);
				await unpack(file, out, signal);
				await fsApi.rm(file, { force: true });
				const bin = pathApi.join(out, pin.binary);
				const st = await fsApi.stat(bin).catch(() => null);
				if (!st || !st.isFile()) throw new EngineError("The download did not contain the engine program.", "bad-archive");
				await fsApi.writeFile(pathApi.join(out, "engine.json"), JSON.stringify({ version, integrity: pin.integrity, binary: pin.binary, installedAt: new Date().toISOString() }));
				if (signal.aborted) throw new EngineError("Cancelled.", "cancelled");
				const dest = finalDir();
				const aside = pathApi.join(dir, `${TMP_PREFIX}old-${crypto.randomBytes(4).toString("hex")}`);
				const had = await fsApi.stat(dest).then(() => true, () => false);
				if (had) await fsApi.rename(dest, aside);
				try {
					await fsApi.rename(out, dest);
				} catch (e) {
					if (had) await fsApi.rename(aside, dest).catch(() => {});
					throw e;
				}
				await rmAll(tmp);
				await cleanOld(version); // older versions and anything else left in the folder
				setState({ state: "ready", path: binaryPath(), version });
				return { ok: true, path: binaryPath(), version };
			} catch (e) {
				await rmAll(tmp);
				const code = e instanceof EngineError ? e.code : e && e.name === "AbortError" ? "cancelled" : "error";
				if (code === "cancelled" || signal.aborted) {
					setState({ state: "missing" });
					return { ok: false, error: "Cancelled.", code: "cancelled" };
				}
				const reason = readable(e);
				setState({ state: "failed", reason });
				return { ok: false, error: reason, code };
			} finally {
				running = false;
				controller = null;
			}
		},
		cancel() {
			if (!controller) return { ok: false };
			controller.abort();
			return { ok: true };
		},
		isRunning: () => running,
		// The app is quitting: stop the download; the temp folder is removed by the aborted run (or by the next start).
		stopNow() {
			if (!running) return false;
			try {
				controller?.abort();
			} catch {}
			return true;
		},
	};
}

module.exports = { createEngine, EngineError, safeEntryPath, parseIntegrity, platformKey };
