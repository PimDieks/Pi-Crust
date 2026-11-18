// First-use setup of the Claude Agent (phase 7): the two steps of the card at the top of a new Claude Agent chat, in the main process.
//   Step 1, the API key: saved here (tested with one request that costs no tokens, keycheck.js, then stored by keystore.js). The key arrives as
//   an argument, goes to the check and the store, and is not kept, logged or put in any state or error text.
//   Step 2, the engine: planned, then downloaded with the plan's one-time token (engine.js refuses a download without it).
// What the window sees is only state(): { key, engine, ready, started, limitUsd }. No dialog, no key, no path.
//
//   state()         -> the object above (async: the key store and the engine are asked)
//   saveKey(key)    -> { ok: true } | { ok: true, unchecked: true } | { ok: false, error }   saving tests the key (no engine needed). A wrong key is
//                      not stored and the card says why. With no network the key is stored and marked "not checked yet", and checked later (checkStored).
//   removeKey()     -> { ok } | { ok: false, error }           only a stored key; one in ANTHROPIC_API_KEY is not ours to remove
//   enginePlan({ senderId, chatId }) -> engine.plan(): { ok, token, text, ... }, only for a window and a Claude Agent chat waiting in setup
//   engineDownload({ token, senderId, chatId }) / engineCancel()
//   setLimit(n)     -> { ok, limitUsd }                         the spend limit per run (a setting, default 5)
//   markStarted()   -> the Setup panel lists the Claude Agent rows from now on
//   isReady() / enginePath() / onReady(fn): synchronous views of the last state, for starting chats
"use strict";

const { checkKey: onlineCheck } = require("./keycheck");

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

// The engine plan and download are only accepted for a window and a chat that is waiting for the setup (the token never works for anything else).
const PLANS_PER_MINUTE = 3;
const REFUSED = {
	state: "The engine is not missing, so there is nothing to download.",
	chat: "Start a Claude Agent chat first: the engine is downloaded from its setup card.",
	busy: "A download is already running.",
	rate: "Too many download plans in a minute. Wait a moment and try again.",
	token: "Nothing was confirmed. Look at the question again.",
};

function createSetup({ keystore, engine, auth, settings, send = () => {}, hold = async () => {}, waitingChats = () => [], windowOf = null, now = Date.now, plansPerMinute = PLANS_PER_MINUTE, fetch: fetchApi } = {}) {
	const checkKey = (key) => onlineCheck(key, fetchApi ? { fetch: fetchApi } : {});
	if (!keystore || !engine || !auth || !settings) throw new TypeError("createSetup needs keystore, engine, auth and settings");
	let busy = false; // a key is being checked
	let issued = null; // { token, senderId, chatId }: the one plan handed out, bound to its window and chat
	let downloading = false; // our own download call is running
	const planTimes = []; // when plans were issued (last minute)
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

	// The check of a key that was stored without a verdict (the network was down when it was saved). Not the engine's: the same one request
	// as on save (keycheck.js). Only a 401 with Anthropic's authentication_error removes the key; everything else (no network, a 403, a proxy page) keeps it "not checked yet".
	async function checkStored() {
		if (busy || !settings.get()[SETTING.unchecked]) return;
		busy = true;
		await emit();
		try {
			await hold("keyCheck");
			const r = await keystore.read();
			const res = r && r.key ? await checkKey(r.key) : { ok: false, error: "The stored key could not be read." }; // unreadable: no verdict, nothing is deleted
			if (res.ok) settings.set({ [SETTING.unchecked]: false });
			else if (res.rejected) {
				keyFail = { reason: keyReason(res.error) };
				await keystore.clear().catch(() => {});
				settings.set({ [SETTING.unchecked]: false });
			}
		} catch {
			// no verdict: the key stays stored and unchecked
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
				// Saving tests the key, with or without the engine: one request that costs no tokens (keycheck.js). A wrong key is not stored;
				// with no network the key is stored and marked "not checked yet", and checked later.
				const res = await checkKey(key);
				if (res.wrong) {
					keyFail = { reason: keyReason(res.error) };
					return { ok: false, error: keyFail.reason };
				}
				await keystore.set(key);
				settings.set({ [SETTING.unchecked]: !res.ok });
				return res.ok ? { ok: true } : { ok: true, unchecked: true };
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
		// from: { senderId, chatId } of the window that asks. Refused unless (a) the engine is missing or failed, (b) a Claude Agent chat waits in
		// setup (the named one: no chat id, no plan; the sender must be its window), (c) no download runs, (d) fewer than plansPerMinute plans came in the last minute.
		async enginePlan(from = {}) {
			const es = (await engine.status().catch(() => null)) || { state: "missing" };
			if (es.state === "ready") return { ok: false, error: "The Claude engine is already installed.", installed: true };
			if (downloading || es.state === "downloading") return { ok: false, error: REFUSED.busy };
			if (es.state !== "missing" && es.state !== "failed") return { ok: false, error: REFUSED.state };
			const waiting = [...waitingChats()];
			// The chat must be named (no fallback to "the first waiting chat"), must wait in setup, and the sender must be the window that shows it.
			const chatId = typeof from.chatId === "string" && waiting.includes(from.chatId) ? from.chatId : null;
			if (chatId === null) return { ok: false, error: REFUSED.chat };
			if (typeof windowOf === "function" && (from.senderId === undefined || from.senderId === null || from.senderId !== windowOf(chatId))) return { ok: false, error: REFUSED.chat };
			const t = now();
			while (planTimes.length && t - planTimes[0] >= 60000) planTimes.shift();
			if (planTimes.length >= plansPerMinute) return { ok: false, error: REFUSED.rate };
			planTimes.push(t);
			const r = await engine.plan();
			issued = r && r.ok ? { token: r.token, senderId: from.senderId, chatId } : null;
			await emit();
			return r;
		},
		async engineDownload(o = {}) {
			const spent = issued; // one time only: a wrong try spends the plan too
			issued = null;
			const es = (await engine.status().catch(() => null)) || { state: "missing" };
			if (es.state === "ready") return { ok: false, error: "The Claude engine is already installed.", installed: true, code: "installed" };
			if (downloading || es.state === "downloading") return { ok: false, error: REFUSED.busy, code: "busy" };
			if (es.state !== "missing" && es.state !== "failed") return { ok: false, error: REFUSED.state, code: "state" };
			const ok = spent && typeof o.token === "string" && o.token === spent.token && o.senderId === spent.senderId && waitingChats().includes(spent.chatId) && o.chatId === spent.chatId && (typeof windowOf !== "function" || o.senderId === windowOf(spent.chatId));
			if (!ok) return { ok: false, error: REFUSED.token, code: "no-confirm" };
			downloading = true;
			try {
				const r = await engine.download({ token: o.token });
				await emit();
				return r;
			} finally {
				downloading = false;
			}
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
			emit().catch(() => {}); // the Setup panel row shows the new amount
			return { ok: true, limitUsd: rounded };
		},
		markStarted() {
			checkStored().catch(() => {}); // a key that is still not checked gets its check when a Claude Agent chat starts
			if (settings.get()[SETTING.started]) return;
			settings.set({ [SETTING.started]: Date.now() });
			emit().catch(() => {}); // the Setup panel lists the Claude Agent rows from now on
		},
		checkStored, // also on app start: a key that is still not checked
		isReady: () => cache.keyDone && cache.engineDone && !settings.get()[SETTING.unchecked],
		enginePath: () => (cache.enginePath ? { path: cache.enginePath } : { path: null, reason: NO_ENGINE_YET }),
		onReady(fn) {
			readyListeners.add(fn);
			return () => readyListeners.delete(fn);
		},
	};
}

module.exports = { createSetup, keyReason, DEFAULT_LIMIT_USD, SETTING };
