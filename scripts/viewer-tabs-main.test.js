"use strict";
// The tab model of the Viewer (src/viewer-tabs-main.js) with a fake view and no Electron: what a page, a remembered address and a project
// switch may and may not do to the tabs. The end-to-end proof, with real views, is the selftest step viewer-tabs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const VT = require("../src/viewer-tabs-main");
const pp = require("../src/project-protocol");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vtm-")));
const root = path.join(tmp, "project");
const root2 = path.join(tmp, "project2");
for (const [base, rel] of [[root, "index.html"], [root, "docs/pricing.html"], [root2, "other.html"]]) {
	fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
	fs.writeFileSync(path.join(base, rel), "x");
}
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DEV = "http://localhost:5173/";
let views = [];
class FakeWC extends EventEmitter {
	constructor() {
		super();
		this.id = views.length + 100;
		this.url = "";
		this.loads = [];
		this.destroyed = false;
		this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
		this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
	}
	loadURL(u) { this.loads.push(u); this.url = u; return Promise.resolve(); }
	getURL() { return this.url; }
	getTitle() { return ""; }
	isLoading() { return false; }
	isDestroyed() { return this.destroyed; }
	isFocused() { return false; }
	setZoomLevel() {}
	setWindowOpenHandler() {}
	reload() { this.loads.push("reload"); }
	close() { this.destroyed = true; }
	executeJavaScript() { return Promise.resolve(null); }
}
class FakeView {
	constructor() { this.webContents = new FakeWC(); this.visible = false; views.push(this); }
	setBackgroundColor() {}
	setBounds() {}
	setVisible(v) { this.visible = v; }
	getVisible() { return this.visible; }
}

function make({ current = root, stored = null, isWin = true } = {}) {
	views = [];
	base = 0;
	const state = { root: current, sent: [], errorHidden: null, saved: [] };
	const protocol = { ...pp, ensureSession() {}, viewerWebPreferences: () => ({}) };
	const vt = VT.create({
		WebContentsView: FakeView,
		nativeTheme: { shouldUseDarkColors: false },
		getWin: () => ({ contentView: { addChildView() {}, removeChildView() {} }, webContents: { focus() {} } }),
		send: (ch, p) => state.sent.push([ch, p]),
		isLocal: (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(String(u)),
		isWin,
		devUrl: DEV,
		getRoot: () => state.root,
		getZoomLevel: () => 0,
		relayout() {},
		setErrorHidden: (h) => { state.errorHidden = h; },
		protocol,
		store: { read: () => stored, write: (r, v) => state.saved.push([r, v]) },
		shell: { openExternal() {}, openPath: async () => {} },
	});
	return { vt, state, protocol };
}
let base = 0; // views built before the test's own part (the first-run tab)
const loadsOf = () => views.slice(base).flatMap((v) => v.webContents.loads);
const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
const projAddr = (p, r = root) => pp.toAddress(r, p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("S3: a web page cannot cause a project tab or a switch of tab; its move to a project address is cancelled and nothing else", async () => {
	const { vt } = make();
	vt.init();
	vt.projectChanged();
	const web = vt.list().activeId;
	await vt.create("http://localhost:5174/");
	await vt.activate(web);
	const before = JSON.stringify(vt.list());
	const nViews = views.length;
	const loadsBefore = loadsOf().length;
	for (const url of [projAddr("docs/pricing.html"), projAddr("index.html"), projAddr("img/x.png"), projAddr("other.html", root2)]) {
		for (const ev of ["will-navigate", "will-redirect"]) {
			const e = event();
			views[0].webContents.emit(ev, e, url);
			assert.equal(e.prevented, true, `${ev} ${url}`);
		}
	}
	await wait(30);
	assert.equal(JSON.stringify(vt.list()), before, "no tab was added, none became active");
	assert.equal(views.length, nViews, "no view was built");
	assert.equal(loadsOf().length, loadsBefore, "nothing was loaded");
	// a web page that goes to another web address is not touched
	const e = event();
	views[0].webContents.emit("will-navigate", e, "https://example.com/next");
	assert.equal(e.prevented, false);
});

test("S3: a project page's own links keep working (another file loads in place; a web address opens in a web tab)", async () => {
	const { vt } = make();
	vt.init();
	vt.projectChanged();
	const r = await vt.openFile(projAddr("index.html"));
	assert.equal(r.ok, true);
	const v = views[views.length - 1];
	const e1 = event();
	v.webContents.emit("will-navigate", e1, projAddr("docs/pricing.html"));
	assert.equal(e1.prevented, false, "another file of this project loads in place");
	const e2 = event();
	const n = vt.list().tabs.length;
	v.webContents.emit("will-navigate", e2, "https://example.com/");
	assert.equal(e2.prevented, true);
	await wait(30);
	assert.equal(vt.list().tabs.length, n + 1, "the web address opened in a web tab");
});

const storedWith = (tabs, active = 0) => ({ tabs, active });

test("S2: a remembered web address loads only when it is local; any other comes back unloaded and loads on one click", async () => {
	const { vt, state } = make({ stored: storedWith([{ address: "https://evil.example/login", title: "Bank" }, { address: "http://localhost:3000/", title: "App" }, { path: "index.html", title: "I" }], 0) });
	vt.init();
	base = views.length;
	vt.projectChanged();
	const l = vt.list();
	assert.equal(l.tabs.length, 3);
	const active = l.tabs.find((t) => t.id === l.activeId);
	assert.equal(active.address, "https://evil.example/login");
	assert.deepEqual([views.length - base, loadsOf().length], [0, 0], "the active remembered tab built no view and loaded nothing");
	assert.equal(active.error && active.error.unloaded, true);
	assert.equal(active.error.url, "https://evil.example/login");
	assert.ok(state.sent.some(([ch, p]) => ch === "browser:error" && p.unloaded), "the UI is told, so it shows the address and a Load button");
	assert.equal(state.errorHidden, true);
	// showing a local one loads it as before
	await vt.activate(l.tabs[1].id);
	assert.deepEqual(loadsOf(), ["http://localhost:3000/"]);
	// showing the unloaded one again loads nothing; the click does
	await vt.activate(active.id);
	assert.deepEqual(loadsOf(), ["http://localhost:3000/"]);
	const r = await vt.loadTab(active.id);
	assert.equal(r.ok, true);
	assert.deepEqual(loadsOf(), ["http://localhost:3000/", "https://evil.example/login"]);
	assert.equal(vt.list().tabs.find((t) => t.id === active.id).error, null);
	assert.equal((await vt.loadTab(active.id)).ok, false, "a second click does nothing");
});

test("S2: an address with a user name or a password is dropped; local addresses load as today", () => {
	const S = require("../src/viewer-tabs-store");
	const env = { root, protocol: pp, files: require("../src/project-files") };
	const r = S.fromStored(storedWith([
		{ address: "http://user:pw@localhost:3000/" },
		{ address: "https://name@example.com/" },
		{ address: "http://127.0.0.1:8080/a" },
		{ address: "http://[::1]:3000/" },
		{ address: "http://localhost.evil.test/" },
		{ address: "https://example.com/" },
	]), env);
	assert.deepEqual(r.tabs.map((t) => [t.address, !!t.unloaded]), [
		["http://127.0.0.1:8080/a", false],
		["http://[::1]:3000/", false],
		["http://localhost.evil.test/", true],
		["https://example.com/", true],
	]);
});

test("S4: a tab created after a project switch began is dropped, whichever way it is asked for", async () => {
	const { vt, state } = make();
	vt.init();
	vt.projectChanged();
	// a request that was already on its way when the switch began
	const late = vt.create(projAddr("index.html"));
	vt.projectWillChange();
	state.root = root2;
	vt.projectChanged();
	const r = await late;
	assert.equal(r.ok, false);
	assert.equal(vt.list().tabs.length, 1, "only the new project's first tab");
	assert.ok(vt.list().tabs.every((t) => pp.fromAddress(root, t.address) === null), "no tab of the old project is in the new list");
	// a request that comes while the switch is on
	vt.projectWillChange();
	const a = await vt.openBackground("http://localhost:3000/");
	const b = await vt.openFile(projAddr("other.html", root2));
	const c = await vt.openSite("http://localhost:3001/");
	const d = await vt.create("http://localhost:3002/");
	for (const x of [a, b, c, d]) assert.equal(x.ok, false);
	vt.projectChanged();
	assert.equal((await vt.openBackground("http://localhost:3000/")).ok, true, "after the switch it works again");
});

test("P3: Pick refuses on a tab that did not load or whose file is gone, with the reason", async () => {
	const { vt } = make();
	vt.init();
	vt.projectChanged();
	const web = vt.list().activeId;
	views[0].webContents.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://nowhere.example/", true);
	assert.deepEqual(await vt.pick(root, {}), { error: "Nothing to work on. This page did not load." });
	assert.equal(vt.activeInfo().broken, "load");
	assert.equal(vt.activeInfo().id, web);
	// the error goes at the next navigation
	views[0].webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: DEV });
	assert.equal(vt.activeInfo().broken, "");
	// a project file that is gone
	const gone = projAddr("docs/pricing.html");
	await vt.openFile(gone);
	views[views.length - 1].webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: gone }); // the page is watched
	fs.rmSync(path.join(root, "docs", "pricing.html"));
	await wait(900); // the watcher's pause, then "This file no longer exists"
	assert.deepEqual(await vt.pick(root, {}), { error: "Nothing to work on. This file no longer exists." });
	assert.equal(vt.activeInfo().broken, "missing");
	fs.writeFileSync(path.join(root, "docs", "pricing.html"), "x");
});

test("P4: a file dropped straight onto the page (its move to a file: address, with no page behind it) is a drop: checked, opened or refused visibly", async () => {
	const { vt, state } = make();
	vt.init();
	vt.projectChanged();
	const { pathToFileURL } = require("node:url");
	const fileUrl = (p) => pathToFileURL(p).href;
	const outsideFile = path.join(tmp, "outside.html");
	fs.writeFileSync(outsideFile, "x");
	const page = views[0].webContents;
	const n0 = vt.list().tabs.length;
	// inside the project: cancelled, and the file opens in a tab of the project
	let e = event();
	page.emit("will-navigate", e, fileUrl(path.join(root, "index.html")));
	assert.equal(e.prevented, true);
	await wait(60);
	const l = vt.list();
	assert.equal(l.tabs.length, n0 + 1);
	assert.equal(pp.fromAddress(root, l.tabs.find((t) => t.id === l.activeId).address), "index.html");
	// outside the project: cancelled, a visible refusal, no tab
	state.sent.length = 0;
	e = event();
	views[0].webContents.emit("will-navigate", e, fileUrl(outsideFile));
	await wait(60);
	assert.equal(e.prevented, true);
	assert.equal(vt.list().tabs.length, n0 + 1);
	assert.deepEqual(state.sent.filter(([ch]) => ch === "browser:notice").map(([, p]) => p.message), ["Only files inside this project can be shown here."]);
	// a network path and a file kind that is not shown: refused with their reasons, nothing opens
	state.sent.length = 0;
	for (const u of ["file://server/share/a.html", fileUrl(path.join(root, "docs"))]) {
		e = event();
		views[0].webContents.emit("will-navigate", e, u);
		assert.equal(e.prevented, true, u);
	}
	await wait(60);
	assert.equal(vt.list().tabs.length, n0 + 1);
	assert.equal(state.sent.filter(([ch]) => ch === "browser:notice").length, 2);
	// a page's OWN move to a file: address (it has an initiating frame) is cancelled and nothing else: no tab, no notice
	state.sent.length = 0;
	e = event();
	e.initiator = {};
	views[0].webContents.emit("will-navigate", e, fileUrl(path.join(root, "docs", "pricing.html")));
	e = Object.assign(event(), { initiator: {} });
	views[0].webContents.emit("will-redirect", e, fileUrl(path.join(root, "docs", "pricing.html")));
	await wait(60);
	assert.equal(e.prevented, true);
	assert.equal(vt.list().tabs.length, n0 + 1);
	assert.deepEqual(state.sent.filter(([ch]) => ch === "browser:notice"), []);
});

test("P5: on a Mac plain Cmd+W stays the app menu's Close window (the page does not take it); a page closes with Option+Cmd+W; on Windows Ctrl+W closes a page", () => {
	const press = (vt, input) => {
		const e = event();
		views[0].webContents.emit("before-input-event", e, { type: "keyDown", control: false, meta: false, alt: false, shift: false, ...input });
		return e.prevented;
	};
	const mac = make({ isWin: false });
	mac.vt.init();
	mac.vt.projectChanged();
	assert.equal(press(mac.vt, { key: "w", code: "KeyW", meta: true }), false, "Cmd+W is not taken from the window menu");
	assert.equal(press(mac.vt, { key: "∑", code: "KeyW", meta: true, alt: true }), true, "Option+Cmd+W is the Viewer's close");
	assert.equal(press(mac.vt, { key: "t", code: "KeyT", meta: true }), true, "Cmd+T opens a page (the app menu has no Cmd+T)");
	assert.deepEqual(mac.state.sent.filter(([ch]) => ch === "app:shortcut").map(([, p]) => p.code), ["KeyW", "KeyT"]);
	const win = make({ isWin: true });
	win.vt.init();
	win.vt.projectChanged();
	assert.equal(press(win.vt, { key: "w", code: "KeyW", control: true }), true, "Ctrl+W closes a page on Windows (the app has no Close item there)");
	assert.equal(press(win.vt, { key: "w", code: "KeyW", control: true, alt: true }), false);
});

test("an app page (story, Mendix, a chat link) at 8 pages with no tab on its site opens nothing and says why in the reason line", async () => {
	const { vt, state } = make();
	vt.init();
	vt.projectChanged();
	for (let k = 2; vt.list().tabs.length < 8; k++) await vt.create(`http://127.0.0.1:${k}/`);
	state.sent.length = 0;
	const r = await vt.openSite("http://127.0.0.1:9/x");
	assert.equal(r.ok, false);
	assert.deepEqual(state.sent.filter(([ch]) => ch === "browser:notice").map(([, p]) => p.message), ["8 pages is the most. Close one first."]);
	assert.equal(vt.list().tabs.length, 8);
});
