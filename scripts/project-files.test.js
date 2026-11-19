"use strict";
// Path rules for what a Viewer page may reach (src/project-files.js). No app, no git, no real environment:
// every test builds its own temp folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pf = require("../src/project-files");

const WIN = process.platform === "win32";
const tmps = [];
function sandbox() {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-")));
	tmps.push(base);
	const root = path.join(base, "proj");
	const outside = path.join(base, "outside");
	const w = (p, c = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
	w(path.join(root, "index.html"), "<p>hi</p>");
	w(path.join(root, "docs", "a.html"), "<p>a</p>");
	w(path.join(root, "docs", "deep", "b.css"), "b{}");
	w(path.join(root, "src", "app.js"), "1");
	w(path.join(root, ".git", "config"), "secret");
	w(path.join(root, ".env"), "KEY=1");
	w(path.join(root, ".pi", "settings.json"), "{}");
	w(path.join(root, "docs", ".hidden", "x.html"), "x");
	w(path.join(root, "100%.png"), "p");
	w(path.join(root, "a b.html"), "sp");
	w(path.join(outside, "secret.txt"), "TOP SECRET");
	w(path.join(outside, "dir", "inner.html"), "inner");
	return { base, root, outside };
}
test.after(() => { for (const t of tmps) try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ } });

const get = (root, p) => pf.resolve(root, p, "GET");
function refused(root, p, status, label) {
	const r = get(root, p);
	assert.equal(r.ok, false, `${label || p} must be refused, got ${JSON.stringify(r)}`);
	if (status) assert.equal(r.status, status, `${label || p}: ${r.reason}`);
	else assert.ok(r.status === 400 || r.status === 403, `${label || p} must be refused as bad input (400 or 403), not "not found": ${r.status} ${r.reason}`);
	assert.ok(typeof r.reason === "string" && r.reason.length > 0);
}

test("plain files of each allowed type pass, with the listed content type and size", () => {
	const { root } = sandbox();
	const cases = {
		html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
		json: "application/json; charset=utf-8", map: "application/json; charset=utf-8", svg: "image/svg+xml",
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
		woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
		pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", txt: "text/plain; charset=utf-8",
	};
	for (const [ext, type] of Object.entries(cases)) {
		fs.writeFileSync(path.join(root, "assets-file." + ext), "12345");
		for (const m of ["GET", "HEAD"]) {
			const r = pf.resolve(root, "/assets-file." + ext, m);
			assert.equal(r.ok, true, ext + " " + m + " " + JSON.stringify(r));
			assert.equal(r.contentType, type, ext);
			assert.equal(r.size, 5);
			assert.equal(fs.readFileSync(r.file, "utf8"), "12345");
		}
	}
	// the upper case extension and a nested file
	fs.writeFileSync(path.join(root, "UP.PNG"), "1");
	assert.equal(get(root, "/UP.PNG").contentType, "image/png");
	const n = get(root, "/docs/deep/b.css");
	assert.equal(n.ok, true);
	assert.equal(n.contentType, "text/css; charset=utf-8");
	// a space, a percent that is not an escape, a legitimately encoded name
	assert.equal(get(root, "/a%20b.html").ok, true);
});
test("a name with a percent sign that is not an escape is served", () => {
	const { root } = sandbox();
	assert.equal(get(root, "/100%25.png").ok, true);
});

test("an unknown extension is application/octet-stream, and none at all too", () => {
	const { root } = sandbox();
	fs.writeFileSync(path.join(root, "data.xyz"), "1");
	fs.writeFileSync(path.join(root, "README"), "1");
	assert.equal(get(root, "/data.xyz").contentType, "application/octet-stream");
	assert.equal(get(root, "/README").contentType, "application/octet-stream");
});

test("kindOf: page, image, pdf or other", () => {
	for (const [p, k] of [["a.html", "page"], ["docs/A.HTML", "page"], ["x.svg", "image"], ["a.png", "image"], ["a.JPG", "image"], ["a.jpeg", "image"], ["a.gif", "image"], ["a.webp", "image"], ["a.pdf", "pdf"], ["a.PDF", "pdf"],
		["a.txt", "other"], ["a.css", "other"], ["a.js", "other"], ["a.mp4", "other"], ["a", "other"], ["a.html.exe", "other"], ["", "other"], ["dir.html/file", "other"]]) {
		assert.equal(pf.kindOf(p), k, p);
	}
});

// ---- the attack list: every row of the table, several spellings each ----

test("dot dot in every spelling is refused", () => {
	const { root } = sandbox();
	const spellings = [
		"/..", "/../x", "/../outside/secret.txt", "/docs/../.env", "/docs/../index.html", "/docs/..", "/docs/../", "/./index.html", "/docs/./a.html",
		"/%2e%2e/", "/%2e%2e/outside/secret.txt", "/%2E%2E/x", "/.%2e/x", "/%2e./x", "/docs/%2e%2e/index.html", "/%2e/index.html",
		"/%252e%252e/x", "/%252E%252E/x", "/docs/%252e%252e/index.html", "/%252e/index.html",
		"/..%5c", "/..%5cx", "/..%5Cx", "/..%2f", "/..%2fx", "/..%2Fx", "/docs%2f..%2findex.html", "/docs%5c..%5cindex.html",
		"/..\\x", "/docs\\..\\index.html", "/....//x", "/.../x", "/..;/x", "/%2e%2e%2f", "/%2e%2e%5c",
		"..", "../x", "..\\x",
	];
	for (const s of spellings) refused(root, s);
});

test("encoded slashes and backslashes, and anything encoded twice, are refused", () => {
	const { root } = sandbox();
	for (const s of ["/docs%2fa.html", "/docs%2Fa.html", "/docs%5ca.html", "/docs%5Ca.html", "/docs%252fa.html", "/docs%255ca.html", "/index%252ehtml", "/%25"
		+ "2e", "/a%2500b", "/index.html%00", "/%00", "/%00index.html"]) refused(root, s);
	assert.equal(get(root, "/docs/a.html").ok, true);
});

test("a NUL, in raw or encoded form, is refused", () => {
	const { root } = sandbox();
	for (const s of ["/index.html\0", "/\0", "/index\0.html", "/index.html%00", "/index.html%00.png", "/docs/a.html\0.png"]) refused(root, s, 400);
});

test("a drive letter is refused, in every spelling", () => {
	const { root } = sandbox();
	for (const s of ["/C:/Windows/win.ini", "/c:/x", "C:/Windows/win.ini", "C:\\Windows\\win.ini", "/C:", "/C%3a/x", "/C%3A/x", "/docs/C:/x", "/C:x", "/%43:/x", "/c%3a%5cwindows"]) refused(root, s);
	refused(root, "/C:/Windows/win.ini", 400);
});

test("a UNC path is refused, in every spelling", () => {
	const { root } = sandbox();
	for (const s of ["//server/share/x", "//server/share", "///x", "\\\\server\\share\\x", "/\\\\server\\share", "/%5c%5cserver%5cshare", "//localhost/c$/x", "//?/C:/x", "//./pipe/x", "\\\\?\\C:\\x", "/\\server/share"]) refused(root, s);
	refused(root, "//server/share/x", 400);
});

test("a colon in a segment is refused (no alternate data streams)", () => {
	const { root } = sandbox();
	for (const s of ["/index.html:stream", "/a.html:stream", "/index.html::$DATA", "/index.html:$DATA", "/docs/a.html:Zone.Identifier", "/index.html%3astream", "/index.html%3Astream", "/:x", "/docs:x/a.html", "/index.html:"]) refused(root, s, 400);
});

test("Windows reserved device names are refused, with an extension, in any case, even with spaces", () => {
	const { root } = sandbox();
	const names = ["CON", "con", "Con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "CON.txt", "con.html", "nul.png", "aux.tar.gz", "docs/CON", "docs/com1.html", "COM\u00b9", "LPT\u00b2.txt", "CONIN$", "CONOUT$", "CON .txt"];
	for (const n of names) refused(root, "/" + n, undefined, n);
	// not reserved: look-alikes pass the name rule (they just do not exist here)
	for (const n of ["CONSOLE.html", "COM10", "COM0", "LPT0", "ICON.png"]) assert.equal(get(root, "/" + n).status, 404, n);
});

test("a trailing dot or space on any segment is refused", () => {
	const { root } = sandbox();
	for (const s of ["/index.html.", "/index.html ", "/index.html..", "/index.html. ", "/index.html%20", "/index.html%2e", "/docs./a.html", "/docs /a.html", "/docs%20/a.html", "/a%20b.html%20"]) refused(root, s);
	refused(root, "/index.html.", 400);
	refused(root, "/index.html ", 400);
});

test("other characters Windows reserves are refused", () => {
	const { root } = sandbox();
	for (const s of ["/a<b.html", "/a>b.html", "/a\"b.html", "/a|b.html", "/a?b.html", "/a*b.html", "/a\tb.html", "/a\nb.html", "/a%0ab.html", "/a%7fb.html", "/a%3fb.html", "/*.html"]) refused(root, s, 400);
});

test("a path over 1,024 characters is refused, raw or after decoding", () => {
	const { root } = sandbox();
	refused(root, "/" + "a".repeat(2000), 400);
	refused(root, "/" + "a".repeat(2000) + ".html", 400);
	refused(root, "/" + "d/".repeat(1000) + "a.html", 400);
	refused(root, "/" + "a".repeat(1100), 400);
	refused(root, "/" + "%61".repeat(400), 400, "3 chars each, 1,200 raw");
	refused(root, "/" + "a".repeat(1024), 400);
	// at the limit it is a normal 404, not a length refusal
	const r = get(root, "/" + "a".repeat(1023));
	assert.equal(r.status, 404);
});

test("not an absolute request path, or not text", () => {
	const { root } = sandbox();
	for (const s of ["index.html", "docs/a.html", "", undefined, null, 5, {}, ["/index.html"]]) refused(root, s, 400);
	refused(root, "/%E0%A4%A", 400, "malformed escape");
	refused(root, "/%zz", 400);
});

test("an empty segment is refused", () => {
	const { root } = sandbox();
	refused(root, "/docs//a.html", 400);
	refused(root, "/docs///a.html", 400);
});

test("a segment that starts with a dot is refused: .git, .env, .pi, hidden folders, in any spelling", () => {
	const { root } = sandbox();
	for (const s of ["/.git/config", "/.git/", "/.git", "/.env", "/.ENV", "/.pi/settings.json", "/docs/.hidden/x.html", "/docs/.hidden", "/%2egit/config", "/.%67it/config", "/.git%2fconfig", "/.git%5cconfig", "/.gitignore", "/docs/.env", "/.Git/config", "/.", "/.."]) refused(root, s);
	refused(root, "/.git/config", 403);
	refused(root, "/.env", 403);
	// the files really are there, so a 404 would be the wrong reason
	assert.ok(fs.existsSync(path.join(root, ".git", "config")));
	assert.ok(fs.existsSync(path.join(root, ".env")));
});

test("a folder or the root is a 404, never a listing", () => {
	const { root } = sandbox();
	for (const s of ["/", "/docs", "/docs/", "/docs/deep", "/docs/deep/", "/src", "/src/", "/index.html/", "/docs/a.html/"]) {
		const r = get(root, s);
		assert.equal(r.ok, false, s);
		assert.equal(r.status, 404, s);
		assert.equal(r.file, undefined);
	}
});

test("only GET and HEAD: everything else is a 405, even for a missing or refused path", () => {
	const { root } = sandbox();
	for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "get", "head", "", undefined, null, "GET ", "GETX"]) {
		for (const p of ["/index.html", "/missing.html", "/.env", "/../x"]) {
			const r = pf.resolve(root, p, m);
			assert.equal(r.ok, false, `${m} ${p}`);
			assert.equal(r.status, 405, `${m} ${p}`);
		}
	}
	assert.equal(pf.resolve(root, "/index.html", "GET").ok, true);
	assert.equal(pf.resolve(root, "/index.html", "HEAD").ok, true);
});

test("a missing file is 404, a missing project folder is 404", () => {
	const { root, base } = sandbox();
	assert.equal(get(root, "/nope.html").status, 404);
	assert.equal(get(root, "/docs/nope/a.html").status, 404);
	assert.equal(get(path.join(base, "gone"), "/index.html").status, 404);
	assert.equal(get("relative/dir", "/index.html").status, 404);
	assert.equal(get(undefined, "/index.html").status, 404);
});

// ---- links: a symlink and a junction to a folder and a file outside the root ----

function tryLink(target, link, type) {
	try { fs.symlinkSync(target, link, type); return null; } catch (e) { return `cannot create a ${type} here (${e.code || e.message})`; }
}
function linkCase(name, type, makeTarget, make) {
	test(name, (t) => {
		const { root, outside } = sandbox();
		const target = makeTarget(outside);
		const link = path.join(root, "link");
		const why = tryLink(target, link, type);
		if (why) { t.skip(why); return; }
		make(root, link);
	});
}
const folderLink = (root, link) => {
	for (const s of ["/link/inner.html", "/link/dir/inner.html", "/link/secret.txt"]) {
		const r = get(root, s);
		assert.equal(r.ok, false, s);
		assert.equal(r.status, 403, s + " " + r.reason);
	}
	assert.equal(get(root, "/link").status, 403);
};
linkCase("a symlink to a folder outside the root: 403 for files under it", "dir", (o) => o, folderLink);
if (WIN) linkCase("a junction (mklink /J) to a folder outside the root: 403 for files under it", "junction", (o) => o, folderLink);
else test("a junction (mklink /J) exists only on Windows", (t) => t.skip("no junctions on " + process.platform));
linkCase("a symlink to a file outside the root: 403", "file", (o) => path.join(o, "secret.txt"), (root) => {
	const r = get(root, "/link");
	assert.equal(r.ok, false);
	assert.equal(r.status, 403, r.reason);
});
test("a link inside the root, to a file inside the root, is served as the real file", (t) => {
	const { root } = sandbox();
	const why = tryLink(path.join(root, "index.html"), path.join(root, "alias.html"), "file");
	if (why) { t.skip(why); return; }
	const r = get(root, "/alias.html");
	assert.equal(r.ok, true);
	assert.equal(r.file, path.join(root, "index.html"), `served file ${r.file} vs expected ${path.join(root, "index.html")}`);
});
test("a link inside the root to a dot file is refused by its real name", (t) => {
	const { root } = sandbox();
	const why = tryLink(path.join(root, ".env"), path.join(root, "notes.txt"), "file");
	if (why) { t.skip(why); return; }
	refused(root, "/notes.txt", 403);
});
test("a junction inside the root to a dot folder is refused by its real name", (t) => {
	const { root } = sandbox();
	const why = tryLink(path.join(root, ".git"), path.join(root, "pub"), WIN ? "junction" : "dir");
	if (why) { t.skip(why); return; }
	refused(root, "/pub/config", 403);
});
test("a link to a folder outside, whose name is not even requested as a link: every parent is checked", (t) => {
	const { root, outside } = sandbox();
	const why = tryLink(outside, path.join(root, "docs", "out"), WIN ? "junction" : "dir");
	if (why) { t.skip(why); return; }
	refused(root, "/docs/out/dir/inner.html", 403);
	refused(root, "/docs/out/secret.txt", 403);
});
test("the project root itself may be reached through a link: the real root is what counts", (t) => {
	const { root, base } = sandbox();
	const alias = path.join(base, "alias-root");
	const why = tryLink(root, alias, WIN ? "junction" : "dir");
	if (why) { t.skip(why); return; }
	const r = get(alias, "/index.html");
	assert.equal(r.ok, true);
	assert.equal(r.file, path.join(root, "index.html"), `served file ${r.file} vs expected ${path.join(root, "index.html")}`);
});
test("a dangling link is a 404", (t) => {
	const { root, base } = sandbox();
	const why = tryLink(path.join(base, "nothing-here"), path.join(root, "dangling.html"), "file");
	if (why) { t.skip(why); return; }
	assert.equal(get(root, "/dangling.html").ok, false);
});

// ---- case ----

test("SRC against src on this file system", () => {
	const { root } = sandbox();
	const ci = (() => { const p = path.join(root, "src", "app.js"); return fs.existsSync(p.replace("src", "SRC")); })();
	const r = get(root, "/SRC/app.js");
	if (ci) {
		assert.equal(r.ok, true, "case-insensitive file system: SRC finds src");
		assert.equal(r.file, path.join(root, "src", "app.js"), `the answer is the real on-disk name: got ${r.file}, expected ${path.join(root, "src", "app.js")}`);
	} else {
		assert.equal(r.status, 404, "case-sensitive file system: SRC is not src");
	}
	assert.equal(get(root, "/src/app.js").ok, true);
});

// In-memory file system on posix paths, so the case rule is tested on any machine.
function fakeFs(files, { ci }) {
	const norm = (p) => path.posix.normalize(p).replace(/\/+$/, "") || "/";
	const names = new Map(); // folded -> real
	const kind = new Map(); // real -> "file" | "dir"
	const add = (real, k) => { names.set(ci ? real.toLowerCase() : real, real); kind.set(real, k); };
	add("/", "dir");
	for (const f of files) {
		const parts = f.split("/").filter(Boolean);
		for (let i = 1; i <= parts.length; i++) add("/" + parts.slice(0, i).join("/"), i === parts.length ? "file" : "dir");
	}
	const find = (p) => { const n = norm(p); const real = names.get(ci ? n.toLowerCase() : n); if (!real) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return real; };
	const realpathSync = (p) => find(p);
	realpathSync.native = realpathSync;
	return { realpathSync, statSync: (p) => { const r = find(p); return { isFile: () => kind.get(r) === "file", isDirectory: () => kind.get(r) === "dir", size: 7 }; } };
}
test("case rule: on a case-insensitive file system (darwin) SRC is src, on the real on-disk name", () => {
	const f = pf.create({ fs: fakeFs(["/proj/src/app.js", "/proj/.Git/config"], { ci: true }), platform: "darwin" });
	const r = f.resolve("/PROJ", "/SRC/APP.JS", "GET");
	assert.equal(r.ok, true);
	assert.equal(r.file, "/proj/src/app.js");
	assert.equal(f.resolve("/proj", "/src/app.js", "GET").file, "/proj/src/app.js");
	// the real name decides about dots too, whatever the spelling
	assert.equal(f.resolve("/proj", "/GIT/config", "GET").status, 404);
	assert.equal(f.hostFor("/Proj"), f.hostFor("/proj"));
});
test("case rule: on a case-sensitive file system (linux) SRC is not src", () => {
	const f = pf.create({ fs: fakeFs(["/proj/src/app.js"], { ci: false }), platform: "linux" });
	assert.equal(f.resolve("/proj", "/SRC/app.js", "GET").status, 404);
	assert.equal(f.resolve("/proj", "/src/app.js", "GET").ok, true);
	assert.notEqual(f.hostFor("/Proj"), f.hostFor("/proj"));
});
test("case rule: containment compares with the file system's rule (a sibling folder that shares a prefix is outside)", () => {
	const fake = fakeFs(["/proj/a.html", "/proj-evil/x.html"], { ci: true });
	const lying = { ...fake, realpathSync: Object.assign((p) => (/\/link$/.test(p) ? "/PROJ-evil/x.html" : fake.realpathSync(p)), { native: (p) => (/\/link$/.test(p) ? "/PROJ-evil/x.html" : fake.realpathSync(p)) }) };
	const f = pf.create({ fs: lying, platform: "darwin" });
	assert.equal(f.resolve("/proj", "/link", "GET").status, 403);
	const lying2 = { ...fake, realpathSync: Object.assign((p) => (/\/link$/.test(p) ? "/PROJ/a.html" : fake.realpathSync(p)), { native: (p) => (/\/link$/.test(p) ? "/PROJ/a.html" : fake.realpathSync(p)) }) };
	assert.equal(pf.create({ fs: lying2, platform: "darwin" }).resolve("/proj", "/link", "GET").ok, true, "a link back inside, spelt in another case, is inside");
});

test("a sibling folder that shares the root's name as a prefix is outside", (t) => {
	const { base, root } = sandbox();
	const sib = path.join(base, "proj-evil");
	fs.mkdirSync(sib);
	fs.writeFileSync(path.join(sib, "x.html"), "1");
	const why = tryLink(sib, path.join(root, "sib"), WIN ? "junction" : "dir");
	if (why) { t.skip(why); return; }
	refused(root, "/sib/x.html", 403);
});

// ---- isProjectPath ----

test("isProjectPath: true only for a file resolve would serve", () => {
	const { root, base, outside } = sandbox();
	assert.equal(pf.isProjectPath(root, path.join(root, "index.html")), true);
	assert.equal(pf.isProjectPath(root, path.join(root, "docs", "a.html")), true);
	assert.equal(pf.isProjectPath(root, path.join(root, "a b.html")), true);
	assert.equal(pf.isProjectPath(root, path.join(root, "100%.png")), true);
	assert.equal(pf.isProjectPath(root, root + path.sep + "docs" + path.sep + ".." + path.sep + "index.html"), true, "an OS path with .. that lands inside is the file it lands on");
	for (const p of [root, path.join(root, "docs"), path.join(root, "missing.html"), path.join(root, ".env"), path.join(root, ".git", "config"), path.join(root, "docs", ".hidden", "x.html"),
		path.join(outside, "secret.txt"), path.join(base, "proj-evil", "x.html"), path.join(root, "..", "outside", "secret.txt"), path.join(root, "docs", "..", "..", "outside", "secret.txt"),
		"relative.html", "", path.join(root, "index.html\0"), path.join(root, "index.html."), path.join(root, "index.html:stream"), path.join(root, "CON"), path.join(root, "docs") + path.sep]) {
		assert.equal(pf.isProjectPath(root, p), false, p);
	}
	for (const bad of [undefined, null, 5, {}]) { assert.equal(pf.isProjectPath(root, bad), false); assert.equal(pf.isProjectPath(bad, path.join(root, "index.html")), false); }
	assert.equal(pf.isProjectPath("relative", path.join(root, "index.html")), false);
});
test("isProjectPath: a link out of the root is not a project path, a link to the root is", (t) => {
	const { root, base, outside } = sandbox();
	const out = tryLink(outside, path.join(root, "out"), WIN ? "junction" : "dir");
	if (out) { t.skip(out); return; }
	assert.equal(pf.isProjectPath(root, path.join(root, "out", "secret.txt")), false);
	const alias = path.join(base, "alias-root");
	const why = tryLink(root, alias, WIN ? "junction" : "dir");
	if (why) return;
	assert.equal(pf.isProjectPath(alias, path.join(alias, "index.html")), true);
	assert.equal(pf.isProjectPath(root, path.join(alias, "index.html")), true, "dropped through the link spelling");
});

// ---- host label ----

test("hostFor: stable p-<hash> label, one per project folder, valid as a host name", () => {
	const { root, base } = sandbox();
	const h = pf.hostFor(root);
	assert.match(h, /^p-[0-9a-f]{16}$/);
	assert.equal(pf.hostFor(root), h);
	assert.equal(pf.hostFor(root + path.sep), h, "a trailing separator is the same project");
	assert.equal(pf.hostFor(path.join(root, "docs", "..")), h);
	assert.notEqual(pf.hostFor(path.join(base, "outside")), h);
	assert.notEqual(pf.hostFor(path.join(base, "proj2")), h);
	assert.ok(h.length <= 63);
	if (WIN) assert.equal(pf.hostFor(root.toUpperCase()), h, "Windows paths differ only in case");
});
test("hostMatches: only the current project's host", () => {
	const { root, base } = sandbox();
	const other = path.join(base, "outside");
	const h = pf.hostFor(root);
	assert.equal(pf.hostMatches(h, root), true);
	assert.equal(pf.hostMatches(h.toUpperCase(), root), true, "host names are case-insensitive");
	assert.equal(pf.hostMatches(pf.hostFor(other), root), false, "a late request from the old project");
	for (const bad of [undefined, null, "", "p-", h + "x", h + ".evil.com", "x" + h, h.slice(2), "localhost", "p-0000000000000000", 5, {}]) assert.equal(pf.hostMatches(bad, root), false, String(bad));
	assert.equal(pf.hostMatches(h, undefined), false);
	assert.equal(pf.hostMatches(h, ""), false);
});

// Each rule must be the one that fires, so removing it cannot hide behind another rule.
test("each rule gives its own reason", () => {
	const { root } = sandbox();
	const why = (p) => get(root, p).reason;
	for (const p of ["/%2e%2e/x", "/.%2e/x", "/docs/%2E/a.html"]) assert.match(why(p), /encoded dot/, p);
	for (const p of ["/docs%2fa.html", "/..%5cx"]) assert.match(why(p), /encoded slash/, p);
	for (const p of ["/%252e%252e/x", "/docs%252fa.html"]) assert.match(why(p), /encoded twice/, p);
	for (const p of ["/index.html%00", "/index.html" + String.fromCharCode(0)]) assert.match(why(p), /NUL/, p);
	for (const p of ["//server/share/x", "//x"]) assert.match(why(p), /UNC/, p);
	for (const p of ["/..", "/../x", "/docs/../.env", "/./index.html", "/.git/config", "/.env"]) assert.match(why(p), /starting with a dot/, p);
	for (const p of ["/index.html:stream", "/C:/x", "/docs\\..\\x"]) assert.match(why(p), /not allowed/, p);
	for (const p of ["/CON", "/con.txt", "/docs/COM1.html"]) assert.match(why(p), /device name/, p);
	for (const p of ["/index.html.", "/index.html "]) assert.match(why(p), /dot or a space/, p);
	assert.match(why("index.html"), /slash/);
	assert.match(why("/docs//a.html"), /empty/);
	assert.match(why("/" + "a".repeat(2000)), /1,024/);
	assert.match(why("/docs/"), /folder/);
});

test("the module has no Electron import", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "project-files.js"), "utf8");
	assert.doesNotMatch(src, /require\(\s*["']electron["']\s*\)/);
});

// ---- decoding exactly once (review fix 5) ----

test("a real file named like 100%ab or 100%25ab is served: the path is decoded once, never twice", () => {
	const { root } = sandbox();
	// "100%ab" is asked for as 100%25ab; a file really named "100%25ab" as 100%2525ab. (Windows allows % in names.)
	for (const [name, asked] of [["100%ab", "/100%25ab"], ["100%25ab", "/100%2525ab"], ["%69ndex.html", "/%2569ndex.html"], ["50%.png", "/50%25.png"]]) {
		fs.writeFileSync(path.join(root, name), "1");
		const r = get(root, asked);
		assert.equal(r.ok, true, `${asked}: ${JSON.stringify(r)}`);
		assert.equal(path.basename(r.file), name);
	}
	// the file named 100%ab is not reachable under the other spelling
	fs.rmSync(path.join(root, "100%25ab"));
	assert.equal(get(root, "/100%2525ab").ok, false);
});
test("double-encoded traversal, slashes, NULs and colons are still refused", () => {
	const { root } = sandbox();
	for (const s of ["/%252e%252e/x", "/%252E%252e/outside/secret.txt", "/docs/%252e%252e/index.html", "/docs%252fa.html", "/docs%255ca.html", "/a%2500b", "/C%253a/x", "/index%252ehtml",
		"/100%252e", "/x%2522y", "/x%253cy", "/x%257cy", "/x%2501y"]) refused(root, s);
});

// ---- open: the file is opened once and the handle is checked (review fix 1) ----

// An injected file system: `before(name)` runs just before a call of that name reaches the real one.
function spyFs(hooks) {
	const wrap = { ...fs };
	for (const name of ["openSync", "fstatSync", "statSync", "realpathSync"]) {
		const real = fs[name];
		wrap[name] = (...a) => { if (hooks[name]) a = hooks[name](...a) || a; return real(...a); };
	}
	wrap.realpathSync.native = (...a) => fs.realpathSync.native(...a);
	return wrap;
}
const closeIf = (r) => { if (r.ok) fs.closeSync(r.fd); };

test("open: a plain file gives a handle on the file, its size and type", () => {
	const { root } = sandbox();
	const r = pf.open(root, "/docs/a.html", "GET");
	assert.equal(r.ok, true);
	assert.equal(fs.readFileSync(r.fd, "utf8"), "<p>a</p>");
	assert.equal(r.size, 8);
	assert.equal(r.contentType, "text/html; charset=utf-8");
	fs.closeSync(r.fd);
	for (const [p, status] of [["/nope.html", 404], ["/.env", 403], ["/docs/", 404], ["/index.html%00", 400]]) assert.equal(pf.open(root, p, "GET").status, status, p);
	assert.equal(pf.open(root, "/index.html", "POST").status, 405);
});
test("open: a file swapped for a link to a file outside, between the check and the open, is a 403 and nothing stays open", (t) => {
	const { root, outside } = sandbox();
	const target = path.join(outside, "secret.txt");
	const probe = path.join(root, "probe-link");
	const why = tryLink(target, probe, "file");
	if (why) { t.skip(why); return; }
	fs.rmSync(probe);
	let opened = null;
	let closed = 0;
	let swapped = false;
	const fake = spyFs({
		openSync: (p, ...rest) => {
			if (!swapped && path.basename(p) === "index.html") {
				swapped = true;
				fs.rmSync(p);
				fs.symlinkSync(target, p, "file");
			}
			return [p, ...rest];
		},
	});
	const realClose = fake.closeSync;
	fake.closeSync = (fd) => { closed++; return realClose(fd); };
	const o = fake.openSync;
	fake.openSync = (...a) => (opened = o(...a));
	const files = pf.create({ fs: fake });
	assert.equal(files.resolve(root, "/index.html", "GET").ok, true, "the check alone passes");
	const r = files.open(root, "/index.html", "GET");
	assert.equal(swapped, true);
	assert.equal(r.ok, false);
	assert.equal(r.status, 403, r.reason);
	assert.equal(opened !== null && closed, 1, "the handle that was opened is closed again");
});
test("open: a directory junction or link swapped in for a parent folder, between the check and the open, is a 403", (t) => {
	const { root, outside } = sandbox();
	fs.mkdirSync(path.join(root, "swap"));
	fs.writeFileSync(path.join(root, "swap", "inner.html"), "inner");
	fs.writeFileSync(path.join(outside, "inner.html"), "OUTSIDE");
	const probe = path.join(root, "probe-dir");
	const why = tryLink(outside, probe, WIN ? "junction" : "dir");
	if (why) { t.skip(why); return; }
	fs.rmSync(probe, { recursive: true });
	let swapped = false;
	const fake = spyFs({
		openSync: (p, ...rest) => {
			if (!swapped && path.basename(p) === "inner.html") {
				swapped = true;
				fs.rmSync(path.join(root, "swap"), { recursive: true });
				fs.symlinkSync(outside, path.join(root, "swap"), WIN ? "junction" : "dir");
			}
			return [p, ...rest];
		},
	});
	const r = pf.create({ fs: fake }).open(root, "/swap/inner.html", "GET");
	assert.equal(swapped, true);
	assert.equal(r.ok, false);
	assert.equal(r.status, 403, r.reason);
});
test("open: a handle that is not the file the path resolves to now (device or file id) is a 403", () => {
	const { root } = sandbox();
	for (const field of ["ino", "dev"]) {
		const fake = spyFs({});
		fake.fstatSync = (fd, o) => { const st = fs.fstatSync(fd, o); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { [field]: st[field] + (o && o.bigint ? 1n : 1) }); };
		const r = pf.create({ fs: fake }).open(root, "/index.html", "GET");
		assert.equal(r.ok, false, field);
		assert.equal(r.status, 403, field);
	}
});
test("open: the file removed between the check and the re-check is refused, and the handle is closed", () => {
	const { root } = sandbox();
	let gone = false;
	const fake = spyFs({ fstatSync: (fd) => { if (!gone) { gone = true; fs.rmSync(path.join(root, "index.html")); } } });
	const r = pf.create({ fs: fake }).open(root, "/index.html", "GET");
	assert.equal(r.ok, false);
	assert.equal(gone, true);
	assert.ok(r.status === 403 || r.status === 404, String(r.status));
});

// ---- hard links (review fix 6) ----

test("a hard link is accepted on purpose: package managers make them, and whoever can make one can already read the target", (t) => {
	const { root, outside } = sandbox();
	try { fs.linkSync(path.join(outside, "secret.txt"), path.join(root, "linked.txt")); } catch (e) { t.skip(`cannot create a hard link here (${e.code})`); return; }
	fs.linkSync(path.join(root, "index.html"), path.join(root, "alias2.html"));
	const out = get(root, "/linked.txt");
	assert.equal(out.ok, true, "a hard link to a file outside the project is served: it is indistinguishable from a file of the project");
	assert.equal(path.dirname(out.file), root, `dirname of ${out.file} vs root ${root}`);
	assert.equal(out.size, 10);
	assert.equal(get(root, "/alias2.html").ok, true);
	const o = pf.open(root, "/linked.txt", "GET");
	assert.equal(o.ok, true);
	closeIf(o);
	// ...whereas a symbolic link to the same outside file is not
	const why = tryLink(path.join(outside, "secret.txt"), path.join(root, "sym.txt"), "file");
	if (!why) assert.equal(get(root, "/sym.txt").status, 403);
});

test("a project opened through a short-name (8.3) or linked path is served, and the answer is the real long name", (t) => {
	const raw = fs.mkdtempSync(path.join(os.tmpdir(), "pf-alias-"));
	tmps.push(raw);
	const real = fs.realpathSync.native(raw);
	if (real === raw) { t.skip("the temp folder has no short-name form on this machine"); return; }
	fs.writeFileSync(path.join(raw, "index.html"), "<p>hi</p>");
	const r = get(raw, "/index.html");
	assert.equal(r.ok, true, `root ${raw} (real ${real}) must be accepted: ${JSON.stringify(r)}`);
	assert.equal(r.file, path.join(real, "index.html"), `served ${r.file} vs expected ${path.join(real, "index.html")}`);
});
