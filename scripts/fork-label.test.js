"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { forkLabel } = require("../src/fork-label");

test("the fork dialog line keeps every letter, including every s, and folds white space", () => {
	assert.equal(forkLabel({ text: "Please assess the disastrous results" }, 0), "1. Please assess the disastrous results");
	assert.equal(forkLabel({ text: "first line\n\n  second\tline   here" }, 2), "3. first line second line here");
	assert.equal(forkLabel({ text: "s".repeat(150) }, 0), "1. " + "s".repeat(100));
	assert.equal(forkLabel({}, 0), "1. ");
});

test("both fork dialogs of slash.js use it (no copy of the folding left)", () => {
	const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "slash.js"), "utf8");
	assert.ok(!/replace\(\/s\+\/g/.test(src), "a replace without the backslash");
	assert.equal((src.match(/ForkLabel\.forkLabel/g) || []).length, 2);
	assert.ok(/<script src="fork-label\.js"><\/script>\s*<script src="slash\.js">/.test(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "index.html"), "utf8")));
});
