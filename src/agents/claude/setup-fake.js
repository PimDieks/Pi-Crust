// Stand-ins for the key store and the engine download, for the offscreen self-test only (src/claude-setup-main.js loads this file only in an
// unpackaged app with PI_CRUST_SELFTEST=1, PI_CRUST_SELFTEST_CLAUDE=fake and a stand-in SDK in PI_CRUST_CLAUDE_SDK). Nothing here touches the disk, the
// network or the real key store. The window's test drives them with claude:fakeSet; they keep the real contracts (keystore.js, engine.js),
// including the one-time token of the download.
"use strict";

function createFakes() {
	const holds = new Map(); // name -> { armed, waiters }
	const control = {
		hold(name) {
			// resolves at once unless the test armed this name; then when it is released
			const h = holds.get(name);
			if (!h || !h.armed) return Promise.resolve();
			return new Promise((r) => h.waiters.push(r));
		},
		arm(name) {
			holds.set(name, { armed: true, waiters: [] });
		},
		release(name) {
			const h = holds.get(name);
			if (!h) return;
			h.armed = false;
			for (const r of h.waiters.splice(0)) r();
		},
	};

	let stored = null;
	const keystore = {
		async set(key) {
			if (typeof key !== "string" || !key.trim()) throw Object.assign(new Error("Enter a key to store."), { name: "KeystoreError", code: "EMPTY" });
			stored = key.trim();
			return { ok: true };
		},
		async status() {
			return stored ? { source: "stored" } : { source: "none" };
		},
		async clear() {
			stored = null;
			return { ok: true };
		},
		async read() {
			return stored ? { source: "stored", key: stored } : { source: "none", key: null };
		},
	};

	let state = { state: "missing" };
	let pending = null;
	let abort = null;
	const listeners = new Set();
	const set = (s) => {
		state = s;
		for (const fn of [...listeners]) fn(state);
	};
	const TOTAL = 175132626;
	const engine = {
		async status() {
			return state;
		},
		info: () => ({ version: "0.3.327", downloadBytes: TOTAL, installedBytes: 379537120 }),
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		async plan() {
			if (state.state === "ready") return { ok: false, error: "The Claude engine is already installed.", installed: true };
			if (state.state === "downloading") return { ok: false, error: "A download is already running." };
			if (state.state === "failed") state = { state: "missing" };
			pending = { token: Math.random().toString(16).slice(2) + Date.now().toString(16) };
			return { ok: true, token: pending.token, text: "Pi Crust will download the Claude engine (test stand-in).", version: "0.3.327", host: "registry.npmjs.org", downloadBytes: TOTAL, installedBytes: 379537120 };
		},
		async download(o = {}) {
			const p = pending;
			pending = null; // one time only
			if (!p || !o || o.token !== p.token) return { ok: false, error: "Nothing was confirmed. Look at the question again.", code: "no-confirm" };
			if (state.state === "downloading") return { ok: false, error: "A download is already running.", code: "busy" };
			set({ state: "downloading", received: 0, total: TOTAL, percent: 0 });
			const outcome = await new Promise((res) => (abort = res)); // the test says how it ends (or Cancel does)
			abort = null;
			if (outcome.kind === "ok") {
				set({ state: "ready", path: "C:\\fake\\claude.exe", version: "0.3.327" });
				return { ok: true, path: "C:\\fake\\claude.exe", version: "0.3.327" };
			}
			if (outcome.kind === "cancel") {
				set({ state: "missing" });
				return { ok: false, error: "Cancelled.", code: "cancelled" };
			}
			set({ state: "failed", reason: outcome.reason });
			return { ok: false, error: outcome.reason, code: "disk" };
		},
		cancel() {
			if (!abort) return { ok: false };
			abort({ kind: "cancel" });
			return { ok: true };
		},
		stopNow: () => false,
	};

	// The test's commands. Only these exist; every other value is ignored.
	function fakeSet(cmd) {
		if (!cmd || typeof cmd !== "object") return { ok: false };
		if (cmd.hold === "keyCheck") control.arm("keyCheck");
		if (cmd.release === "keyCheck") control.release("keyCheck");
		if (cmd.engine === "progress" && state.state === "downloading") {
			const percent = Math.max(0, Math.min(99, Number(cmd.percent) || 0));
			set({ state: "downloading", received: Math.round((TOTAL * percent) / 100), total: TOTAL, percent });
		}
		if (cmd.engine === "finish" && abort) abort({ kind: "ok" });
		if (cmd.engine === "fail" && abort) abort({ kind: "fail", reason: "Not enough free disk space: 650 MB needed, 120 MB free." });
		if (cmd.engine === "ready") set({ state: "ready", path: "C:\\fake\\claude.exe", version: "0.3.327" });
		if (cmd.engine === "reset") {
			if (abort) abort({ kind: "cancel" });
			set({ state: "missing" });
		}
		if (cmd.key === "reset") stored = null;
		if (cmd.net === "down") net.down = true;
		if (cmd.net === "up") net.down = false;
		return { ok: true };
	}

	// The key test (keycheck.js) never reaches the network in a self-test: this fetch answers like the API does. net "down" throws (no connection),
	// otherwise the stand-in's rejected key gets a 401 and every other key a 200.
	const net = { down: false };
	const REJECTED = "sk-ant-test-rejected-0000";
	const fetch = async (url, init) => {
		if (net.down) throw new TypeError("fetch failed (no connection in the test)");
		const key = init && init.headers && init.headers["x-api-key"];
		if (key !== REJECTED) return { status: 200 };
		return { status: 401, text: async () => JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) }; // as the API answers
	};

	return { keystore, engine, control, fakeSet, fetch, net };
}

module.exports = { createFakes };
