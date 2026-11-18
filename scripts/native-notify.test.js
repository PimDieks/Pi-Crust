// No native notification, taskbar flash, badge or window raise in a selftest run, and every `new Notification` in src/ goes through src/native-notify.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { create } = require("../src/native-notify");
const { createAttention } = require("../src/attention-main");

const SRC = path.join(__dirname, "..", "src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(js|html)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
	}
	return out;
}

test("in a selftest run no notification is created, even when the page says it is not a selftest", () => {
	let made = 0;
	class N { constructor() { made++; } }
	assert.equal(create({ selftest: true, Notification: N }).notify("Claude Agent asks", { body: "x" }), null);
	assert.equal(create({ selftest: () => true, Notification: () => N }).notify("t"), null);
	assert.equal(made, 0);
});

test("outside a selftest the notification is created as before, with the same title and options", () => {
	const seen = [];
	class N { constructor(t, o) { seen.push([t, o]); } }
	assert.ok(create({ selftest: false, Notification: N }).notify("Claude Agent finished", { body: "chat" }) instanceof N);
	assert.ok(create({ selftest: () => false, Notification: () => N }).notify("t2", { body: "b" }) instanceof N);
	assert.deepEqual(seen, [["Claude Agent finished", { body: "chat" }], ["t2", { body: "b" }]]);
});

test("a failing Notification constructor is swallowed", () => {
	class N { constructor() { throw new Error("no"); } }
	assert.equal(create({ selftest: false, Notification: N }).notify("t"), null);
});

test("every new Notification in src/ is inside src/native-notify.js (the Remote's own browser page and service worker excepted)", () => {
	const hits = [];
	for (const f of walk(SRC)) {
		const rel = path.relative(SRC, f).split(path.sep).join("/");
		if (rel === "native-notify.js" || rel.startsWith("remote/")) continue;
		fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
			if (/\bnew\s+(window\.)?Notification\s*\(/.test(l.replace(/\/\/.*$/, ""))) hits.push(`${rel}:${i + 1}`);
		});
	}
	assert.deepEqual(hits, []);
	assert.match(read("notify.js"), /crustNative\.notify\(/);
	assert.match(read("mendix.js"), /crustNative\.notify\(/);
	const html = read("index.html");
	assert.ok(html.indexOf("native-notify.js") > 0 && html.indexOf("native-notify.js") < html.indexOf("notify.js\""), "native-notify.js loads before notify.js");
});

// The attention functions of the main process, called with injected fakes: with the selftest flag nothing is created, without it they do.
function rig({ selftest, isDarwin = false, isWin = false, focused = false, minimized = false, haveWin = true }) {
	const calls = [];
	const win = { isFocused: () => focused, isMinimized: () => minimized, restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus"), flashFrame: (f) => calls.push(`flash:${f}`), setOverlayIcon: (i, d) => calls.push(`overlay:${i ? "icon" : "none"}:${d}`) };
	const app = { dock: { setBadge: (t) => calls.push(`dock-badge:${t}`), bounce: (k) => calls.push(`dock-bounce:${k}`) }, setBadgeCount: (n) => calls.push(`badge-count:${n}`) };
	const created = [];
	const a = createAttention({ selftest, getWin: () => (haveWin ? win : null), app, isDarwin, isWin, badgeIcon: (n) => (calls.push(`icon:${n}`), { n }), createWindow: () => created.push("window") });
	return { a, calls, created };
}
test("selftest flag: badge, bounce and showWindow create and raise nothing, on every platform", () => {
	for (const [isDarwin, isWin] of [[true, false], [false, true], [false, false]]) {
		for (const haveWin of [true, false]) {
			const r = rig({ selftest: true, isDarwin, isWin, haveWin, minimized: true });
			r.a.badge(3);
			r.a.badge(0);
			r.a.bounce();
			r.a.showWindow();
			assert.deepEqual(r.calls, [], `darwin=${isDarwin} win=${isWin}`);
			if (haveWin) assert.deepEqual(r.created, []);
		}
	}
});
test("no selftest flag: the same calls do their job (so the test above can tell silence from a broken helper)", () => {
	let r = rig({ selftest: false, isWin: true });
	r.a.badge(3);
	r.a.bounce();
	r.a.showWindow();
	assert.deepEqual(r.calls, ["icon:3", "overlay:icon:3 unread", "flash:true", "show", "focus"]);
	r = rig({ selftest: false, isDarwin: true, minimized: true });
	r.a.badge(2);
	r.a.bounce();
	r.a.showWindow();
	assert.deepEqual(r.calls, ["dock-badge:2", "dock-bounce:informational", "restore", "show", "focus"]);
	r = rig({ selftest: false });
	r.a.badge(4);
	assert.deepEqual(r.calls, ["badge-count:4"]);
	r = rig({ selftest: false, haveWin: false });
	r.a.showWindow();
	assert.deepEqual(r.created, ["window"]);
});
test("main.js hands the selftest flag to the attention module and keeps no raw attention call of its own", () => {
	const main = read("main.js");
	assert.match(main, /createAttention\(\{ selftest: SELFTEST,/);
	assert.match(main, /ipcMain\.handle\("app:badge", \(_e, n\) => attention\.badge\(n\)\)/);
	assert.match(main, /ipcMain\.handle\("app:bounce", \(\) => attention\.bounce\(\)\)/);
	for (const call of ["flashFrame(", "setOverlayIcon(", "dock?.bounce(", "dock?.setBadge(", "win.show("]) assert.equal(main.split(call).length - 1, 0, `${call} is not called in main.js`);
	assert.match(read("preload.js"), /selftestRun: ipcRenderer\.sendSync\("app:isSelftestRun"\) === true/);
});
