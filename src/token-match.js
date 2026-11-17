// Matching computed styles against design tokens. UMD: `TokenMatch` in the UI, `require("./token-match")` in tests and the main
// process; `source` is the factory's source, so page-tokens.js can inline the same code into the page being inspected.
//  - normalizeColor("#f00" | "rgb(...)" | "rgba(...)" | "hsl(...)" | "color(srgb ...)" | "oklch(...)" | "oklab(...)" | "transparent") -> { r, g, b, a } | null
//  - matchColor(value, tokens [{ name, value }]) -> { token, nearest, delta }   (delta: 0..100, 0 = identical)
//  - matchLength(value, tokens)                                                   (delta in px)
//  - matchTypography(style { fontSize, fontWeight, lineHeight }, tokens [{ name, fontSize, fontWeight, lineHeight }])
// `token` is the exact match (or null), `nearest` the closest other token (or null), `delta` the distance to it.
(function (root, make) {
	const api = make();
	api.source = `(${make.toString()})`;
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.TokenMatch = api;
})(typeof self !== "undefined" ? self : this, function () {
	function hslToRgb(h, s, l) {
		h = (((h % 360) + 360) % 360) / 360;
		const f = (n) => {
			const k = (n + h * 12) % 12;
			return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		};
		return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
	}

	function normalizeColor(input) {
		if (input == null) return null;
		const s = String(input).trim().toLowerCase();
		if (!s) return null;
		if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
		let m;
		if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
			let h = m[1];
			if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
			if (h.length !== 6 && h.length !== 8) return null;
			return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100 : 1 };
		}
		if ((m = /^rgba?\(\s*([^)]+)\)$/.exec(s))) {
			const parts = m[1].split(/[\s,/]+/).filter(Boolean);
			if (parts.length < 3) return null;
			const ch = (v) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
			const [r, g, b] = parts.slice(0, 3).map((v) => Math.round(ch(v)));
			let a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
			if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
			return { r, g, b, a: Math.round(a * 100) / 100 };
		}
		if ((m = /^hsla?\(\s*([^)]+)\)$/.exec(s))) {
			const parts = m[1].split(/[\s,/]+/).filter(Boolean);
			if (parts.length < 3) return null;
			const [r, g, b] = hslToRgb(parseFloat(parts[0]), parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100);
			const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
			if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
			return { r, g, b, a: Math.round(a * 100) / 100 };
		}
		// color(srgb r g b / a): components 0..1 (other colour spaces are unsupported: null)
		if ((m = /^color\(\s*srgb\s+([^)]+)\)$/.exec(s))) {
			const parts = m[1].split(/[\s/]+/).filter(Boolean);
			if (parts.length < 3) return null;
			const ch = (v) => Math.round(Math.max(0, Math.min(1, v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v))) * 255);
			const [r, g, b] = parts.slice(0, 3).map(ch);
			const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
			if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
			return { r, g, b, a: Math.round(a * 100) / 100 };
		}
		// oklch(L C H / a) and oklab(L a b / a), converted to sRGB (what Chrome reports for modern colours)
		if ((m = /^(oklch|oklab)\(\s*([^)]+)\)$/.exec(s))) {
			const parts = m[2].split(/[\s/]+/).filter(Boolean);
			if (parts.length < 3) return null;
			const num = (v, pct) => (v.endsWith("%") ? (parseFloat(v) / 100) * pct : parseFloat(v));
			const L = num(parts[0], 1);
			let A;
			let B;
			if (m[1] === "oklch") {
				const C = num(parts[1], 0.4);
				const H = (parseFloat(parts[2]) * Math.PI) / 180;
				A = C * Math.cos(H);
				B = C * Math.sin(H);
			} else {
				A = num(parts[1], 0.4);
				B = num(parts[2], 0.4);
			}
			const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
			if ([L, A, B, a].some((n) => Number.isNaN(n))) return null;
			const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
			const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
			const ss = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
			const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss];
			const gam = (x) => Math.round(Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)) * 255);
			const [r, g, b] = lin.map(gam);
			return { r, g, b, a: Math.round(a * 100) / 100 };
		}
		return null;
	}

	// Distance between two colours, 0 (same) to 100 (black vs white); alpha counts too.
	function colorDelta(a, b) {
		const d = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) / Math.sqrt(3 * 255 * 255);
		return Math.round((d * 0.85 + Math.abs(a.a - b.a) * 0.15) * 1000) / 10;
	}

	function matchColor(value, tokens) {
		const c = normalizeColor(value);
		if (!c) return { token: null, nearest: null, delta: null };
		let exact = null;
		let nearest = null;
		let best = Infinity;
		for (const t of tokens || []) {
			const tc = normalizeColor(t.value);
			if (!tc) continue;
			const d = colorDelta(c, tc);
			if (d === 0) exact = exact || t.name;
			else if (d < best) {
				best = d;
				nearest = t.name;
			}
		}
		return exact ? { token: exact, nearest: null, delta: 0 } : { token: null, nearest, delta: nearest ? best : null };
	}

	// "8px" | "0.5rem" | 8 -> px (rem and em = 16px), or null.
	function toPx(v) {
		if (typeof v === "number") return v;
		const m = /^(-?[\d.]+)(px|rem|em)?$/.exec(String(v).trim());
		if (!m) return null;
		return m[2] === "rem" || m[2] === "em" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
	}

	function matchLength(value, tokens) {
		const px = toPx(value);
		if (px == null) return { token: null, nearest: null, delta: null };
		let exact = null;
		let nearest = null;
		let best = Infinity;
		for (const t of tokens || []) {
			const tp = toPx(t.value);
			if (tp == null) continue;
			const d = Math.abs(tp - px);
			if (d < 0.01) exact = exact || t.name;
			else if (d < best) {
				best = d;
				nearest = t.name;
			}
		}
		return exact ? { token: exact, nearest: null, delta: 0 } : { token: null, nearest, delta: nearest ? Math.round(best * 100) / 100 : null };
	}

	function matchTypography(style, tokens) {
		const size = toPx(style.fontSize);
		const weight = Number(style.fontWeight) || 400;
		const lh = style.lineHeight === "normal" || style.lineHeight == null ? null : toPx(style.lineHeight);
		let exact = null;
		let nearest = null;
		let best = Infinity;
		for (const t of tokens || []) {
			const ts = toPx(t.fontSize);
			if (ts == null || size == null) continue;
			const tw = Number(t.fontWeight) || 400;
			const tl = t.lineHeight == null ? null : toPx(t.lineHeight);
			const lhOk = lh == null || tl == null || Math.abs(lh - tl) < 1;
			const d = Math.abs(ts - size) + Math.abs(tw - weight) / 100 + (lhOk ? 0 : Math.abs(lh - tl) / 4);
			if (d < 0.01) exact = exact || t.name;
			else if (d < best) {
				best = d;
				nearest = t.name;
			}
		}
		return exact ? { token: exact, nearest: null, delta: 0 } : { token: null, nearest, delta: nearest ? Math.round(best * 100) / 100 : null };
	}

	// Relative luminance and WCAG contrast ratio of two colours (objects from normalizeColor, alpha ignored).
	function luminance(c) {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	}
	function contrast(a, b) {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
	}

	return { normalizeColor, colorDelta, matchColor, matchLength, matchTypography, toPx, contrast };
});
