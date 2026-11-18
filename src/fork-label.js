// The line a message gets in the fork dialog: "<number>. <text with its white space folded to single spaces, cut at 100 characters>".
// UMD: `ForkLabel` in the UI, `require("./fork-label")` in tests.
(function (root, make) {
	const api = make();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.ForkLabel = api;
})(typeof self !== "undefined" ? self : this, function () {
	const forkLabel = (m, i) => `${i + 1}. ${String((m && m.text) || "").replace(/\s+/g, " ").slice(0, 100)}`;
	return { forkLabel };
});
