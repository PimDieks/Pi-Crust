// Runaway guard decisions (used by pi-extension/crust-guard.ts). Pure: no Pi, no UI.
// One guard per Pi process. Call start() on every new run, then check(name, args) for each tool call.
"use strict";

const REPEAT_LIMIT = 5;

// JSON with object keys sorted, so {a:1,b:2} and {b:2,a:1} give the same string.
function stableStringify(v) {
	if (v === undefined) return "undefined";
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
	return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function parseThreshold(raw, fallback = 40) {
	if (raw === undefined || raw === null || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function createGuard(threshold) {
	let count, nextCheck, stopped, lastKey, streak;
	const reset = () => {
		count = 0;
		nextCheck = threshold;
		stopped = false;
		lastKey = null;
		streak = 0;
	};
	reset();
	const stopReason = () => `The user stopped this run after ${count} tool calls. Stop calling tools; summarise what you did and what is left.`;
	return {
		start: reset,
		// Returns { action: "allow" } | { action: "block", reason } | { action: "ask", count, resolve(continue) }.
		// "ask": the caller asks the user and then calls resolve(true|false), which returns allow or block.
		check(name, args) {
			if (stopped) return { action: "block", reason: stopReason() };
			count++;
			const key = name + "\u0000" + stableStringify(args);
			streak = key === lastKey ? streak + 1 : 1;
			lastKey = key;
			if (streak >= REPEAT_LIMIT) {
				return { action: "block", reason: `You called ${name} with the same arguments ${REPEAT_LIMIT} times in a row. Change your approach or stop and tell the user what is blocking you.` };
			}
			if (threshold > 0 && count >= nextCheck) {
				const at = count;
				return {
					action: "ask",
					count: at,
					resolve(keepGoing) {
						if (keepGoing) {
							nextCheck = at + threshold;
							return { action: "allow" };
						}
						stopped = true;
						return { action: "block", reason: stopReason() };
					},
				};
			}
			return { action: "allow" };
		},
	};
}

module.exports = { createGuard, stableStringify, parseThreshold, REPEAT_LIMIT };
