// Main-process side of the Claude Agent's first-use setup (src/agents/claude/setup.js): builds the key store and the engine download, hands them
// to the adapter, and answers the window's claude:* calls. The window never gets the key, only the state. Nothing downloads before the window sends
// the one-time token of a plan (engine.js refuses otherwise).
// Self-test only (never in a packaged app): PI_CRUST_SELFTEST_CLAUDE=fake swaps in a fake key store and a fake engine (agents/claude/setup-fake.js) and needs
// the stand-in SDK (PI_CRUST_CLAUDE_SDK), so a key check can never reach a model. A self-test without the switch never starts a Claude Agent chat.
"use strict";

const path = require("node:path");
const fs = require("node:fs");

function register(ctx) {
	const { app, ipcMain } = ctx;
	const adapter = require("./agents/claude");
	const { createSetup } = require("./agents/claude/setup");
	const userData = app.getPath("userData");
	const fake = ctx.selftest === true && !app.isPackaged && process.env.PI_CRUST_SELFTEST_CLAUDE === "fake" && !!process.env.PI_CRUST_CLAUDE_SDK ? require("./agents/claude/setup-fake").createFakes() : null;
	let keystore;
	let engine;
	if (fake) {
		keystore = fake.keystore;
		engine = fake.engine;
	} else {
		const { createKeystore } = require("./agents/claude/keystore");
		const { createEngine } = require("./agents/claude/engine");
		keystore = createKeystore({ safeStorage: require("electron").safeStorage, dir: path.join(userData, "claude") });
		engine = createEngine({ dir: path.join(userData, "claude-engine") });
	}
	const configDir = path.join(userData, "claude-config"); // the app's own Claude folder: a person's own Claude sign-in is never used
	try {
		fs.mkdirSync(configDir, { recursive: true });
	} catch {}

	const setup = createSetup({
		keystore,
		engine,
		auth: adapter.auth,
		settings: { get: () => ctx.readSettings(), set: (patch) => ctx.writeSettings(patch) },
		send: (channel, payload) => ctx.send(channel, payload),
		hold: (name) => (fake ? fake.control.hold(name) : Promise.resolve()),
	});
	adapter.configure({ keystore, configDir, getSettings: () => ctx.readSettings(), isPackaged: () => app.isPackaged, enginePath: () => setup.enginePath() });
	if (ctx.selftest === true && !fake) setup.isReady = () => false; // a self-test without the fakes never starts a Claude Agent chat

	ipcMain.handle("claude:state", () => setup.state());
	ipcMain.handle("claude:saveKey", (_e, key) => (typeof key === "string" && key.length <= 400 ? setup.saveKey(key) : { ok: false, error: "That does not look like a key." }));
	ipcMain.handle("claude:removeKey", () => setup.removeKey());
	ipcMain.handle("claude:enginePlan", () => setup.enginePlan());
	ipcMain.handle("claude:engineDownload", (_e, token) => setup.engineDownload({ token: typeof token === "string" ? token : "" }));
	ipcMain.handle("claude:engineCancel", () => setup.engineCancel());
	ipcMain.handle("claude:setLimit", (_e, n) => setup.setLimit(n));
	if (fake) ipcMain.handle("claude:fakeSet", (_e, cmd) => fake.fakeSet(cmd));
	app.on("before-quit", () => {
		try {
			engine.stopNow && engine.stopNow();
		} catch {}
	});
	setup.emit().catch(() => {}); // fills the cache: a restored Claude Agent chat starts as soon as both steps are known to be done
	setup.fake = !!fake;
	return setup;
}

module.exports = { register };
