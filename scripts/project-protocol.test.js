"use strict";
// The pure parts of src/project-protocol.js: addresses and the request guard rule (the end-to-end proof is the selftest step viewer-files).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
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
