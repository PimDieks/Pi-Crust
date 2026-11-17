// Model & usage pill in the chat header: the current model, the context fill and the Copilot premium requests
// left in one element. Its popover switches the model and shows what the context is used for, which models the
// session used and the Copilot quota. Context data comes from the "crust-context" status that src/pi-extension/crust-context.ts
// sets in each chat's Pi; the Copilot quota from the "copilot-usage" status of ~/.pi/agent/extensions/copilot-usage.ts.
"use strict";

const CTX_CATEGORIES = [
	{ key: "messages", label: "Messages", color: "#5c94d5" },
	{ key: "tools", label: "System tools", color: "#e07a3f" },
	{ key: "skills", label: "Skills", color: "#4fa98a" },
	{ key: "system", label: "System prompt", color: "#d4a531" },
	{ key: "memory", label: "Memory files", color: "#d0618a" },
	{ key: "reserve", label: "Autocompact buffer", color: "#6b7374" },
];
let ctxOpen = false;
let ctxMemoryOpen = false;

function ctxData() {
	const raw = active?.state.statuses.get("crust-context");
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// "Copilot 50% (25.2k)" (percent remaining), "Copilot ∞" or "Copilot ?". The quota is per account, so any chat's will do.
function copilotData() {
	let raw = active?.state.statuses.get("copilot-usage");
	if (!raw) for (const c of chats.values()) if ((raw = c.state.statuses.get("copilot-usage"))) break;
	if (!raw) return null;
	const text = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
	const m = text.match(/(\d+(?:\.\d+)?)%\s*\(([^)]+)\)/);
	if (m) return { state: "ok", left: +m[1], remaining: m[2], text };
	if (text.includes("∞")) return { state: "unlimited", text };
	return { state: "unknown", text };
}
const levelColor = (usedPct) => (usedPct >= 90 ? "var(--err)" : usedPct >= 75 ? "var(--fills-minor)" : "var(--accent)");

const fmtTok = (n) => {
	if (n == null) return "?";
	if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
	return String(Math.round(n));
};
const fmtPct = (n, w) => (w ? `${((n / w) * 100).toFixed(1)}%` : "—");
const ctxShortModel = (m) => (m || "").replace(/^github-copilot\//, "");

// Used tokens: Pi's real total when known, else the sum of the estimated parts.
function ctxUsed(d) {
	const c = d.categories;
	return d.total ?? c.messages + c.tools + c.skills + c.system + c.memory;
}

function renderContextMeter() {
	const btn = $("#ctx-meter");
	const d = ctxData();
	const cp = copilotData();
	const hasCtx = !!(d && d.window);
	const tips = [`Model: ${btn.querySelector(".pill-model").textContent}`];
	const ctxSeg = btn.querySelector('[data-seg="ctx"]');
	ctxSeg.hidden = !hasCtx;
	if (hasCtx) {
		const used = ctxUsed(d);
		const pct = Math.min(100, (used / d.window) * 100);
		const fill = ctxSeg.querySelector(".ctx-bar > span");
		fill.style.width = `${pct}%`;
		fill.style.background = levelColor(pct);
		ctxSeg.querySelector(".ctx-pct").textContent = `${d.total == null ? "≈" : ""}${Math.round(pct)}%`;
		tips.push(`Context: ${fmtTok(used)} / ${fmtTok(d.window)} tokens`);
	}
	const cpSeg = btn.querySelector('[data-seg="copilot"]');
	cpSeg.hidden = !cp;
	if (cp) {
		const fill = cpSeg.querySelector(".ctx-bar > span");
		// Like a battery: the bar shows what is left.
		const left = cp.state === "ok" ? cp.left : cp.state === "unlimited" ? 100 : 0;
		fill.style.width = `${left}%`;
		fill.style.background = cp.state === "ok" ? (cp.left < 10 ? "var(--err)" : cp.left < 25 ? "var(--fills-minor)" : "var(--ok)") : "var(--muted)";
		cpSeg.querySelector(".ctx-pct").textContent = cp.state === "ok" ? `${Math.round(cp.left)}%` : cp.state === "unlimited" ? "∞" : "?";
		tips.push(cp.state === "ok" ? `Copilot premium requests: ${Math.round(cp.left)}% left (${cp.remaining})` : cp.state === "unlimited" ? "Copilot premium requests: unlimited" : "Copilot usage unavailable");
	}
	btn.title = `${tips.join("\n")}\nClick to switch model or see the details.`;
	// Don't rebuild under the keyboard (filter or model list); it refreshes on the next update after that.
	if (ctxOpen && !$("#ctx-panel")?.contains(document.activeElement)) renderContextPanel();
}

function ctxRow(color, label, tokens, pct, opts = {}) {
	const row = el("div", `ctx-row${opts.cls ? ` ${opts.cls}` : ""}`);
	const sw = el("span", "ctx-swatch");
	if (color) sw.style.background = color;
	const lab = el("span", "ctx-label", label);
	if (opts.title) {
		lab.title = opts.title;
		lab.classList.add("hint");
	}
	row.append(sw, lab, el("span", "ctx-num", tokens), el("span", "ctx-pctcol", pct));
	return row;
}

function renderContextPanel() {
	let panel = $("#ctx-panel");
	const d = ctxData();
	const cp = copilotData();
	if (!panel) {
		panel = el("div");
		panel.id = "ctx-panel";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Context usage");
		document.body.append(panel);
	}
	const parts = [...(window.crustSubs?.parts() || []), ...modelParts()];
	if (d && d.window) parts.push(...contextParts(d));
	if (cp) parts.push(...copilotParts(cp, true));
	panel.replaceChildren(...parts);
	positionContextPanel();
}

// The models Pi can use; click (or Enter) to switch. A filter appears when the list is long.
let ctxModelFilter = "";
function modelParts() {
	const all = active?.models || [];
	const models = window.crustSubs?.filterModels(all) ?? all; // the selected subscription's models (subscriptions.js)
	const cur = active?.state.model;
	const head = el("div", `ctx-head${window.crustSubs ? " ctx-models-head" : ""}`);
	head.append(el("span", "ctx-title", "Model"));
	const parts = [head];
	if (!models.length) return [...parts, el("div", "ctx-empty", !active?.state.ready ? "Starting Pi…" : all.length ? "No models from this subscription in this chat." : "No models available.")];
	if (models.length > 8) {
		const f = el("input", "ctx-filter");
		f.placeholder = "Filter models…";
		f.spellcheck = false;
		f.value = ctxModelFilter;
		f.oninput = () => {
			ctxModelFilter = f.value;
			const q = f.value.toLowerCase();
			for (const b of $("#ctx-panel").querySelectorAll(".ctx-model-opt")) b.hidden = !b.dataset.search.includes(q);
		};
		f.onkeydown = (e) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				$("#ctx-panel .ctx-model-opt:not([hidden])")?.focus();
			} else if (e.key === "Enter") {
				e.preventDefault();
				$("#ctx-panel .ctx-model-opt:not([hidden])")?.click();
			}
		};
		parts.push(f);
	}
	const list = el("div", "ctx-model-list");
	list.setAttribute("role", "listbox");
	const q = ctxModelFilter.toLowerCase();
	const oneProvider = new Set(models.map((m) => m.provider)).size === 1; // then the provider column is noise
	for (const m of models) {
		const selected = !!cur && m.provider === cur.provider && m.id === cur.id;
		const b = el("button", `ctx-model-opt${selected ? " selected" : ""}`);
		b.type = "button";
		b.setAttribute("role", "option");
		b.setAttribute("aria-selected", String(selected));
		b.dataset.search = `${m.name || ""} ${m.provider}/${m.id}`.toLowerCase();
		b.hidden = !!q && !b.dataset.search.includes(q);
		b.title = `${m.provider}/${m.id}${m.contextWindow ? ` · ${fmtTok(m.contextWindow)} context` : ""}`;
		b.append(el("span", "check", selected ? "✓" : ""), el("span", "ctx-label", m.name || m.id), el("span", "ctx-num", oneProvider ? "" : m.provider.replace(/^github-copilot$/, "Copilot")));
		b.onclick = async () => {
			if (selected) return closeContextPanel();
			closeContextPanel();
			await switchModel(m.provider, m.id);
		};
		b.onkeydown = (e) => {
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			e.preventDefault();
			const opts = [...list.querySelectorAll(".ctx-model-opt:not([hidden])")];
			const i = opts.indexOf(b) + (e.key === "ArrowDown" ? 1 : -1);
			if (i < 0) $("#ctx-panel .ctx-filter")?.focus();
			else opts[Math.min(i, opts.length - 1)]?.focus();
		};
		list.append(b);
	}
	parts.push(list);
	return parts;
}

function copilotParts(cp, divider) {
	const head = el("div", `ctx-head${divider ? " ctx-models-head" : ""}`);
	head.append(el("span", "ctx-title", "Copilot premium requests"));
	if (cp.state !== "ok") return [head, el("div", "ctx-empty", cp.state === "unlimited" ? "Unlimited." : "Unavailable: check the gh login for the enterprise host (/copilot-usage in Pi says why).")];
	const sum = el("div", "ctx-sum");
	sum.append(el("span", "ctx-used", `${Math.round(cp.left)}% left`), el("span", "ctx-of", `${cp.remaining} remaining`));
	const bar = el("div", "ctx-stack");
	const seg = el("span");
	seg.style.width = `${cp.left}%`;
	seg.style.background = cp.left < 10 ? "var(--err)" : cp.left < 25 ? "var(--fills-minor)" : "var(--ok)";
	bar.append(seg);
	const note = el("div", "ctx-empty", "For the whole account, refreshed every few minutes. /copilot-usage shows the reset date.");
	return [head, sum, bar, note];
}

function contextParts(d) {
	const c = d.categories;
	const w = d.window;
	const used = ctxUsed(d);
	const free = Math.max(0, w - used - c.reserve);

	const head = el("div", "ctx-head ctx-models-head");
	head.append(el("span", "ctx-title", "Context"));
	const sum = el("div", "ctx-sum");
	sum.append(el("span", "ctx-used", `${d.total == null ? "≈" : ""}${Math.round((used / w) * 100)}% used`), el("span", "ctx-of", `${fmtTok(used)} / ${fmtTok(w)}`));

	const bar = el("div", "ctx-stack");
	for (const cat of CTX_CATEGORIES) {
		const v = c[cat.key];
		if (!v) continue;
		const seg = el("span");
		seg.style.width = `${(v / w) * 100}%`;
		seg.style.background = cat.color;
		seg.title = `${cat.label}: ${fmtTok(v)}`;
		bar.append(seg);
	}

	const rows = el("div", "ctx-rows");
	const titles = {
		messages: d.estimated ? "Estimated: Pi has no exact count right after a compaction" : "Conversation: your prompts, replies, tool calls and results",
		tools: `${d.toolCount} tool declarations sent to the model`,
		skills: `${d.skillCount} skills listed in the system prompt`,
		system: "Base prompt, rules, docs and other prompt sections",
		memory: d.memoryFiles.map((f) => f.path).join("\n") || "AGENTS.md / CLAUDE.md files",
		reserve: "Kept free; Pi compacts the conversation when the context reaches it",
	};
	for (const cat of CTX_CATEGORIES) {
		const v = c[cat.key];
		const label = cat.key === "messages" && d.estimated ? "Messages ≈" : cat.label;
		rows.append(ctxRow(cat.color, label, fmtTok(v), fmtPct(v, w), { title: titles[cat.key] }));
	}
	rows.append(ctxRow("transparent", "Free space", fmtTok(free), fmtPct(free, w), { cls: "free" }));
	if (d.deferredCount) rows.append(ctxRow("#6b7374", `Deferred tools (${d.deferredCount})`, fmtTok(d.deferred), "—", { cls: "gap", title: "Registered but not declared to the model: reachable via codemode / tool_search" }));

	const parts = [head, sum, bar, rows];

	if (d.memoryFiles.length) {
		const tog = el("button", "ctx-toggle");
		tog.type = "button";
		tog.setAttribute("aria-expanded", String(ctxMemoryOpen));
		tog.append(el("span", "chev", ctxMemoryOpen ? "▾" : "▸"), el("span", "ctx-label", "Memory files"), el("span", "ctx-count", String(d.memoryFiles.length)));
		tog.onclick = () => {
			ctxMemoryOpen = !ctxMemoryOpen;
			renderContextPanel();
		};
		parts.push(tog);
		if (ctxMemoryOpen) {
			const list = el("div", "ctx-files");
			for (const f of d.memoryFiles) {
				const r = el("div", "ctx-file");
				r.title = f.path;
				r.append(el("span", "ctx-label", tildeGuess(relUnder(f.path, info.repo) ?? f.path)), el("span", "ctx-num", fmtTok(f.tokens)));
				list.append(r);
			}
			parts.push(list);
		}
	}

	// Models used in this session.
	const mh = el("div", "ctx-head ctx-models-head");
	mh.append(el("span", "ctx-title", "Models used"));
	parts.push(mh);
	if (!d.models.length) parts.push(el("div", "ctx-empty", "No model calls yet."));
	else {
		const tbl = el("div", "ctx-models");
		let cost = 0;
		// Without the provider the name fits; keep it only where two providers serve a model with the same name.
		const bare = (s) => ctxShortModel(s).replace(/^[^/]+\//, "");
		const seen = new Map();
		for (const m of d.models) seen.set(bare(m.model), new Set([...(seen.get(bare(m.model)) || []), ctxShortModel(m.model)]));
		for (const m of d.models) {
			cost += m.cost;
			const r = el("div", "ctx-model-row");
			const name = el("span", "ctx-label", seen.get(bare(m.model)).size > 1 ? ctxShortModel(m.model) : bare(m.model));
			name.title = m.model;
			const meta = el("span", "ctx-meta", `${m.turns} turn${m.turns === 1 ? "" : "s"} · ↑${fmtTok(m.input + m.cacheRead + m.cacheWrite)} ↓${fmtTok(m.output)}`);
			meta.title = `input ${m.input}, cache read ${m.cacheRead}, cache write ${m.cacheWrite}, output ${m.output}`;
			const src = m.source === "subagent" ? el("span", "ctx-badge", "subagent") : null;
			// Two lines: the full model name and the cost, then the badge and the token counts under the name.
			const sub = el("span", "ctx-model-sub");
			sub.append(...(src ? [src] : []), meta);
			r.append(name, el("span", "ctx-num", m.cost ? `$${m.cost.toFixed(m.cost < 1 ? 3 : 2)}` : ""), sub);
			tbl.append(r);
		}
		parts.push(tbl);
		if (cost) {
			const t = el("div", "ctx-model-row total");
			t.append(el("span", "ctx-label", "Total"), el("span", "ctx-num", `$${cost.toFixed(cost < 1 ? 3 : 2)}`));
			parts.push(t);
		}
	}
	return parts;
}

function positionContextPanel() {
	const panel = $("#ctx-panel");
	if (!panel) return;
	// Stay inside the chat pane: the browser view is drawn above the DOM and would cover the popover.
	const r = $("#ctx-meter").getBoundingClientRect();
	const pane = $("#chat-pane").getBoundingClientRect();
	panel.style.maxWidth = `${Math.max(220, pane.width - 16)}px`;
	const width = panel.offsetWidth;
	panel.style.top = `${r.bottom + 6}px`;
	panel.style.left = `${Math.max(pane.left + 8, Math.min(r.left, pane.right - width - 8))}px`;
}

function openContextPanel(opts = {}) {
	ctxOpen = true;
	ctxModelFilter = "";
	$("#ctx-meter").setAttribute("aria-expanded", "true");
	renderContextPanel();
	const subsReady = window.crustSubs?.refresh(); // statuses come from `pi auth check`; the panel repaints when they arrive
	const focusSubs = () => ($("#ctx-panel .subs-pick:not(:disabled)") || $("#ctx-panel .subs-pick"))?.focus();
	if (opts.focusSubs) {
		focusSubs();
		// The rows appear once the status is in: focus the first one then, unless the user already moved focus inside.
		subsReady?.then(() => ctxOpen && !$("#ctx-panel")?.contains(document.activeElement) && focusSubs());
	} else if (opts.focusModels) ($("#ctx-panel .ctx-filter") || $("#ctx-panel .ctx-model-opt.selected") || $("#ctx-panel .ctx-model-opt"))?.focus();
}
function closeContextPanel() {
	ctxOpen = false;
	$("#ctx-meter").setAttribute("aria-expanded", "false");
	$("#ctx-panel")?.remove();
}

$("#ctx-meter").addEventListener("click", (e) => {
	e.stopPropagation();
	ctxOpen ? closeContextPanel() : openContextPanel();
});
document.addEventListener("mousedown", (e) => {
	if (ctxOpen && !e.target.closest("#ctx-panel, #ctx-meter")) closeContextPanel();
});
document.addEventListener("keydown", (e) => {
	if (ctxOpen && e.key === "Escape") {
		closeContextPanel();
		$("#ctx-meter").focus();
	}
});
window.addEventListener("resize", () => ctxOpen && positionContextPanel());
