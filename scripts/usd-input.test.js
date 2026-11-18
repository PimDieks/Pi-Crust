"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, show } = require("../src/usd-input");

test("a comma or a point is accepted, the value is in cents", () => {
	for (const [t, v] of [["7.5", 7.5], ["7,5", 7.5], ["7,50", 7.5], ["$7.50", 7.5], [" 12 ", 12], ["0,5", 0.5], ["1000", 1000]]) assert.deepEqual(parse(t), { ok: true, value: v }, t);
});
test("zero, negatives and text are refused with a sentence", () => {
	for (const t of ["0", "0,00", "-3", "-0.5", "abc", "", "7.5.1", "1e3", "7,555", "0.1", "1001", "7 dollars"]) {
		const r = parse(t);
		assert.equal(r.ok, false, t);
		assert.match(r.error, /^["A-Z].*[.)]$/, t);
	}
	assert.match(parse("0").error, /zero/);
	assert.match(parse("-3").error, /negative/);
	assert.match(parse("abc").error, /not an amount/);
});
test("shown with two decimals and a point", () => {
	assert.equal(show(7.5), "7.50");
	assert.equal(show(5), "5.00");
	assert.equal(show("x"), "0.00");
});
