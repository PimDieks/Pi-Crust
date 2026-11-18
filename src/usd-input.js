// Dollar amounts typed by a person: "7.5", "7,5", "$7.50". UMD: `UsdInput` in the UI, `require("./usd-input")` in tests.
// parse(text) -> { ok: true, value } (rounded to cents) or { ok: false, error } (a readable sentence). show(n) -> "7.50" (always two decimals, a point).
(function (root, make) {
	const api = make();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.UsdInput = api;
})(typeof self !== "undefined" ? self : this, function () {
	const MIN = 0.5;
	const MAX = 1000;
	const show = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2);
	function parse(text, { min = MIN, max = MAX } = {}) {
		const range = `from $${show(min)} to $${max}`;
		const s = String(text ?? "").trim().replace(/^\$\s*/, "");
		if (!s) return { ok: false, error: `Enter an amount in dollars, for example 7.50 (${range}).` };
		if (/^-\s*\d+(?:[.,]\d+)?$/.test(s)) return { ok: false, error: `The limit cannot be negative. Enter an amount ${range}.` };
		const m = /^(\d+)(?:[.,](\d*))?$/.exec(s);
		if (!m) return { ok: false, error: `"${s.length > 20 ? s.slice(0, 20) + "..." : s}" is not an amount. Type digits only, for example 7.50 (${range}).` };
		if ((m[2] || "").length > 2) return { ok: false, error: "Use at most two decimals, for example 7.50." };
		const v = Number(`${m[1]}.${m[2] || "0"}`);
		if (v === 0) return { ok: false, error: `The limit cannot be zero. Enter an amount ${range}.` };
		if (v < min) return { ok: false, error: `The limit must be at least $${show(min)}.` };
		if (v > max) return { ok: false, error: `The limit can be at most $${max}.` };
		return { ok: true, value: Math.round(v * 100) / 100 };
	}
	return { parse, show, MIN, MAX };
});
