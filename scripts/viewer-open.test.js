"use strict";
// The decisions behind "open a project file in the Viewer" (src/viewer-open-logic.js): typed text, a real path (drop, tree, Editor) and the
// suggestions. The end-to-end proof is the selftest step viewer-open.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../src/viewer-open-logic");
const pf = require("../src/project-files");
const K = require("../src/viewer-kind");
const { R } = L;

const logic = L.create();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vo-")));
const root = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
const put = (base, rel, data = "x") => {
	fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
	fs.writeFileSync(path.join(base, rel), data);
};
put(root, "index.html");
put(root, "docs/pricing.html");
put(root, "docs/My Page.html");
put(root, "img/logo.svg");
put(root, "img/photo.PNG");
put(root, "doc.pdf");
put(root, "notes.txt");
put(root, "src/app.js");
put(root, ".hidden/secret.html");
put(root, ".env");
put(root, "node_modules/pkg/readme.html");
put(outside, "secret.html");
let junction = true;
try { fs.symlinkSync(outside, path.join(root, "linkdir"), "junction"); } catch { junction = false; }
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("typed: a project path opens, in every spelling", () => {
	for (const t of ["docs/pricing.html", "docs\\pricing.html", "./docs/pricing.html", " docs/pricing.html ", "docs/../docs/pricing.html"]) {
		assert.deepEqual(logic.checkTyped(root, t), { file: { path: "docs/pricing.html", kind: "page" } }, t);
	}
	assert.deepEqual(logic.checkTyped(root, "docs/My Page.html"), { file: { path: "docs/My Page.html", kind: "page" } });
	assert.deepEqual(logic.checkTyped(root, "img/logo.svg").file.kind, "image");
	assert.deepEqual(logic.checkTyped(root, "doc.pdf").file.kind, "pdf");
	assert.deepEqual(logic.checkTyped(root, "index.html"), { file: { path: "index.html", kind: "page" } }); // a name that also looks like a host
	assert.deepEqual(logic.checkTyped(root, path.join(root, "docs", "pricing.html")), { file: { path: "docs/pricing.html", kind: "page" } }); // a real path inside
});

test("typed: web addresses and host-like text behave as before", () => {
	assert.deepEqual(logic.checkTyped(root, "http://localhost:3000/x"), { web: "http://localhost:3000/x" });
	assert.deepEqual(logic.checkTyped(root, "https://example.com"), { web: "https://example.com" });
	for (const t of ["localhost:5173", "example.com/path", "127.0.0.1:8080/a", "pricing.html", "[::1]:3000"]) assert.deepEqual(logic.checkTyped(root, t), { web: `https://${t}` }, t);
});

test("typed: every refusal has its reason", () => {
	const cases = [
		["file:///C:/Windows/win.ini", R.scheme],
		["javascript:alert(1)", R.scheme],
		["data:text/html,hi", R.scheme],
		["ftp://example.com/x", R.scheme],
		["../outside/secret.html", R.outside],
		["docs/../../outside/secret.html", R.outside],
		[path.join(outside, "secret.html"), R.outside],
		[".hidden/secret.html", R.dot],
		[".env", R.dot],
		["docs/.git/x.html", R.dot],
		["notes.txt", R.kind],
		["src/app.js", R.kind],
		["docs", R.folder],
		[".nothing", R.dot],
		["file:C:\\Windows\\win.ini", R.scheme],
		["pi-project://p-0000000000000000/a.html", R.outside],
	];
	for (const [t, why] of cases) assert.equal(logic.checkTyped(root, t).refuse, why, t);
	if (junction) {
		assert.equal(logic.checkTyped(root, "linkdir/secret.html").refuse, R.outside);
		assert.equal(logic.checkTyped(root, path.join(root, "linkdir", "secret.html")).refuse, R.outside);
	}
});

test("typed: text that is not a project file behaves as before (an https address), whatever its shape", () => {
	for (const t of ["intranet", "intranet/wiki", "docs/nothing.html", "hello world", "wiki", "www.example.com/.well-known/x"]) assert.deepEqual(logic.checkTyped(root, t), { web: `https://${t}` }, t);
	// with no project open the same: only a scheme is refused
	for (const t of ["intranet", "docs/a.html", "example.com", "hello world"]) assert.deepEqual(logic.checkTyped(null, t), { web: `https://${t}` }, t);
	assert.equal(logic.checkTyped(null, "file:///x").refuse, R.scheme);
	// a project path that exists but is not shown keeps its reason; the refusals that are about the project stay
	assert.equal(logic.checkTyped(root, "docs").refuse, R.folder);
	assert.equal(logic.checkTyped(root, "notes.txt").refuse, R.kind);
	assert.equal(logic.checkTyped(root, "../x").refuse, R.outside);
});

test("typed: the internal address of this project opens", () => {
	const a = require("../src/project-protocol").toAddress(root, "docs/pricing.html");
	assert.deepEqual(logic.checkTyped(root, a), { file: { path: "docs/pricing.html", kind: "page" } });
});

test("dropped: a project file opens; every other thing is refused with its reason", () => {
	assert.deepEqual(logic.checkDropped(root, path.join(root, "docs", "pricing.html")), { file: { path: "docs/pricing.html", kind: "page" } });
	assert.deepEqual(logic.checkDropped(root, path.join(root, "img", "photo.PNG")).file.kind, "image");
	const cases = [
		[path.join(outside, "secret.html"), R.outside],
		[path.join(root, "docs"), R.folder],
		[path.join(root, ".hidden", "secret.html"), R.dot],
		[path.join(root, ".env"), R.dot],
		[path.join(root, "notes.txt"), R.kind],
		[path.join(root, "src", "app.js"), R.kind],
		[path.join(root, "nope.html"), R.missing],
		["relative/path.html", R.invalid],
	];
	for (const [p, why] of cases) assert.equal(logic.checkDropped(root, p).refuse, why, p);
	assert.equal(logic.checkDropped(null, path.join(root, "index.html")).refuse, R.noproject);
	assert.equal(logic.checkDropped(root, path.join(root, "index.html\0")).refuse, R.invalid);
	if (junction) assert.equal(logic.checkDropped(root, path.join(root, "linkdir", "secret.html")).refuse, R.outside, "a link pointing outside");
});

test("dropped: a network path is refused before the file system is touched (S1)", () => {
	const touched = [];
	const spy = new Proxy({}, { get: (_t, name) => (...a) => { touched.push([String(name), a[0]]); throw new Error("the file system must not be touched"); } });
	const win = L.create({ fs: spy, platform: "win32" });
	for (const p of ["\\\\server\\s\\a.html", "//server/s/a.html", "\\\\?\\UNC\\server\\s\\a.html", "\\\\.\\pipe\\x"]) {
		assert.equal(win.checkDropped("C:\\project", p).refuse, R.outside, p);
		assert.equal(win.checkTyped("C:\\project", p).refuse, R.outside, p);
	}
	assert.deepEqual(touched, []);
});

test("suggest: only shown kinds, never a dot folder or node_modules, at most 8, ranked", () => {
	const paths = ["index.html", "docs/pricing.html", "docs/My Page.html", "img/logo.svg", "doc.pdf", "notes.txt", "src/app.js", ".hidden/secret.html", ".env", "node_modules/pkg/readme.html", "a/.cache/x.html", "NODE_MODULES/y.html"];
	assert.deepEqual(L.suggest(paths, "pric").map((s) => s.path), ["docs/pricing.html"]);
	assert.deepEqual(L.suggest(paths, "DOC").map((s) => s.path), ["doc.pdf", "docs/My Page.html", "docs/pricing.html"]); // a name starting with it first, shorter first
	assert.deepEqual(L.suggest(paths, "html").map((s) => s.path).sort(), ["docs/My Page.html", "docs/pricing.html", "index.html"]);
	for (const q of ["secret", ".hidden", "node_modules", "readme", "notes", "app.js", ".env", "cache"]) assert.deepEqual(L.suggest(paths, q), [], q);
	assert.deepEqual(L.suggest(paths, "docs my"), [{ path: "docs/My Page.html", kind: "page" }]);
	assert.deepEqual(L.suggest(paths, ""), []);
	assert.deepEqual(L.suggest(paths, "http://doc"), []);
	assert.deepEqual(L.suggest(paths, "localhost:3000"), []);
	const many = Array.from({ length: 30 }, (_, i) => `p/page${String(i).padStart(2, "0")}.html`);
	assert.equal(L.suggest(many, "page").length, 8);
	// the veto: a candidate that fails the real-path check is skipped and the next one takes its place
	assert.deepEqual(L.suggest(many, "page", { accept: (p) => !p.endsWith("00.html") }).map((s) => s.path)[0], "p/page01.html");
});

test("the renderer's kind table mirrors project-files kindOf, and its viewable() hides dot folders and node_modules", () => {
	for (const name of ["a.html", "A.HTML", "a.htm", "a.svg", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.ico", "a.bmp", "a.pdf", "a.PDF", "a.txt", "a.js", "a.css", "a.md", "a", "", "a.", ".html", "x/y.json", "a.mp4"]) {
		assert.equal(K.fileKind(name), pf.kindOf(name), name);
	}
	assert.equal(K.viewable("docs/a.html"), true);
	for (const p of [".git/a.html", "a/.x/b.png", "node_modules/a/b.html", "Node_Modules/b.html", "docs/a.md"]) assert.equal(K.viewable(p), false, p);
});
