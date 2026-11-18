"use strict";
// S4: the subscriptions module and the login helper live under src/agents/pi/; src/subscriptions-main.js is a re-export shim.
// No credential or token file is read here: the pure functions are called with in-memory values only.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const shim = require("../src/subscriptions-main");
const real = require("../src/agents/pi/subscriptions-main");

// The exports before the move (c8bd8b8 / 4c3d7f3).
const BEFORE = ["SUBSCRIPTIONS", "agentDir", "autoAnswer", "describeOllama", "enrichOllamaTags", "frameJsonl", "hasStoredCredential", "mapAuthCheck", "mergeOllama", "ollamaLocalError", "ollamaModels", "piPackageRoot", "readJson", "register", "removeProvider", "runLogout", "uiState", "writeJsonAtomic"];

test("the shim re-exports exactly what the module exported before the move", () => {
	assert.deepStrictEqual(Object.keys(shim).sort(), BEFORE);
	for (const k of BEFORE) assert.strictEqual(shim[k], real[k], k);
});
test("the login helper sits next to the module that spawns it", () => {
	assert.ok(fs.existsSync(path.join(__dirname, "..", "src", "agents", "pi", "pi-login-helper.mjs")));
	assert.ok(!fs.existsSync(path.join(__dirname, "..", "src", "pi-login-helper.mjs")));
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "pi", "subscriptions-main.js"), "utf8");
	assert.ok(src.includes('path.join(__dirname, "pi-login-helper.mjs")'));
});
test("agentDir rules are unchanged", () => {
	assert.strictEqual(real.agentDir({}, "/h"), path.join("/h", ".pi", "agent"));
	assert.strictEqual(real.agentDir({ PI_CODING_AGENT_DIR: "~" }, "/h"), "/h");
	assert.strictEqual(real.agentDir({ PI_CODING_AGENT_DIR: "~/x" }, "/h"), path.join("/h", "x"));
	assert.strictEqual(real.agentDir({ PI_CODING_AGENT_DIR: "/t" }, "/h"), "/t");
});
test("mapAuthCheck maps `pi auth check` output as before", () => {
	assert.deepStrictEqual(real.mapAuthCheck({ status: "ready", authType: "oauth" }, { oauthDetail: "Pro/Max subscription" }), { status: "connected", detail: "Pro/Max subscription", authType: "oauth" });
	assert.deepStrictEqual(real.mapAuthCheck({ status: "not_ready", reason: "credentials_not_configured" }), { status: "disconnected", detail: "Not signed in" });
	assert.deepStrictEqual(real.mapAuthCheck(null), { status: "unavailable", detail: "Couldn't check" });
});
