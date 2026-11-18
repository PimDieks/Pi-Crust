"use strict";
// The test-only switches of the Claude Agent lane never work in a packaged app: the fake key store and engine (claude-setup-main.js), the fake
// IPC, the stand-in SDK (index.js) and the selftest flags in main.js. Electron is replaced by plain objects.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-setup-main-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const STAND_IN = path.join(__dirname, "claude-sdk-stand-in.mjs");

function register({ packaged, selftest, env }) {
	const saved = { a: process.env.PI_CRUST_SELFTEST_CLAUDE, b: process.env.PI_CRUST_CLAUDE_SDK };
	Object.assign(process.env, env);
	const handlers = new Map();
	const events = [];
	const app = { isPackaged: packaged, getPath: () => fs.mkdtempSync(path.join(tmp, "ud-")), on: () => {} };
	// the real key store and engine are built in the non-fake branch; they need electron's safeStorage, which the plain object lacks
	const Module = require("module");
	const origLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "electron") return { safeStorage: { isAsyncEncryptionAvailable: async () => false } };
		return origLoad.call(this, request, parent, isMain);
	};
	try {
		delete require.cache[require.resolve("../src/claude-setup-main")];
		const setup = require("../src/claude-setup-main").register({ app, ipcMain: { handle: (n, f) => handlers.set(n, f) }, selftest, readSettings: () => ({}), writeSettings: () => {}, send: (c, p) => events.push([c, p]) });
		return { setup, handlers };
	} finally {
		Module._load = origLoad;
		for (const [k, v] of [["PI_CRUST_SELFTEST_CLAUDE", saved.a], ["PI_CRUST_CLAUDE_SDK", saved.b]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
}
const SWITCHES = { PI_CRUST_SELFTEST_CLAUDE: "fake", PI_CRUST_CLAUDE_SDK: STAND_IN };

test("unpackaged self-test with both switches: the fake key store and engine and the fakeSet call exist", () => {
	const r = register({ packaged: false, selftest: true, env: SWITCHES });
	assert.equal(r.setup.fake, true);
	assert.ok(r.handlers.has("claude:fakeSet"));
});

test("a packaged app ignores the fake switch, whatever the variables and the self-test flag say", () => {
	const r = register({ packaged: true, selftest: true, env: SWITCHES });
	assert.equal(r.setup.fake, false, "no fake in a packaged app");
	assert.ok(!r.handlers.has("claude:fakeSet"), "no fake IPC in a packaged app");
});

test("without the self-test flag, or without a stand-in SDK, or without the fake value, there is no fake", () => {
	assert.equal(register({ packaged: false, selftest: false, env: SWITCHES }).setup.fake, false);
	assert.equal(register({ packaged: false, selftest: true, env: { PI_CRUST_SELFTEST_CLAUDE: "fake", PI_CRUST_CLAUDE_SDK: "" } }).setup.fake, false);
	assert.equal(register({ packaged: false, selftest: true, env: { PI_CRUST_SELFTEST_CLAUDE: "yes", PI_CRUST_CLAUDE_SDK: STAND_IN } }).setup.fake, false);
});

test("main.js: every Claude self-test switch sits behind SELFTEST, which needs an unpackaged app", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
	assert.match(src, /const SELFTEST = !app\.isPackaged && process\.env\.PI_CRUST_SELFTEST === "1"/);
	for (const line of src.split("\n").filter((l) => /PI_CRUST_SELFTEST_CLAUDE|PI_CRUST_CLAUDE_SDK/.test(l) && !/^\s*\/\//.test(l))) assert.match(line, /SELFTEST &&/, line.trim().slice(0, 80));
	assert.match(src, /selftestClaudeFake: !!\(claudeSetup && claudeSetup\.fake\)/);
	// the only other place that reads the stand-in switch is the adapter, which checks isPackaged (claude-adapter.test.js)
	const idx = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "claude", "index.js"), "utf8");
	for (const line of idx.split("\n").filter((l) => /PI_CRUST_CLAUDE_SDK/.test(l) && !/^\s*\/\//.test(l))) assert.match(line, /isPackaged\(\)/, line.trim().slice(0, 80));
});
