// The Claude Agent's first-use setup (src/agents/claude/setup.js) with the self-test fakes: both steps, the one-time token, a key stored before
// the engine and checked after it, and that no state or error ever holds the key.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSetup, keyReason } = require("../src/agents/claude/setup");
const { createFakes } = require("../src/agents/claude/setup-fake");

const GOOD = "sk-ant-test-good-0000";
const BAD = "sk-ant-test-rejected-0000";

// net: what the injected fetch answers (never a real request): "ok" (200), "wrong" (401 for every key), "down" (throws), "limit" (429).
function make({ waiting = ["c1"], plansPerMinute } = {}) {
	const f = createFakes();
	const store = {};
	const sent = [];
	const fetches = [];
	const net = { mode: "ok" };
	const chats = [...waiting];
	let clock = 1000000;
	const fetch = async (url, init) => {
		fetches.push({ url, init });
		const key = init && init.headers && init.headers["x-api-key"];
		if (net.mode === "down") throw new TypeError("fetch failed ENOTFOUND api.anthropic.com " + key);
		if (net.mode === "limit") return { status: 429 };
		return { status: net.mode === "wrong" || key === BAD ? 401 : 200 };
	};
	const auth = { check: async () => ({ ok: true }), login: async () => ({ ok: true }) }; // the engine's check is no longer used by saving
	const setup = createSetup({ keystore: f.keystore, engine: f.engine, auth, settings: { get: () => store, set: (p) => Object.assign(store, p) }, send: (c, p) => sent.push([c, p]), hold: (n) => f.control.hold(n), waitingChats: () => chats, fetch, now: () => clock, plansPerMinute });
	return { f, setup, store, sent, fetches, net, chats, tick: (ms) => (clock += ms) };
}
const FROM = { senderId: 7, chatId: "c1" };
const settle = () => new Promise((r) => setTimeout(r, 20));

test("both steps start to do; the size is known before a click", async () => {
	const { setup } = make();
	const s = await setup.state();
	assert.equal(s.key.state, "todo");
	assert.equal(s.engine.state, "todo");
	assert.match(s.engine.sizeText, /^about 175 MB$/);
	assert.equal(s.ready, false);
	assert.equal(setup.isReady(), false);
});

test("a download without the plan's token fetches nothing; with it, it runs once", async () => {
	const { setup, f } = make();
	const bad = await setup.engineDownload({ token: "nope", ...FROM });
	assert.equal(bad.ok, false);
	assert.equal(bad.code, "no-confirm");
	assert.equal((await setup.state()).engine.state, "todo");
	const plan = await setup.enginePlan(FROM);
	assert.ok(plan.ok && plan.token);
	const run = setup.engineDownload({ token: plan.token, ...FROM });
	await settle();
	assert.equal((await setup.state()).engine.state, "downloading");
	f.fakeSet({ engine: "progress", percent: 40 });
	await settle();
	assert.equal((await setup.state()).engine.percent, 40);
	f.fakeSet({ engine: "finish" });
	assert.equal((await run).ok, true);
	assert.equal((await setup.state()).engine.state, "done");
	assert.equal(setup.enginePath().path !== null, true);
	// the same token again: spent
	assert.equal((await setup.engineDownload({ token: plan.token, ...FROM })).ok, false);
});

test("Cancel returns to to do; a failure keeps its reason until the next plan", async () => {
	const { setup, f } = make();
	let plan = await setup.enginePlan(FROM);
	const run = setup.engineDownload({ token: plan.token, ...FROM });
	await settle();
	assert.equal((await setup.engineCancel()).ok, true);
	assert.equal((await run).code, "cancelled");
	assert.equal((await setup.state()).engine.state, "todo");
	plan = await setup.enginePlan(FROM);
	const run2 = setup.engineDownload({ token: plan.token, ...FROM });
	await settle();
	f.fakeSet({ engine: "fail" });
	await run2;
	const s = await setup.state();
	assert.equal(s.engine.state, "failed");
	assert.match(s.engine.reason, /Not enough free disk space/);
});

test("saving a key tests it, with or without the engine; a wrong one is not stored and the card says why", async () => {
	for (const engineReady of [false, true]) {
		const { setup, f, fetches } = make();
		if (engineReady) f.fakeSet({ engine: "ready" });
		const bad = await setup.saveKey(BAD);
		assert.equal(bad.ok, false);
		assert.match(bad.error, /did not accept this key/);
		let s = await setup.state();
		assert.equal(s.key.state, "failed");
		assert.match(s.key.reason, /did not accept this key/);
		assert.equal((await f.keystore.status()).source, "none", "not stored");
		assert.equal(fetches.length, 1, "one request");
		assert.ok(!JSON.stringify(s).includes(BAD) && !bad.error.includes(BAD));
		const ok = await setup.saveKey(GOOD);
		assert.equal(ok.ok, true);
		s = await setup.state();
		assert.equal(s.key.state, "done");
		assert.equal(s.key.pendingCheck, undefined, "checked");
		assert.equal(s.ready, engineReady);
		assert.ok(!JSON.stringify(s).includes(GOOD));
	}
});

test("the key test is the models list request: one GET, the key in x-api-key, HTTPS to api.anthropic.com only, no redirect, a short timeout, no body", async () => {
	const { setup, fetches } = make();
	await setup.saveKey(GOOD);
	assert.equal(fetches.length, 1);
	const { url, init } = fetches[0];
	assert.equal(new URL(url).origin, "https://api.anthropic.com");
	assert.equal(new URL(url).pathname, "/v1/models");
	assert.equal(init.method, "GET");
	assert.equal(init.redirect, "manual");
	assert.equal(init.headers["x-api-key"], GOOD);
	assert.match(init.headers["anthropic-version"], /^\d{4}-\d{2}-\d{2}$/);
	assert.ok(init.signal && typeof init.signal.aborted === "boolean", "a timeout signal");
	assert.equal(init.body, undefined);
	assert.ok(!Object.keys(init.headers).some((h) => /^authorization$/i.test(h)));
	const { TIMEOUT_MS } = require("../src/agents/claude/keycheck");
	assert.ok(TIMEOUT_MS <= 10000);
});

test("a redirect is not followed and gives no verdict; a hung request ends after the timeout; a key that cannot be a header sends nothing", async () => {
	const { checkKey } = require("../src/agents/claude/keycheck");
	let calls = 0;
	const redirect = await checkKey(GOOD, { fetch: async () => (calls++, { status: 302, headers: { location: "https://evil.example/" } }) });
	assert.equal(calls, 1);
	assert.equal(redirect.ok, false);
	assert.equal(redirect.unreachable, true);
	const t0 = Date.now();
	const hung = await checkKey(GOOD, { timeoutMs: 40, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted " + GOOD)))) });
	assert.equal(hung.unreachable, true);
	assert.ok(Date.now() - t0 < 1000);
	assert.ok(!JSON.stringify(hung).includes(GOOD), "the key is not in the result or error");
	for (const bad of ["", "   ", "line\nbreak", "sk-ant-‮evil"]) {
		let sent = 0;
		const r = await checkKey(bad, { fetch: async () => (sent++, { status: 200 }) });
		assert.equal(r.ok, false, JSON.stringify(bad));
		assert.equal(sent, 0, "nothing is sent for a key that cannot be a header value");
	}
});

test("network down: the key is stored, marked not checked yet, and checked later; a wrong one is then removed with its reason", async () => {
	const { setup, f, fetches, net, store } = make();
	net.mode = "down";
	const r = await setup.saveKey(GOOD);
	assert.deepEqual(r, { ok: true, unchecked: true });
	let s = await setup.state();
	assert.equal(s.key.state, "done");
	assert.equal(s.key.pendingCheck, true, "not checked yet");
	assert.equal(s.ready, false);
	assert.equal(store.claudeKeyUnchecked, true);
	assert.ok(!JSON.stringify(s).includes(GOOD));
	await setup.checkStored(); // still down: nothing changes
	s = await setup.state();
	assert.equal(s.key.pendingCheck, true);
	assert.equal((await f.keystore.status()).source, "stored");
	net.mode = "ok";
	await setup.checkStored();
	s = await setup.state();
	assert.equal(s.key.pendingCheck, undefined);
	assert.equal(store.claudeKeyUnchecked, false);
	assert.equal(fetches.length, 3);
	// the same with a key that turns out wrong
	const w = make();
	w.net.mode = "down";
	await w.setup.saveKey(BAD);
	w.net.mode = "wrong";
	await w.setup.checkStored();
	s = await w.setup.state();
	assert.equal(s.key.state, "failed");
	assert.match(s.key.reason, /did not accept this key/);
	assert.equal((await w.f.keystore.status()).source, "none");
	assert.ok(!JSON.stringify(s).includes(BAD));
	// a rate limit or a server error is no verdict either
	const l = make();
	l.net.mode = "limit";
	assert.deepEqual(await l.setup.saveKey(GOOD), { ok: true, unchecked: true });
});

test("Remove key, and the spend limit setting", async () => {
	const { setup } = make();
	await setup.saveKey(GOOD);
	assert.equal((await setup.removeKey()).ok, true);
	assert.equal((await setup.state()).key.state, "todo");
	assert.equal((await setup.state()).limitUsd, 5);
	assert.equal(setup.setLimit(0.1).ok, false);
	assert.equal(setup.setLimit("abc").ok, false);
	assert.deepEqual(setup.setLimit(7.5), { ok: true, limitUsd: 7.5 });
	assert.equal((await setup.state()).limitUsd, 7.5);
});

test("the Setup panel flag is set once and the state is announced", async () => {
	const { setup, sent } = make();
	assert.equal((await setup.state()).started, false);
	setup.markStarted();
	await settle();
	assert.equal((await setup.state()).started, true);
	assert.ok(sent.some(([c, p]) => c === "claude:setup" && p.started === true));
});

test("key reasons are readable and never echo a key", () => {
	assert.match(keyReason("401 invalid x-api-key"), /did not accept/);
	assert.match(keyReason("getaddrinfo ENOTFOUND api.anthropic.com"), /could not reach Anthropic/);
	assert.match(keyReason(""), /could not be checked/);
});

// --- the engine plan and download are bound to a waiting chat and a window (review round) ---------------------------------------------
const wrong = (r, re) => (assert.equal(r.ok, false), re && assert.match(r.error, re));

test("a plan is refused when no Claude Agent chat waits in setup, or for a chat that does not", async () => {
	const none = make({ waiting: [] });
	wrong(await none.setup.enginePlan(FROM), /Start a Claude Agent chat/);
	const other = make({ waiting: ["c1"] });
	wrong(await other.setup.enginePlan({ senderId: 7, chatId: "not-a-chat" }), /Start a Claude Agent chat/);
	assert.equal((await other.setup.enginePlan({ senderId: 7, chatId: "c1" })).ok, true);
});

test("a plan is refused when the engine is ready or a download runs; a failed engine may be planned again", async () => {
	const ready = make();
	ready.f.fakeSet({ engine: "ready" });
	const r = await ready.setup.enginePlan(FROM);
	wrong(r, /already installed/);
	assert.equal(r.installed, true);
	const busy = make();
	const plan = await busy.setup.enginePlan(FROM);
	const run = busy.setup.engineDownload({ token: plan.token, ...FROM });
	await settle();
	wrong(await busy.setup.enginePlan(FROM), /already running/);
	busy.f.fakeSet({ engine: "fail" });
	await run;
	assert.equal((await busy.setup.state()).engine.state, "failed");
	assert.equal((await busy.setup.enginePlan(FROM)).ok, true, "failed: a new plan is fine");
});

test("no more than a few plans in a minute; the count starts again after the minute", async () => {
	const t = make();
	for (let i = 0; i < 3; i++) assert.equal((await t.setup.enginePlan(FROM)).ok, true, "plan " + i);
	wrong(await t.setup.enginePlan(FROM), /Too many/);
	t.tick(61000);
	assert.equal((await t.setup.enginePlan(FROM)).ok, true);
});

test("a download is refused for a token of another window or another chat, a guess, after the chat left, twice, or with the engine ready", async () => {
	const t = make({ waiting: ["c1", "c2"], plansPerMinute: 99 });
	let plan = await t.setup.enginePlan(FROM);
	wrong(await t.setup.engineDownload({ token: plan.token, senderId: 8, chatId: "c1" }), /Nothing was confirmed/);
	plan = await t.setup.enginePlan(FROM); // a wrong try spent the plan
	wrong(await t.setup.engineDownload({ token: plan.token, senderId: 7, chatId: "c2" }), /Nothing was confirmed/);
	wrong(await t.setup.engineDownload({ token: "guess", ...FROM }), /Nothing was confirmed/);
	plan = await t.setup.enginePlan(FROM);
	const left = t.chats.splice(0); // the chat is gone
	wrong(await t.setup.engineDownload({ token: plan.token, ...FROM }), /Nothing was confirmed/);
	t.chats.push(...left);
	assert.equal((await t.setup.state()).engine.state, "todo", "nothing was downloaded by any of these");
	plan = await t.setup.enginePlan(FROM);
	const run = t.setup.engineDownload({ token: plan.token, ...FROM });
	await settle();
	assert.equal((await t.setup.state()).engine.state, "downloading");
	wrong(await t.setup.engineDownload({ token: plan.token, ...FROM }), /already running|Nothing was confirmed/);
	t.f.fakeSet({ engine: "finish" });
	assert.equal((await run).ok, true);
	// ready: a download is refused even with a token that was valid
	const r = make();
	const p2 = await r.setup.enginePlan(FROM);
	r.f.fakeSet({ engine: "ready" });
	wrong(await r.setup.engineDownload({ token: p2.token, ...FROM }), /already installed/);
});

test("no second plan or download while our own download runs, even when the engine's status does not say so", async () => {
	let release;
	const held = new Promise((r) => (release = r));
	let plans = 0;
	const engine = {
		status: async () => ({ state: "missing" }), // never says "downloading"
		info: () => ({}),
		onChange: () => () => {},
		plan: async () => ({ ok: true, token: "t" + ++plans }),
		download: async () => (await held, { ok: true }),
	};
	const store = {};
	const setup = createSetup({ keystore: createFakes().keystore, engine, auth: {}, settings: { get: () => store, set: (p) => Object.assign(store, p) }, waitingChats: () => ["c1"] });
	const p1 = await setup.enginePlan(FROM);
	const run = setup.engineDownload({ token: p1.token, ...FROM });
	await settle();
	wrong(await setup.enginePlan(FROM), /already running/);
	wrong(await setup.engineDownload({ token: "t1", ...FROM }), /already running/);
	assert.equal(plans, 1, "the engine was not asked for another plan");
	release();
	assert.equal((await run).ok, true);
});
