// The visible line of the show_in_viewer tool card in the chat (spec: Viewer tabs and project files, section E): what happened, in words,
// without opening the card. Pure, so a node test covers it (scripts/viewer-agent.test.js). The renderer and the test both use it.
//   "Opened docs/pricing.html in the Viewer"   the page is in a new background tab
//   "Already open: docs/pricing.html"          a tab already shows it
//   "Not shown: <reason>"                      the call was refused or failed; the reason is the tool's own first sentence
// A success is the first line of the tool's result text (viewer-agent-main.js writes it that way); a failure is the whole result with
// "Not shown: " in front.
"use strict";
(() => {
	const MAX = 160;
	const clip = (s) => (s.length > MAX ? s.slice(0, MAX - 1) + "\u2026" : s);
	function line(text, isError) {
		const first = String(text == null ? "" : text).trim().split(/\r?\n/)[0].trim();
		if (isError) return clip(`Not shown: ${first.replace(/^Not shown:\s*/i, "") || "the call failed."}`);
		if (/^(Opened .+ in the Viewer|Already open: .+)$/.test(first)) return clip(first);
		return "";
	}
	const api = { line };
	if (typeof module === "object" && module.exports) module.exports = api;
	else window.ViewerAgentLine = api;
})();
