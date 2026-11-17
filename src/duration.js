// Duration formatting and turn/subagent progress. UMD: `Duration` in the UI, `require("./duration")` in tests.
(function (root, make) {
	const api = make();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.Duration = api;
})(typeof self !== "undefined" ? self : this, function () {
	const pad2 = (n) => String(n).padStart(2, "0");
	function formatDuration(ms, { precise = false } = {}) {
		if (!Number.isFinite(ms) || ms < 0) ms = 0;
		if (precise && ms < 10000) return (ms / 1000).toFixed(1) + "s";
		const s = Math.floor(ms / 1000);
		if (s < 60) return s + "s";
		if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
		return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
	}
	const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
	function activityLabel(turn) {
		if (!turn) return "";
		const parts = [];
		if (turn.tools > 0) parts.push(plural(turn.tools, "tool call"));
		if (turn.last) parts.push(turn.last);
		return parts.join(" · ");
	}
	function turnSummary({ ms, tools = 0, aborted = false }) {
		const t = formatDuration(ms);
		if (aborted) return `Stopped after ${t}`;
		return `Worked ${t}${tools ? ` · ${plural(tools, "tool call")}` : ""}`;
	}
	const endOf = (m) => m.timestamp + (m.role === "assistant" ? m.durationMs || 0 : 0);
	function messagesSpan(messages) {
		let start = null, end = null;
		for (const m of messages || []) {
			if (!m || typeof m.timestamp !== "number") continue;
			const e = endOf(m);
			if (start === null || m.timestamp < start) start = m.timestamp;
			if (end === null || e > end) end = e;
		}
		return { start, end };
	}
	function subagentProgress({ mode, states = [], total }) {
		total = Math.max(total || 0, states.length);
		const count = (k) => states.filter((s) => s === k).length;
		const done = count("done"), failed = count("failed"), running = count("running");
		const finished = done + failed;
		let label = "";
		if (mode === "chain") label = running ? `step ${states.indexOf("running") + 1} of ${total}` : `${finished} of ${total} done`;
		else if (mode === "parallel") label = `${finished} of ${total} done${running ? ` · ${running} running` : ""}`;
		if (mode !== "single" && failed > 0) label += ` · ${failed} failed`;
		return { total, done, failed, running, finished, fraction: total ? finished / total : 0, label };
	}
	function turnSpans(messages) {
		const out = new Map();
		let cur = null;
		const close = () => {
			if (cur && cur.last > cur.index) {
				const ms = cur.end - cur.start;
				if (Number.isFinite(ms)) out.set(cur.last, { ms, tools: cur.tools, aborted: cur.aborted });
			}
			cur = null;
		};
		(messages || []).forEach((m, i) => {
			if (!m) return;
			if (m.role === "user") { close(); cur = { index: i, start: m.timestamp, end: m.timestamp, last: i, tools: 0, aborted: false }; return; }
			if (!cur || (m.role !== "assistant" && m.role !== "toolResult")) return;
			if (typeof m.timestamp === "number") cur.end = Math.max(cur.end, endOf(m));
			cur.last = i;
			if (m.role === "assistant") {
				cur.tools += (m.content || []).filter((b) => b && b.type === "toolCall").length;
				cur.aborted = m.stopReason === "aborted";
			}
		});
		close();
		return out;
	}
	return { formatDuration, plural, activityLabel, turnSummary, messagesSpan, subagentProgress, turnSpans };
});
