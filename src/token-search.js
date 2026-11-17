// Token lookup for the Design tab: a query is a name fragment, a colour (any notation) or a length (12, 12px, 0.75rem; rem = 16px).
// UMD: `TokenSearch` in the UI, `require("./token-search")` in tests. Reuses token-match.js for parsing and distances.
//  - parseQuery(text) -> { kind: "color", color } | { kind: "length", px } | { kind: "name", text } | null
//  - search(text, tokens [{ name, value, group }], { near = 5, maxDelta }) -> { kind, exact: [], names: [], near: [{ ..., delta, label }] }
//  - cssForm(name, theme) -> "var(--x)" for CSS variables, "theme.path" for theme tokens (theme = true)
(function (root, make) {
	const api = make(typeof module === "object" && module.exports ? require("./token-match") : root.TokenMatch);
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.TokenSearch = api;
})(typeof self !== "undefined" ? self : this, function (TM) {
	const LENGTH = /^-?(\d+\.?\d*|\.\d+)(px|rem|em)?$/i;

	function parseQuery(text) {
		const q = String(text ?? "").trim();
		if (!q) return null;
		if (LENGTH.test(q)) return { kind: "length", px: TM.toPx(q.toLowerCase()) };
		if (/^#|^(rgba?|hsla?|oklch|oklab|color)\(/i.test(q) || q.toLowerCase() === "transparent") {
			const color = TM.normalizeColor(q);
			if (color) return { kind: "color", color };
		}
		return { kind: "name", text: q };
	}

	const bare = (n) => String(n).toLowerCase().replace(/^--/, "");
	const nameHit = (t, q) => {
		const x = bare(q).replace(/\s+/g, "-");
		return bare(t.name).includes(x) || String(t.name).toLowerCase().includes(q.toLowerCase());
	};

	function search(text, tokens, opts = {}) {
		const p = parseQuery(text);
		const out = { kind: p?.kind || null, exact: [], names: [], near: [] };
		if (!p) return out;
		const list = tokens || [];
		if (p.kind === "name") {
			out.names = list.filter((t) => nameHit(t, p.text));
			return out;
		}
		const scored = [];
		for (const t of list) {
			if (p.kind === "color") {
				const c = TM.normalizeColor(t.value);
				if (!c) continue;
				const d = TM.colorDelta(p.color, c);
				scored.push({ ...t, delta: d, label: d === 0 ? "exact" : `Δ ${d}` });
			} else {
				const px = TM.toPx(t.value);
				if (px == null) continue;
				const d = Math.round((px - p.px) * 100) / 100;
				scored.push({ ...t, delta: Math.abs(d), label: Math.abs(d) < 0.01 ? "exact" : `${d > 0 ? "+" : "-"}${Math.abs(d)}px` });
			}
		}
		out.exact = scored.filter((t) => t.delta < (p.kind === "length" ? 0.01 : 1e-9));
		const exactNames = new Set(out.exact.map((t) => t.name));
		const q = String(text).trim();
		out.names = list.filter((t) => !exactNames.has(t.name) && nameHit(t, q));
		const maxDelta = opts.maxDelta ?? Infinity;
		out.near = scored
			.filter((t) => !exactNames.has(t.name) && t.delta <= maxDelta)
			.sort((a, b) => a.delta - b.delta)
			.slice(0, opts.near ?? 5);
		return out;
	}

	function cssForm(name, theme) {
		return String(name).startsWith("--") ? `var(${name})` : theme ? `theme.${name}` : String(name);
	}

	return { parseQuery, search, cssForm };
});
