// Pixel comparison of two same-size RGBA images with a YIQ colour distance (as in pixelmatch).
// UMD: `PixelDiff.diff(a, b, { threshold, color })` in the UI, `require("./pixel-diff")` in tests.
// a, b: { data: Uint8ClampedArray (RGBA), width, height }.
// -> { width, height, total, diffCount, matchPct, heatmap }: heatmap is RGBA; changed pixels get `color` (default red),
//    equal pixels a faint grey copy of `a`.
(function (root, factory) {
	if (typeof module === "object" && module.exports) module.exports = factory();
	else root.PixelDiff = factory();
})(typeof self !== "undefined" ? self : this, function () {
	const blend = (c, a) => 255 + (c - 255) * (a / 255); // over white

	function yiq(r, g, b) {
		return [r * 0.29889531 + g * 0.58662247 + b * 0.11448223, r * 0.59597799 - g * 0.2741761 - b * 0.32180189, r * 0.21147017 - g * 0.52261711 + b * 0.31114694];
	}

	// Squared YIQ distance between pixel i of a and b (alpha blended over white), weighted like pixelmatch.
	function delta(a, b, i) {
		const aa = a[i + 3];
		const ba = b[i + 3];
		const [y1, i1, q1] = yiq(blend(a[i], aa), blend(a[i + 1], aa), blend(a[i + 2], aa));
		const [y2, i2, q2] = yiq(blend(b[i], ba), blend(b[i + 1], ba), blend(b[i + 2], ba));
		const dy = y1 - y2;
		const di = i1 - i2;
		const dq = q1 - q2;
		return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
	}

	function diff(a, b, { threshold = 0.1, color = [245, 85, 82] } = {}) {
		if (!a || !b || a.width !== b.width || a.height !== b.height) throw new Error("Images must have the same size");
		const { width, height } = a;
		const total = width * height;
		const max = 35215 * threshold * threshold; // the largest possible delta is 35215
		const heatmap = new Uint8ClampedArray(total * 4);
		let diffCount = 0;
		for (let p = 0; p < total; p++) {
			const i = p * 4;
			if (delta(a.data, b.data, i) > max) {
				diffCount++;
				heatmap[i] = color[0];
				heatmap[i + 1] = color[1];
				heatmap[i + 2] = color[2];
				heatmap[i + 3] = 255;
			} else {
				const grey = yiq(blend(a.data[i], a.data[i + 3]), blend(a.data[i + 1], a.data[i + 3]), blend(a.data[i + 2], a.data[i + 3]))[0];
				heatmap[i] = heatmap[i + 1] = heatmap[i + 2] = Math.round(grey);
				heatmap[i + 3] = 70;
			}
		}
		return { width, height, total, diffCount, matchPct: total ? (1 - diffCount / total) * 100 : 100, heatmap };
	}

	// Share (0..1) of the pixels within `tolerance` (per channel) of the most common colour. ~1 means a blank page
	// (empty, still loading, a solid background); the tolerance absorbs JPEG noise. The most common colour is found
	// with 4-bit buckets, then pixels are counted against that bucket's mean, so a colour on a bucket edge isn't split.
	// Channel order doesn't matter (works on BGRA bitmaps too).
	function dominantShare(a, { tolerance = 12 } = {}) {
		const total = a.width * a.height;
		if (!total) return 1;
		const d = a.data;
		const buckets = new Map(); // key -> [count, sum0, sum1, sum2, sum3]
		let best = null;
		for (let p = 0; p < total; p++) {
			const i = p * 4;
			const key = ((d[i] >> 4) << 12) | ((d[i + 1] >> 4) << 8) | ((d[i + 2] >> 4) << 4) | (d[i + 3] >> 4);
			let b = buckets.get(key);
			if (!b) buckets.set(key, (b = [0, 0, 0, 0, 0]));
			b[0]++;
			for (let c = 0; c < 4; c++) b[c + 1] += d[i + c];
			if (!best || b[0] > best[0]) best = b;
		}
		const mean = [1, 2, 3, 4].map((c) => best[c] / best[0]);
		let near = 0;
		for (let p = 0; p < total; p++) {
			const i = p * 4;
			if (Math.abs(d[i] - mean[0]) <= tolerance && Math.abs(d[i + 1] - mean[1]) <= tolerance && Math.abs(d[i + 2] - mean[2]) <= tolerance && Math.abs(d[i + 3] - mean[3]) <= tolerance) near++;
		}
		return near / total;
	}

	return { diff, delta, dominantShare };
});
