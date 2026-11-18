// No native notification, taskbar flash, badge or window raise in a selftest run, and every `new Notification` in src/ goes through src/native-notify.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { create } = require("../src/native-notify");

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

test("the main process does nothing for badge, flash, bounce and raising the window in a selftest run", () => {
	const main = read("main.js");
	for (const re of [/ipcMain\.handle\("app:badge", \(_e, n\) => \{\s*\n\s*if \(SELFTEST\) return;/, /ipcMain\.handle\("app:bounce", \(\) => \{\s*\n\s*if \(SELFTEST\) return;/, /function showWindow\(\) \{\s*\n\s*if \(!win\) return createWindow\(\);\s*\n\s*if \(SELFTEST\) return;/])
		assert.match(main, re);
	// flashFrame, setOverlayIcon and dock calls live only in those guarded handlers
	for (const call of ["flashFrame(", "setOverlayIcon(", "dock?.bounce(", "dock?.setBadge("]) assert.equal(main.split(call).length - 1, 1, `${call} appears once`);
	assert.match(read("preload.js"), /selftestRun: ipcRenderer\.sendSync\("app:isSelftestRun"\) === true/);
});
