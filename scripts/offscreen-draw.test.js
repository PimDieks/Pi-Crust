"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { create } = require("../src/offscreen-draw");

const img = (empty) => ({ isEmpty: () => empty });
function fakes() {
	const state = { bounds: { x: 0, y: 0, width: 100, height: 80 }, visible: false, destroyed: false, relayouts: 0, frames: 0 };
	const view = {
		getBounds: () => state.bounds,
		setBounds: (b) => (state.bounds = b),
		setVisible: (v) => (state.visible = v),
		isDestroyed: () => state.destroyed,
	};
	const wc = { invalidate() {}, capturePage: async () => img(++state.frames < 2), isDestroyed: () => false };
	return { state, view, wc };
}

test("a layout change during the wait is not undone: the capture only asks the layout to re-apply", async () => {
	const { state, view, wc } = fakes();
	const real = { x: 10, y: 10, width: 300, height: 200 };
	// the "layout": what applyBrowserBounds does
	const relayout = () => {
		state.relayouts++;
		view.setBounds(real);
		view.setVisible(state.shouldShow);
	};
	state.shouldShow = false;
	const d = create({ relayout, delay: async () => { if (state.frames === 0) { state.shouldShow = true; relayout(); } } });
	const out = await d.draw(view, wc, undefined, () => img(true));
	assert.strictEqual(out.isEmpty(), false);
	assert.deepStrictEqual(state.bounds, real);
	assert.strictEqual(state.visible, true); // the user opened the Viewer meanwhile: it stays shown
});

test("a destroyed view gives an empty image, not a throw", async () => {
	const { state, view, wc } = fakes();
	state.destroyed = true;
	const d = create({ relayout: () => { throw new Error("gone"); }, delay: async () => {} });
	const out = await d.draw(view, wc, undefined, () => img(true));
	assert.strictEqual(out.isEmpty(), true);
});

test("a view destroyed during the wait does not turn into an error", async () => {
	const { state, view, wc } = fakes();
	const d = create({ relayout: () => { throw new Error("gone"); }, delay: async () => { state.destroyed = true; } });
	const out = await d.draw(view, wc, undefined, () => img(true));
	assert.strictEqual(out.isEmpty(), true);
});

test("a second draw waits for the first (idle) and then runs", async () => {
	const { state, view, wc } = fakes();
	const order = [];
	const d = create({ relayout: () => order.push("relayout"), delay: async () => { order.push("wait"); } });
	const a = d.draw(view, wc, undefined, () => img(true));
	assert.strictEqual(d.busy(), true);
	const b = d.draw(view, wc, undefined, () => img(true));
	await d.idle();
	await Promise.all([a, b]);
	assert.deepStrictEqual(order, ["wait", "wait", "relayout", "wait", "relayout"]); // no overlap
	assert.strictEqual(d.busy(), false);
});

test("idle() resolves only after a running draw has finished and the layout was re-applied", async () => {
	const { view, wc } = fakes();
	let relaid = false;
	const d = create({ relayout: () => (relaid = true), delay: async () => {} });
	d.draw(view, wc, undefined, () => img(true));
	await d.idle();
	assert.strictEqual(relaid, true);
	assert.strictEqual(d.busy(), false);
});
