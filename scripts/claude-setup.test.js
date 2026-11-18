// The Claude Agent's first-use setup (src/agents/claude/setup.js) with the self-test fakes: both steps, the one-time token, a key stored before
// the engine and checked after it, and that no state or error ever holds the key.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSetup, keyReason } = require("../src/agents/claude/setup");
const { createFakes } = require("../src/agents/claude/setup-fake");

const GOOD = "sk-ant-test-good-0000";
const BAD = "sk-ant-test-rejected-0000";

function make() {
	const f = createFakes();
	const store = {};
	const sent = [];
	const checks = [];
	// the adapter's auth: the check answers like the API does for a wrong key
	const check = async (key) => (checks.push(key), key === BAD ? { ok: false, error: "Invalid API key - Fix external API key" } : { ok: true });
	const auth = {
		check,
		async login(key) {
			const r = await check(key);
			if (!r.ok) return r;
			await f.keystore.set(key);
			return { ok: true };
		},
	};
	const setup = createSetup({ keystore: f.keystore, engine: f.engine, auth, settings: { get: () => store, set: (p) => Object.assign(store, p) }, send: (c, p) => sent.push([c, p]), hold: (n) => f.control.hold(n) });
	return { f, setup, store, sent, checks };
}
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
	const bad = await setup.engineDownload({ token: "nope" });
	assert.equal(bad.ok, false);
	assert.equal(bad.code, "no-confirm");
	assert.equal((await setup.state()).engine.state, "todo");
	const plan = await setup.enginePlan();
	assert.ok(plan.ok && plan.token);
	const run = setup.engineDownload({ token: plan.token });
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
	assert.equal((await setup.engineDownload({ token: plan.token })).ok, false);
});

test("Cancel returns to to do; a failure keeps its reason until the next plan", async () => {
	const { setup, f } = make();
	let plan = await setup.enginePlan();
	const run = setup.engineDownload({ token: plan.token });
	await settle();
	assert.equal((await setup.engineCancel()).ok, true);
	assert.equal((await run).code, "cancelled");
	assert.equal((await setup.state()).engine.state, "todo");
	plan = await setup.enginePlan();
	const run2 = setup.engineDownload({ token: plan.token });
	await settle();
	f.fakeSet({ engine: "fail" });
	await run2;
	const s = await setup.state();
	assert.equal(s.engine.state, "failed");
	assert.match(s.engine.reason, /Not enough free disk space/);
});

test("a key saved with the engine there is checked at once; a wrong one fails with a readable reason and is not stored", async () => {
	const { setup, f } = make();
	f.fakeSet({ engine: "ready" });
	const bad = await setup.saveKey(BAD);
	assert.equal(bad.ok, false);
	assert.match(bad.error, /did not accept this key/);
	let s = await setup.state();
	assert.equal(s.key.state, "failed");
	assert.equal((await f.keystore.status()).source, "none");
	assert.ok(!JSON.stringify(s).includes(BAD) && !bad.error.includes(BAD));
	const ok = await setup.saveKey(GOOD);
	assert.equal(ok.ok, true);
	s = await setup.state();
	assert.equal(s.key.state, "done");
	assert.equal(s.ready, true);
	assert.ok(!JSON.stringify(s).includes(GOOD));
});

test("a key saved before the engine is stored, then checked once the engine is there", async () => {
	const { setup, f, checks, store } = make();
	assert.equal((await setup.saveKey(BAD)).ok, true);
	let s = await setup.state();
	assert.equal(s.key.state, "done");
	assert.equal(s.key.pendingCheck, true);
	assert.equal(s.ready, false);
	assert.equal(checks.length, 0);
	f.fakeSet({ engine: "ready" });
	await settle();
	await settle();
	s = await setup.state();
	assert.equal(checks.length, 1);
	assert.equal(s.key.state, "failed");
	assert.match(s.key.reason, /did not accept this key/);
	assert.equal(store.claudeKeyUnchecked, false);
	assert.equal((await f.keystore.status()).source, "none");
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
