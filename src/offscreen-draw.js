// Capture of a never-drawn hidden native view: shows it with only its bottom-right pixel inside the window (a view wholly outside it is
// never drawn) for 150 ms to 1.5 s (8 tries 150 ms apart), captures a frame, then asks the layout code to put things right again.
// It never restores a bounds snapshot of its own: the layout (relayout) is the one owner of bounds and visibility, so a tab or project
// switch or a resize during the wait is never undone. Draws run one at a time; callers wait for a running one with idle().
// Tried instead: the DevTools protocol Page.captureScreenshot on the hidden view never answers; a cover view is itself visible.
"use strict";

function create({ relayout, delay = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 8, stepMs = 150 } = {}) {
	let chain = Promise.resolve();
	let pending = 0;
	const alive = (o) => {
		try {
			return !!o && !(typeof o.isDestroyed === "function" && o.isDestroyed());
		} catch {
			return false;
		}
	};
	async function run(view, wc, rect, empty) {
		let img = empty();
		if (!alive(view) || !alive(wc)) return img;
		try {
			const b = view.getBounds();
			view.setBounds({ x: 1 - b.width, y: 1 - b.height, width: b.width, height: b.height });
			view.setVisible(true);
			for (let i = 0; i < tries && img.isEmpty(); i++) {
				await delay(stepMs);
				if (!alive(view) || !alive(wc)) break;
				try {
					wc.invalidate();
					img = await wc.capturePage(rect && rect.width > 0 ? rect : undefined);
				} catch {}
			}
		} catch {
		} finally {
			try {
				relayout();
			} catch {}
		}
		return img;
	}
	return {
		draw(view, wc, rect, empty) {
			pending++;
			const p = chain.then(() => run(view, wc, rect, empty));
			const done = () => pending--;
			chain = p.then(done, done);
			return p;
		},
		busy: () => pending > 0,
		idle: () => chain,
	};
}

module.exports = { create };
