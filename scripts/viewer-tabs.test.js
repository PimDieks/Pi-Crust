"use strict";
// The pure list logic of the Viewer tabs (src/viewer-tabs-list.js). The end-to-end proof is the selftest step viewer-tabs.
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/viewer-tabs-list");

const web = (address) => ({ session: "web", address });
const proj = (address) => ({ session: L.sessionOf(address), address });
const ids = (l) => l.tabs.map((t) => t.id);

test("the first tab becomes active; new tabs open right of the active one", () => {
	const l = L.create();
	const a = L.add(l, web("http://localhost:3000/")).tab;
	assert.equal(l.activeId, a.id);
	const b = L.add(l, web("https://a.example/"), { activate: false }).tab;
	const c = L.add(l, web("https://b.example/"), { activate: false }).tab;
	assert.deepEqual(ids(l), [a.id, c.id, b.id]); // both went right of the active tab, so the later one sits closer
	assert.equal(l.activeId, a.id);
});

test("a new tab goes right of the active one and becomes active", () => {
	const l = L.create();
	const [a, b, c] = ["a", "b", "c"].map((h) => L.add(l, web(`https://${h}.example/`)).tab);
	assert.deepEqual(ids(l), [a.id, b.id, c.id]); // each new one was active, so each went to the end
	L.activate(l, a.id);
	const d = L.add(l, web("https://d.example/")).tab;
	assert.deepEqual(ids(l), [a.id, d.id, b.id, c.id]);
	assert.equal(l.activeId, d.id);
	const e = L.add(l, web("https://e.example/"), { activate: false }).tab; // right of the active one, focus stays
	assert.deepEqual(ids(l), [a.id, d.id, e.id, b.id, c.id]);
	assert.equal(l.activeId, d.id);
});

test("ids are never reused after a close", () => {
	const l = L.create();
	const a = L.add(l, web("https://a.example/")).tab;
	L.close(l, a.id);
	const b = L.add(l, web("https://a.example/")).tab;
	assert.notEqual(a.id, b.id);
});

test("at most 8 tabs; closing one makes room", () => {
	const l = L.create();
	for (let i = 0; i < L.MAX_TABS; i++) assert.equal(L.add(l, web(`https://s${i}.example/`)).ok, true);
	assert.equal(L.MAX_TABS, 8);
	const over = L.add(l, web("https://over.example/"));
	assert.deepEqual(over, { ok: false, reason: "limit" });
	assert.equal(l.tabs.length, 8);
	L.close(l, l.activeId);
	assert.equal(L.add(l, web("https://again.example/")).ok, true);
});

test("closing the active tab activates the right neighbour, else the left one", () => {
	const l = L.create();
	const [a, b, c] = ["a", "b", "c"].map((h) => L.add(l, web(`https://${h}.example/`)).tab);
	L.activate(l, b.id);
	let r = L.close(l, b.id);
	assert.equal(r.ok && r.wasActive && r.activeId, c.id);
	r = L.close(l, c.id); // the last in the row: the left neighbour
	assert.equal(r.activeId, a.id);
	assert.deepEqual(ids(l), [a.id]);
});

test("closing a tab that is not active keeps the active one", () => {
	const l = L.create();
	const [a, b, c] = ["a", "b", "c"].map((h) => L.add(l, web(`https://${h}.example/`)).tab);
	L.activate(l, a.id);
	const r = L.close(l, c.id);
	assert.equal(r.wasActive, false);
	assert.equal(l.activeId, a.id);
	assert.deepEqual(ids(l), [a.id, b.id]);
});

test("closing the last tab empties the list and says so", () => {
	const l = L.create();
	const a = L.add(l, web("http://localhost:3000/")).tab;
	const r = L.close(l, a.id);
	assert.equal(r.empty, true);
	assert.equal(r.activeId, null);
	assert.equal(L.active(l), null);
	const n = L.add(l, web("http://localhost:3000/")).tab; // the replacement becomes active
	assert.equal(l.activeId, n.id);
});

test("unknown ids are refused", () => {
	const l = L.create();
	L.add(l, web("http://localhost:3000/"));
	assert.deepEqual(L.close(l, "nope"), { ok: false, reason: "unknown" });
	assert.equal(L.activate(l, "nope"), false);
	assert.equal(L.find(l, "nope"), null);
	assert.equal(l.tabs.length, 1);
});

test("session of an address: a project address is that project's own session, everything else web", () => {
	assert.equal(L.sessionOf("pi-project://p-abc/docs/a.html"), "project:p-abc");
	assert.notEqual(L.sessionOf("pi-project://p-abc/x"), L.sessionOf("pi-project://p-def/x"));
	assert.equal(L.isProjectSession("project:p-abc"), true);
	assert.equal(L.isProjectSession("web"), false);
	assert.equal(L.sessionOf("https://example.com/"), "web");
	assert.equal(L.sessionOf("http://localhost:3000/"), "web");
	assert.equal(L.sessionOf("garbage"), "web");
});

test("reuse: same session and same site (host and port); the active tab wins", () => {
	const l = L.create();
	const dev = L.add(l, web("http://localhost:3000/")).tab;
	const ex = L.add(l, web("https://example.com/a")).tab;
	const p = L.add(l, proj("pi-project://p-abc/docs/a.html")).tab;
	assert.equal(L.reusable(l, "https://example.com/other?x=1").id, ex.id);
	assert.equal(L.reusable(l, "http://localhost:3000/deep/path").id, dev.id);
	assert.equal(L.reusable(l, "http://localhost:3001/"), null, "another port is another site");
	assert.equal(L.reusable(l, "https://other.example/"), null);
	assert.equal(L.reusable(l, "pi-project://p-abc/other.png").id, p.id);
	assert.equal(L.reusable(l, "pi-project://p-zzz/x.png"), null, "another project is another site");
	assert.equal(L.reusable(l, "not an address"), null);
	// a web address never reuses a project tab, even with the same host text
	const l2 = L.create();
	L.add(l2, proj("pi-project://example.com/a.html"));
	assert.equal(L.reusable(l2, "https://example.com/"), null);
	// two tabs on the same site: the active one is preferred
	const two = L.add(l, web("https://example.com/b")).tab;
	assert.equal(L.reusable(l, "https://example.com/").id, two.id);
	L.activate(l, ex.id);
	assert.equal(L.reusable(l, "https://example.com/").id, ex.id);
});

// --- the remembered tabs (src/viewer-tabs-store.js) -------------------------------------------------------------------------------------
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const S = require("../src/viewer-tabs-store");
const pp = require("../src/project-protocol");
const pf = require("../src/project-files");

function project() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-store-")));
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, "docs", "a b.html"), "<p>x</p>");
	fs.writeFileSync(path.join(root, "pic.png"), "x");
	fs.writeFileSync(path.join(root, "notes.txt"), "x");
	return root;
}
const env = (root) => ({ root, protocol: pp, files: pf });

test("store: what is saved is the address of a web page, the project path of a file, the title and the active index; nothing else", () => {
	const root = project();
	const l = L.create();
	L.add(l, { session: "web", address: "http://localhost:5173/", title: "App", canGoBack: true, scroll: 200 });
	const page = L.add(l, { session: L.sessionOf(pp.toAddress(root, "docs/a b.html")), address: pp.toAddress(root, "docs/a b.html"), title: "A page" }).tab;
	L.add(l, { session: "web", address: "chrome-error://chromewebdata/", title: "" }); // cannot be saved
	L.activate(l, page.id);
	const saved = S.toStored(l, { root, protocol: pp });
	assert.deepEqual(saved, { tabs: [{ address: "http://localhost:5173/", title: "App" }, { path: "docs/a b.html", title: "A page" }], active: 1 });
	assert.deepEqual(Object.keys(saved).sort(), ["active", "tabs"]);
	assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
	fs.rmSync(root, { recursive: true, force: true });
});

test("store: a list that is only the dev address is the first-run state and stores nothing", () => {
	const l = L.create();
	L.add(l, { session: "web", address: "http://localhost:5173/" });
	assert.equal(S.isDefault(l, "http://localhost:5173"), true);
	L.add(l, { session: "web", address: "https://a.example/" });
	assert.equal(S.isDefault(l, "http://localhost:5173"), false);
});

test("store: restore keeps good entries in order, the active one, and a file that is gone as a missing tab", () => {
	const root = project();
	const r = S.fromStored(
		{ tabs: [{ address: "https://a.example/", title: "A" }, { path: "docs/a b.html", title: "P" }, { path: "docs/gone.html", title: "G" }, { path: "pic.png", title: "" }], active: 2 },
		env(root),
	);
	assert.equal(r.tabs.length, 4);
	assert.equal(r.active, 2);
	assert.deepEqual(r.tabs.map((t) => [t.session === "web" ? "web" : "project", t.kind, t.missing]), [["web", "page", false], ["project", "page", false], ["project", "page", true], ["project", "image", false]]);
	assert.equal(r.tabs[1].address, pp.toAddress(root, "docs/a b.html"));
	assert.equal(r.tabs[2].title, "G", "the missing tab keeps its title");
	fs.rmSync(root, { recursive: true, force: true });
});

test("store: tampered entries are dropped, whatever they are; the index of the active tab follows the entries that stay", () => {
	const root = project();
	const other = pp.toAddress(path.join(root, "elsewhere"), "a.html");
	const bad = [
		{ address: "file:///C:/Users/alex/x.html" },
		{ address: other },
		{ path: "../x.html" },
		{ path: "docs/../pic.png" },
		{ path: "docs\\..\\..\\pic.png" },
		{ path: ".git/config.html" },
		{ path: "docs/%2e%2e/pic.png" },
		{ path: "notes.txt" },
		{ path: "" },
		{ path: "x".repeat(2000) + ".png" },
		{ address: "javascript:alert(1)" },
		{ address: "data:text/html,x" },
		{ address: "ftp://a.example/" },
		{ address: "not an address" },
		{ address: 5 },
		{ title: "nothing" },
		"text",
		null,
		7,
		[],
	];
	const r = S.fromStored({ tabs: [...bad, { path: "pic.png", title: "ok" }, ...bad], active: bad.length }, env(root));
	assert.equal(r.tabs.length, 1);
	assert.equal(r.tabs[0].title, "ok");
	assert.equal(r.active, 0);
	assert.equal(S.fromStored({ tabs: bad }, env(root)), null, "nothing usable");
	for (const raw of [null, undefined, 3, "x", [], {}, { tabs: "x" }, { tabs: {} }]) assert.equal(S.fromStored(raw, env(root)), null);
	fs.rmSync(root, { recursive: true, force: true });
});

test("store: at most 8 tabs, titles are cleaned and cut", () => {
	const root = project();
	const tabs = Array.from({ length: 20 }, (_, i) => ({ address: `https://a${i}.example/`, title: "t" + "x".repeat(500) + "\n\u0000" }));
	const r = S.fromStored({ tabs, active: 15 }, env(root));
	assert.equal(r.tabs.length, 8);
	assert.equal(r.active, 0, "the stored active tab was not among the first 8: the first is active");
	assert.ok(r.tabs.every((t) => t.title.length <= S.TITLE_MAX && !/[\u0000-\u001f]/.test(t.title)));
	fs.rmSync(root, { recursive: true, force: true });
});
