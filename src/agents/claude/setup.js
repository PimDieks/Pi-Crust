// First-use setup of the Claude Agent (phase 7): the two steps of the card at the top of a new Claude Agent chat, in the main process.
//   Step 1, the API key: saved here (checked with one tiny request through the adapter, then stored by keystore.js). The key arrives as an
//   argument, goes to the adapter and the store, and is not kept, logged or put in any state or error text.
//   Step 2, the engine: planned, then downloaded with the plan's one-time token (engine.js refuses a download without it).
// What the window sees is only state(): { key, engine, ready, started, limitUsd }. No dialog, no key, no path.
//
//   state()         -> the object above (async: the key store and the engine are asked)
//   saveKey(key)    -> { ok: true } | { ok: false, error }     the check, then the store. Without an engine the key is stored first and checked
//                      as soon as the engine is there (the check runs the engine); a wrong key is then removed again and step 1 shows why.
//   removeKey()     -> { ok } | { ok: false, error }           only a stored key; one in ANTHROPIC_API_KEY is not ours to remove
//   enginePlan()    -> engine.plan(): { ok, token, text, ... }
//   engineDownload({ token }) / engineCancel()
//   setLimit(n)     -> { ok, limitUsd }                         the spend limit per run (a setting, default 5)
//   markStarted()   -> the Setup panel lists the Claude Agent rows from now on
//   isReady() / enginePath() / onReady(fn): synchronous views of the last state, for starting chats
"use strict";

const DEFAULT_LIMIT_USD = 5;
const MAX_LIMIT_USD = 1000;
const MIN_LIMIT_USD = 0.5;
const SETTING = { limit: "claudeMaxBudgetUsd", started: "claudeAgentStartedAt", unchecked: "claudeKeyUnchecked" };
const NO_ENGINE_YET = "The Claude engine is not downloaded yet.";

// A readable reason for a failed key check. Never contains the key (the adapter scrubs it already; this only reshapes).
function keyReason(error) {
	const t = String(error == null ? "" : error);
	if (/invalid|authenticat|unauthori[sz]ed|\b401\b|\b403\b|api key|x-api-key|not accepted/i.test(t)) return "Anthropic did not accept this key. Check that you copied all of it, then try again.";
	if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket|offline|proxy|timed out|could not reach/i.test(t)) return "Pi Crust could not reach Anthropic to check the key. Check your internet connection and try again.";
	if (/engine/i.test(t) && /(not installed|not found|ENOENT|spawn)/i.test(t)) return "The key could not be checked because the Claude engine is not ready. Download the engine first.";
	const short = t.replace(/\s+/g, " ").trim().slice(0, 160);
	return short ? `The key could not be checked: ${short}` : "The key could not be checked. Try again.";
}

const mb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / 1e6)} MB` : null); // decimal, as download sizes are usually quoted

function createSetup({ keystore, engine, auth, settings, send = () => {}, hold = async () => {} } = {}) {
	if (!keystore || !engine || !auth || !settings) throw new TypeError("createSetup needs keystore, engine, auth and settings");
	let busy = false; // a key is being checked
	let keyFail = null; // { reason } of the last failed save or check, until the next try
	let ksCache = null;
	let cache = { keyDone: false, engineDone: false, enginePath: null, enginePathVersion: null };
	const readyListeners = new Set();
	let wasReady = false;

	const limit = () => {
		const v = Number(settings.get()[SETTING.limit]);
		return Number.isFinite(v) && v > 0 ? v : DEFAULT_LIMIT_USD;
	};

	async function state() {
		let ks = ksCache; // the store is asked again only after the key changed (download progress asks for the state ten times a second)
		if (!ks) {
			ks = { source: "none" };
			try {
				ks = (await keystore.status()) || ks;
			} catch {}
			ksCache = ks;
		}
		let es = { state: "missing" };
		try {
			es = (await engine.status()) || es;
		} catch {}
		const info = engine.info ? engine.info() : {};
		const unchecked = !!settings.get()[SETTING.unchecked] && ks.source === "stored";
		let key;
		if (busy) key = { state: "checking" };
		else if (ks.source === "stored" || ks.source === "env") {
			keyFail = null;
			key = { state: "done", source: ks.source, ...(unchecked ? { pendingCheck: true } : {}) };
		} else if (keyFail) key = { state: "failed", reason: keyFail.reason };
		else if (ks.reason) key = { state: "failed", reason: ks.reason };
		else key = { state: "todo" };
		let eng;
		if (es.state === "downloading") eng = { state: "downloading", percent: es.percent || 0, received: es.received || 0, total: es.total || info.downloadBytes || 0 };
		else if (es.state === "ready") eng = { state: "done", version: es.version || info.version || null };
		else if (es.state === "failed") eng = { state: "failed", reason: es.reason || "The download failed." };
		else eng = { state: "todo" };
		eng.sizeText = mb(info.downloadBytes) ? `about ${mb(info.downloadBytes)}` : null;
		eng.version = eng.version || info.version || null;
		cache = { keyDone: key.state === "done", engineDone: eng.state === "done", enginePath: es.state === "ready" ? es.path : null };
		const ready = cache.keyDone && cache.engineDone && !key.pendingCheck;
		return { key, engine: eng, ready, started: !!settings.get()[SETTING.started], limitUsd: limit() };
	}

	async function emit(keyChanged = false) {
		if (keyChanged) ksCache = null;
		const s = await state();
		send("claude:setup", s);
		if (s.ready && !wasReady) for (const fn of [...readyListeners]) fn();
		wasReady = s.ready;
		return s;
	}

	// The check of a key that was stored before the engine was there. A wrong one is removed again.
	async function checkStored() {
		if (busy || !settings.get()[SETTING.unchecked]) return;
		busy = true;
		await emit();
		try {
			await hold("keyCheck");
			const r = await keystore.read();
			const res = r && r.key ? await auth.check(r.key) : { ok: false, error: "The stored key could not be read." };
			if (res.ok) settings.set({ [SETTING.unchecked]: false });
			else {
				keyFail = { reason: keyReason(res.error) };
				await keystore.clear().catch(() => {});
				settings.set({ [SETTING.unchecked]: false });
			}
		} catch (e) {
			keyFail = { reason: keyReason(e && e.message) };
			await keystore.clear().catch(() => {});
			settings.set({ [SETTING.unchecked]: false });
		} finally {
			busy = false;
			await emit(true);
		}
	}

	engine.onChange(() => {
		emit().then((s) => {
			if (s.engine.state === "done" && settings.get()[SETTING.unchecked]) checkStored();
		});
	});

	return {
		state,
		emit,
		async saveKey(key) {
			if (busy) return { ok: false, error: "A key is being checked. Wait a moment." };
			if (typeof key !== "string" || !key.trim()) return { ok: false, error: "Enter your key first." };
			busy = true;
			keyFail = null;
			await emit();
			try {
				await hold("keyCheck");
				const es = await engine.status();
				if (es && es.state === "ready") {
					const r = await auth.login(key); // the check (one tiny request), then the store
					if (!r.ok) {
						keyFail = { reason: keyReason(r.error) };
						return { ok: false, error: keyFail.reason };
					}
					settings.set({ [SETTING.unchecked]: false });
				} else {
					await keystore.set(key); // checked once the engine is there
					settings.set({ [SETTING.unchecked]: true });
				}
				return { ok: true };
			} catch (e) {
				keyFail = { reason: e && e.name === "KeystoreError" ? String(e.message) : keyReason(e && e.message) };
				return { ok: false, error: keyFail.reason };
			} finally {
				busy = false;
				await emit(true);
			}
		},
		async removeKey() {
			try {
				await keystore.clear();
				settings.set({ [SETTING.unchecked]: false });
				keyFail = null;
				await emit(true);
				return { ok: true };
			} catch (e) {
				return { ok: false, error: e && e.message ? String(e.message) : "The key could not be removed." };
			}
		},
		async enginePlan() {
			const r = await engine.plan();
			await emit();
			return r;
		},
		async engineDownload(o) {
			const r = await engine.download(o && typeof o === "object" ? { token: o.token } : {});
			await emit();
			return r;
		},
		async engineCancel() {
			const r = engine.cancel();
			await emit();
			return r;
		},
		setLimit(n) {
			const v = Number(n);
			if (!Number.isFinite(v) || v < MIN_LIMIT_USD || v > MAX_LIMIT_USD) return { ok: false, error: `Enter an amount from $${MIN_LIMIT_USD.toFixed(2)} to $${MAX_LIMIT_USD}.` };
			const rounded = Math.round(v * 100) / 100;
			settings.set({ [SETTING.limit]: rounded });
			return { ok: true, limitUsd: rounded };
		},
		markStarted() {
			if (settings.get()[SETTING.started]) return;
			settings.set({ [SETTING.started]: Date.now() });
			emit().catch(() => {}); // the Setup panel lists the Claude Agent rows from now on
		},
		isReady: () => cache.keyDone && cache.engineDone && !settings.get()[SETTING.unchecked],
		enginePath: () => (cache.enginePath ? { path: cache.enginePath } : { path: null, reason: NO_ENGINE_YET }),
		onReady(fn) {
			readyListeners.add(fn);
			return () => readyListeners.delete(fn);
		},
	};
}

module.exports = { createSetup, keyReason, DEFAULT_LIMIT_USD, SETTING };
