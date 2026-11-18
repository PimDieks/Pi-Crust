// What the adapter reports after each `result` (phase 7, T8). Pure.
//   contextStatus(usage, track)  -> the object the app's context meter reads from the "crust-context" status (see
//                                   src/pi-extension/crust-context.ts and src/context-panel.js for the fields it uses)
//   pauseEvent(result, limits)   -> the pause record for a budget or turn-limit stop, or null
//   statusRecord(key, json, n)   -> the extension_ui_request setStatus record that carries a status
//   trackUsage(track, result)    -> folds a result into the per-chat totals (models used, cost)
// Cost is the SDK's own client-side estimate: the meter fields are named costUsd / costEstimate so the UI can say "about".
"use strict";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Category id from getContextUsage -> the meter's key. Anything used that is not known counts as "system" so no tokens vanish.
function categoryKey(c) {
	if (c.kind === "buffer") return "reserve";
	if (c.kind === "free") return null;
	const id = String(c.id || "");
	if (/message/.test(id)) return "messages";
	if (/tool/.test(id)) return "tools";
	if (/skill/.test(id)) return "skills";
	if (/memory/.test(id)) return "memory";
	return "system";
}

function newTrack() {
	return { models: new Map(), totalCostUsd: 0, turnCostUsd: 0 };
}

// result.modelUsage is cumulative for the query; model_usage_since_last_result is this turn's part.
function trackUsage(track, result) {
	if (!isObj(result)) return track;
	if (isObj(result.modelUsage)) {
		for (const [model, u] of Object.entries(result.modelUsage)) {
			if (!isObj(u)) continue;
			const prev = track.models.get(model) || { turns: 0 };
			track.models.set(model, { model, source: "chat", turns: prev.turns, input: num(u.inputTokens), output: num(u.outputTokens), cacheRead: num(u.cacheReadInputTokens), cacheWrite: num(u.cacheCreationInputTokens), cost: num(u.costUSD) });
		}
	}
	if (isObj(result.model_usage_since_last_result)) {
		for (const model of Object.keys(result.model_usage_since_last_result)) {
			const m = track.models.get(model);
			if (m) m.turns++;
		}
		track.turnCostUsd = Object.values(result.model_usage_since_last_result).reduce((s, u) => s + (isObj(u) ? num(u.costUSD) : 0), 0);
	} else track.turnCostUsd = 0;
	if (typeof result.total_cost_usd === "number") track.totalCostUsd = result.total_cost_usd;
	return track;
}

function contextStatus(usage, track = newTrack()) {
	if (!isObj(usage)) return null;
	const categories = { messages: 0, tools: 0, skills: 0, system: 0, memory: 0, reserve: 0 };
	for (const c of Array.isArray(usage.categories) ? usage.categories : []) {
		if (!isObj(c)) continue;
		const k = categoryKey(c);
		if (k) categories[k] += num(c.tokens);
	}
	return {
		window: num(usage.rawMaxTokens) || num(usage.maxTokens),
		total: typeof usage.totalTokens === "number" ? usage.totalTokens : null,
		percent: typeof usage.percentage === "number" ? usage.percentage : null,
		model: usage.model ? `anthropic/${usage.model}` : null,
		estimated: false,
		categories,
		deferred: 0,
		toolCount: Array.isArray(usage.mcpTools) ? usage.mcpTools.length : 0,
		deferredCount: 0,
		skillCount: 0,
		memoryFiles: (Array.isArray(usage.memoryFiles) ? usage.memoryFiles : []).filter((f) => isObj(f) && typeof f.path === "string").map((f) => ({ path: f.path, tokens: num(f.tokens) })),
		models: [...track.models.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
		// Beyond Pi's fields (the meter ignores them): the cost of the last turn and of the chat, an estimate by the SDK.
		costUsd: track.totalCostUsd,
		turnCostUsd: track.turnCostUsd,
		costEstimate: true,
	};
}

const PAUSE = {
	error_max_budget_usd: { reason: "budget", text: (r, l) => `Stopped: the spending limit${l.budgetUsd ? ` ($${Number(l.budgetUsd).toFixed(2)})` : ""} was reached. About $${num(r.total_cost_usd).toFixed(2)} spent.` },
	error_max_turns: { reason: "turns", text: (r, l) => `Stopped: the turn limit${l.maxTurns ? ` (${l.maxTurns})` : ""} was reached.` },
};

// limits: { budgetUsd, maxTurns }. canContinue: the chat can go on (resume with the session id, with a limit that leaves room).
function pauseEvent(result, limits = {}) {
	if (!isObj(result) || result.type !== "result") return null;
	const p = PAUSE[result.subtype];
	if (!p) return null;
	return {
		type: "claude_paused",
		reason: p.reason,
		message: p.text(result, limits),
		totalCostUsd: num(result.total_cost_usd),
		limitUsd: limits.budgetUsd || null,
		maxTurns: limits.maxTurns || null,
		sessionId: result.session_id || null,
		canContinue: !!result.session_id,
		continueLabel: "Continue",
	};
}

// The status key the app's context meter reads (src/context-panel.js). The Claude adapter feeds the same meter, so it sets the same key.
const CONTEXT_STATUS_KEY = "crust-context";
let n = 0;
function statusRecord(key, json) {
	return { type: "extension_ui_request", id: `claude-status-${++n}`, method: "setStatus", statusKey: key, statusText: typeof json === "string" ? json : JSON.stringify(json) };
}

module.exports = { CONTEXT_STATUS_KEY, contextStatus, pauseEvent, statusRecord, trackUsage, newTrack };
