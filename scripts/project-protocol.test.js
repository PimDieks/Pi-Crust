"use strict";
// The pure parts of src/project-protocol.js: addresses and the request guard rule (the end-to-end proof is the selftest step viewer-files).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const pp = require("../src/project-protocol");
const pf = require("../src/project-files");

const root = path.resolve(os.tmpdir(), "pp-test-project");
const other = path.resolve(os.tmpdir(), "pp-test-other");
const base = `pi-project://${pf.hostFor(root)}`;
// chain given innermost first: frame("", "ancestor1", "top")
const chain = (urls) => { let f = null; for (let i = urls.length - 1; i >= 0; i--) f = { url: urls[i], parent: f }; return f; };

test("scheme privileges: no service workers, no CORS bypass", () => {
	assert.deepEqual(pp.SCHEME_PRIVILEGES, { standard: true, secure: true, supportFetchAPI: true, stream: true });
});
test("addresses round-trip, spaces and unicode encoded", () => {
	const a = pp.toAddress(root, "docs" + String.fromCharCode(92) + "a b/é.html");
	assert.equal(a, `${base}/docs/a%20b/%C3%A9.html`);
	assert.equal(pp.fromAddress(root, a), "docs/a b/é.html");
	assert.equal(pp.fromAddress(root, `pi-project://${pf.hostFor(other)}/x`), null);
	assert.equal(pp.fromAddress(root, "https://example.com/x"), null);
	assert.equal(pp.fromAddress(root, "garbage"), null);
	assert.equal(pp.belongsToProject(root, a), true);
	assert.equal(pp.belongsToProject(null, a), false);
});
test("guard: project page subresources allowed, web frames and no frame refused", () => {
	const page = `${base}/a.html`;
	for (const t of ["script", "image", "font", "stylesheet", "xhr", "media"]) {
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain([page]) }, root), true, t);
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain(["https://evil.example/", page]) }, root), false, t + " from a web frame in a project page");
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain(["https://evil.example/"]) }, root), false, t + " from a web page");
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain([page, "https://evil.example/"]) }, root), false, t + " from a project page inside a web page");
		assert.equal(pp.guardAllows({ resourceType: t, frame: null }, root), false, t + " without a frame");
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain([`pi-project://${pf.hostFor(other)}/x.html`]) }, root), false, t + " from another project's page");
	}
});
test("guard: frames and top-level navigations", () => {
	const page = `${base}/a.html`;
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain(["", page]) }, root), true);
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain(["", "https://evil.example/", page]) }, root), false);
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain(["https://evil.example/", page]) }, root), false, "a web frame navigating itself");
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain([""]) }, root), false, "no parent");
	assert.equal(pp.guardAllows({ resourceType: "mainFrame", frame: chain([""]) }, root), true);
	assert.equal(pp.guardAllows({ resourceType: "mainFrame", frame: null }, root), true);
	assert.equal(pp.guardAllows({ resourceType: "mainFrame", frame: chain(["", page]) }, root), false, "a top-level request cannot come from a child frame");
});

test("guard: frames a project page makes itself (about:srcdoc, about:blank, blob: of the project) may load project files", () => {
	const page = `${base}/a.html`;
	const blob = `blob:${base}/0b6c2a3e-1111-2222-3333-444455556666`;
	for (const t of ["script", "image", "font", "stylesheet", "xhr", "media"]) {
		for (const own of ["about:srcdoc", "about:blank", blob]) {
			assert.equal(pp.guardAllows({ resourceType: t, frame: chain([own, page]) }, root), true, `${t} from ${own} under a project page`);
			assert.equal(pp.guardAllows({ resourceType: t, frame: chain([own, own, page]) }, root), true, `${t} from ${own} nested in itself`);
			assert.equal(pp.guardAllows({ resourceType: t, frame: chain([own, "https://evil.example/", page]) }, root), false, `${t} from ${own} under a web frame in a project page`);
			assert.equal(pp.guardAllows({ resourceType: t, frame: chain([own, "https://evil.example/"]) }, root), false, `${t} from ${own} under a web page`);
			assert.equal(pp.guardAllows({ resourceType: t, frame: chain([own]) }, root), false, `${t} from ${own} with no project page above`);
			assert.equal(pp.guardAllows({ resourceType: t, frame: chain([own, `pi-project://${pf.hostFor(other)}/x.html`]) }, root), false, `${t} from ${own} under another project's page`);
		}
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain([`blob:https://evil.example/abc`, page]) }, root), false, "a blob of a web site under a project page");
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain([`blob:pi-project://${pf.hostFor(other)}/abc`, page]) }, root), false, "a blob of another project");
		assert.equal(pp.guardAllows({ resourceType: t, frame: chain(["about:srcdoc", "https://evil.example/", "about:srcdoc", page]) }, root), false, "a web frame anywhere in the chain");
	}
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain(["", "about:srcdoc", page]) }, root), true, "a frame inside such a frame");
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain(["", "about:srcdoc", "https://evil.example/", page]) }, root), false);
	assert.equal(pp.guardAllows({ resourceType: "subFrame", frame: chain(["", "about:srcdoc"]) }, root), false, "no project page above");
});

test("partition: one per project, named by the host label", () => {
	assert.equal(pp.partitionFor(root), `persist:viewer-project-${pf.hostFor(root)}`);
	assert.notEqual(pp.partitionFor(root), pp.partitionFor(other));
	assert.equal(pp.viewerWebPreferences(root).partition, pp.partitionFor(root));
	assert.notEqual(pp.viewerWebPreferences(other).partition, pp.viewerWebPreferences(root).partition);
	assert.equal(pp.viewerWebPreferences(root).sandbox, true);
	assert.equal(pp.viewerWebPreferences(root).nodeIntegration, false);
});

test("sessions: handler and guard go on a project's session when it is first used, and on no other", () => {
	const made = new Map();
	const fakeSession = (name) => {
		const calls = { handle: 0, guard: 0, perm: 0 };
		return { name, calls, protocol: { handle: () => calls.handle++ }, webRequest: { onBeforeRequest: () => calls.guard++ }, setPermissionRequestHandler: () => calls.perm++, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {} };
	};
	const session = { fromPartition: (n) => { if (!made.has(n)) made.set(n, fakeSession(n)); return made.get(n); } };
	const events = [];
	const reg = pp.register({ session, app: { on: (e, f) => events.push([e, f]) }, getRoot: () => root });
	assert.equal(made.size, 0, "nothing is registered before a project is used");
	const a = pp.ensureSession(root);
	assert.equal(made.size, 1);
	assert.equal(a.name, pp.partitionFor(root));
	assert.deepEqual(a.calls, { handle: 1, guard: 1, perm: 1 });
	assert.equal(pp.ensureSession(root), a, "the same session again, set up once");
	assert.deepEqual(a.calls, { handle: 1, guard: 1, perm: 1 });
	const b = pp.ensureSession(other);
	assert.notEqual(a, b);
	assert.deepEqual([...made.keys()].sort(), [pp.partitionFor(root), pp.partitionFor(other)].sort(), "only the two project sessions were ever touched");
	assert.deepEqual(b.calls, { handle: 1, guard: 1, perm: 1 });
	assert.equal(reg.sessions.size, 2);
	// the popup block is applied to pages of these sessions only
	const hooked = [];
	const wcOf = (ses) => ({ session: ses, setWindowOpenHandler: () => hooked.push(ses.name) });
	const onCreated = events.find(([e]) => e === "web-contents-created")[1];
	onCreated({}, wcOf(a));
	onCreated({}, wcOf(b));
	onCreated({}, wcOf({ name: "persist:devbrowser" }));
	assert.deepEqual(hooked, [a.name, b.name]);
});

// ---- the body is exactly the checked size (review fix 2) ----

// `pf` with an action that runs right after the file was checked (by `open`, or by `resolve` in the old code path).
const afterCheck = (act) => ({ ...pf, open: (...a) => { const r = pf.open(...a); act(); return r; }, resolve: (...a) => { const r = pf.resolve(...a); act(); return r; } });
function tmpProject(content) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-serve-")));
	fs.writeFileSync(path.join(dir, "big.txt"), content);
	return dir;
}
const bytes = async (res) => (res.body ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0));
const req = (r, url, headers = {}) => new Request(`pi-project://${pf.hostFor(r)}${url}`, { headers });

test("serve: a 200 streams exactly the size that was checked, a 206 too", async () => {
	const dir = tmpProject("0123456789");
	try {
		const res = pp.serve(req(dir, "/big.txt"), dir);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-length"), "10");
		assert.equal((await bytes(res)).toString(), "0123456789");
		const part = pp.serve(req(dir, "/big.txt", { range: "bytes=2-5" }), dir);
		assert.equal(part.status, 206);
		assert.equal((await bytes(part)).toString(), "2345");
		const head = pp.serve(new Request(req(dir, "/big.txt").url, { method: "HEAD" }), dir);
		assert.equal(head.headers.get("content-length"), "10");
		assert.equal((await bytes(head)).length, 0);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("serve: a file that grew after the check is cut at the checked size; one that shrank ends early, never longer", async () => {
	const dir = tmpProject("0123456789");
	try {
		const grow = afterCheck(() => fs.appendFileSync(path.join(dir, "big.txt"), "ABCDEFGHIJKLMNOP"));
		const g = pp.serve(req(dir, "/big.txt"), dir, grow);
		assert.equal(g.headers.get("content-length"), "10");
		assert.equal((await bytes(g)).toString(), "0123456789", "never an over-long body");
		fs.writeFileSync(path.join(dir, "big.txt"), "0123456789");
		const growRange = pp.serve(req(dir, "/big.txt", { range: "bytes=5-" }), dir, afterCheck(() => fs.appendFileSync(path.join(dir, "big.txt"), "ZZZZZ")));
		assert.equal((await bytes(growRange)).toString(), "56789");
		fs.writeFileSync(path.join(dir, "big.txt"), "0123456789");
		const shrink = afterCheck(() => fs.truncateSync(path.join(dir, "big.txt"), 4));
		const s = pp.serve(req(dir, "/big.txt"), dir, shrink);
		let got = Buffer.alloc(0);
		try { got = await bytes(s); } catch { /* the stream may end with an error: also not over-long */ }
		assert.ok(got.length <= 10, "never over-long");
		assert.equal("0123456789".startsWith(got.toString()), true, "what is sent is the start of the file");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("serve: an empty file, a refused range and a missing file leave no handle open", async () => {
	const dir = tmpProject("");
	try {
		const e = pp.serve(req(dir, "/big.txt"), dir);
		assert.equal(e.status, 200);
		assert.equal(e.headers.get("content-length"), "0");
		assert.equal((await bytes(e)).length, 0);
		assert.equal(pp.serve(req(dir, "/big.txt", { range: "bytes=1-2" }), dir).status, 416);
		assert.equal(pp.serve(req(dir, "/nope.txt"), dir).status, 404);
		fs.rmSync(path.join(dir, "big.txt")); // would fail on Windows if a handle were still open without share-delete; also checks it is gone
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
