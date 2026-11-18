// The online check of an Anthropic API key, from the main process, without the engine and without spending tokens: one GET of the models list
// (https://api.anthropic.com/v1/models, headers x-api-key and anthropic-version; the Models API reference documents the endpoint). The key is sent
// to this one host only, over HTTPS, redirects are never followed, the request ends after a short time, and the key never appears in a log, an
// error or a result. fetch is injected: tests never make a real request.
//   checkKey(key, { fetch, timeoutMs }) -> { ok: true }                          the key is accepted (HTTP 200)
//                                        | { ok: false, wrong: true, rejected: true, error }   Anthropic refused it: HTTP 401 WITH its JSON error of type
//                                          authentication_error, and nothing else (`rejected` is the only reason a stored key may be deleted)
//                                        | { ok: false, wrong: true, error }     a key that cannot be sent at all (empty, control characters): nothing was asked
//                                        | { ok: false, unreachable: true, error } no verdict, "could not be checked": network down, timeout, redirect, rate limit, 5xx, a 403,
//                                          a 401 whose answer is not Anthropic's JSON error (a proxy or login page) ...
"use strict";

const URL_MODELS = "https://api.anthropic.com/v1/models?limit=1";
const API_VERSION = "2023-06-01";
const TIMEOUT_MS = 8000;
const MAX_BODY = 8192; // only the small JSON error is read, and only for a 401

// The answer of a 401 is Anthropic's error: {"type":"error","error":{"type":"authentication_error",...}}. Anything else (an HTML page of a proxy or
// a login wall, a different error type, an unreadable or oversized body) is not a verdict on the key. The body is never returned or logged.
async function isAuthError(res) {
	try {
		if (!res || typeof res.text !== "function") return false;
		const text = await res.text();
		if (typeof text !== "string" || text.length > MAX_BODY) return false;
		const j = JSON.parse(text);
		return !!j && j.type === "error" && !!j.error && j.error.type === "authentication_error";
	} catch {
		return false;
	}
}

async function checkKey(key, { fetch: doFetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
	if (typeof key !== "string" || !key.trim()) return { ok: false, wrong: true, error: "Enter your key first." };
	if (typeof doFetch !== "function") return { ok: false, unreachable: true, error: "No network access is available to check the key." };
	const k = key.trim();
	// A header value cannot hold a newline or other control characters: a key like that is wrong by shape, and nothing is sent.
	if (/[^\x21-\x7e]/.test(k)) return { ok: false, wrong: true, error: "That does not look like a key." };
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await doFetch(URL_MODELS, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "x-api-key": k, "anthropic-version": API_VERSION, accept: "application/json" } });
		const st = res && res.status;
		if (st === 401 && (await isAuthError(res))) return { ok: false, wrong: true, rejected: true, error: "Anthropic did not accept this key." };
		try {
			if (res && res.body && typeof res.body.cancel === "function") await res.body.cancel(); // no other body is read
		} catch {}
		if (st === 200) return { ok: true };
		return { ok: false, unreachable: true, error: `Anthropic could not check the key right now (status ${Number.isInteger(st) ? st : "unknown"}).` };
	} catch {
		return { ok: false, unreachable: true, error: "Pi Crust could not reach Anthropic to check the key." };
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { checkKey, URL_MODELS, API_VERSION, TIMEOUT_MS };
