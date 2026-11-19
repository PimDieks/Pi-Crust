"use strict";
// The kind table of the Viewer (src/viewer-kind.js): which tools work on a page, an image and a PDF tab, and the reason when one does not.
// The end-to-end proof is the selftest step viewer-tools.
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../src/viewer-kind");

const ALL = ["pick", "tweak", "state", "scheme", "annotate", "capture", "viewports", "shots"];

test("a page: every tool works, no reason", () => {
	for (const f of ALL) {
		assert.equal(K.can("page", f), true, f);
		assert.equal(K.reason("page", f), "", f);
	}
});

test("an image: Pick, Tweak, State, light/dark and the before/after card need a page; Annotate, Capture build and Viewports work", () => {
	for (const f of ["pick", "tweak", "state", "scheme", "shots"]) {
		assert.equal(K.can("image", f), false, f);
		assert.equal(K.reason("image", f), "Needs a web page. This tab shows an image.", f);
	}
	for (const f of ["annotate", "capture", "viewports"]) assert.equal(K.can("image", f), true, f);
});

test("a PDF: nothing works; Annotate, Capture build and Viewports say a page or an image is needed", () => {
	for (const f of ["pick", "tweak", "state", "scheme", "shots"]) assert.equal(K.reason("pdf", f), "Needs a web page. This tab shows a PDF.", f);
	for (const f of ["annotate", "capture", "viewports"]) {
		assert.equal(K.can("pdf", f), false, f);
		assert.equal(K.reason("pdf", f), "Needs a web page or an image. This tab shows a PDF.", f);
	}
});

test("an unknown kind is treated as a page", () => {
	assert.equal(K.norm(undefined), "page");
	assert.equal(K.norm("other"), "page");
	for (const f of ALL) assert.equal(K.can("whatever", f), true);
});

test("a tab that did not load, or whose file is gone, has nothing to work on (P3)", () => {
	const err = (extra) => ({ code: -105, desc: "NAME_NOT_RESOLVED", url: "https://x/", ...extra });
	assert.equal(K.brokenOf(null), "");
	assert.equal(K.brokenOf(err()), "load");
	assert.equal(K.brokenOf(err({ missing: true })), "missing");
	assert.equal(K.brokenOf(err({ unloaded: true })), "unloaded");
	for (const f of ["pick", "tweak", "state", "annotate", "capture", "viewports"]) {
		for (const kind of ["page", "image"]) {
			assert.equal(K.can(kind, f, "load"), false, `${kind} ${f}`);
			assert.equal(K.reason(kind, f, "load"), "Nothing to work on. This page did not load.");
			assert.equal(K.reason(kind, f, "missing"), "Nothing to work on. This file no longer exists.");
			assert.equal(K.reason(kind, f, "unloaded"), "Nothing to work on. This page is not loaded yet. Choose Load.");
		}
	}
	assert.equal(K.can("page", "pick", ""), true, "a page that loaded is unchanged");
	assert.equal(K.reason("page", "pick"), "");
});
