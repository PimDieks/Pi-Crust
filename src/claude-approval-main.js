// The approval prompt of Claude Agent chats (main process). The adapter's permission gate (agents/claude/permissions.js) calls sink.ask(handle, prompt, meta)
// for every "ask"; this module shows it through the SAME records a Pi chat's permission extension uses: an extension_ui_request (method "select",
// the gate's own title and options: Allow once, Allow for this chat, Deny; no Cancel) goes to the renderer, which draws the one approval prompt
// (key guard, risky prompts open on Deny), and its extension_ui_response comes back through answerUi() below.
// Anything but a clear answer is a deny (the promise resolves undefined, which the gate reads as no): a closed or replaced chat, an aborted call,
// a window that is gone, Cancel. There is no timeout: a Pi chat's prompt has none either (its extension asks without one and the renderer only
// times out a request that carries a timeout). The prompt text is scrubbed of the API key by the adapter before it gets here.
"use strict";

// deps: { send(channel, payload), hasWindow(): boolean, isCurrent(chatId, handle): boolean, timeoutMs? (tests only) }
function createApprovals(deps) {
	const pending = new Map(); // id -> { chatId, handle, settle }
	let seq = 0;
	const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : 0;

	// Resolves the chosen option text, or undefined (= deny). Never rejects.
	function ask(chatId, handle, prompt, meta) {
		return new Promise((resolve) => {
			try {
				if (!prompt || typeof prompt.title !== "string" || !Array.isArray(prompt.options)) return resolve(undefined);
				const signal = meta && meta.signal;
				if ((signal && signal.aborted) || !deps.hasWindow() || !deps.isCurrent(chatId, handle)) return resolve(undefined);
				const id = `crust-ask-${++seq}`;
				let timer = null;
				let onAbort = null;
				const settle = (value, by) => {
					if (!pending.has(id)) return;
					pending.delete(id);
					clearTimeout(timer);
					if (signal && onAbort) signal.removeEventListener("abort", onAbort);
					if (by) deps.send("pi:uiResolved", { chatId, id, by }); // the renderer closes its prompt
					resolve(value);
				};
				pending.set(id, { chatId, handle, settle });
				if (timeoutMs) {
					timer = setTimeout(() => settle(undefined, "timeout"), timeoutMs);
					if (timer.unref) timer.unref();
				}
				if (signal) {
					onAbort = () => settle(undefined, "cancelled");
					signal.addEventListener("abort", onAbort, { once: true });
				}
				deps.send("pi:record", { chatId, record: { type: "extension_ui_request", id, method: "select", title: prompt.title, options: prompt.options.slice() } });
			} catch {
				resolve(undefined);
			}
		});
	}

	// The answer to one of ours. True when it was one (and has been used); false lets the caller treat it as Pi's.
	function answer(chatId, response) {
		const p = response && typeof response.id === "string" ? pending.get(response.id) : null;
		if (!p || p.chatId !== chatId) return false;
		p.settle(typeof response.value === "string" && !response.cancelled ? response.value : undefined, null);
		return true;
	}
	const owns = (response) => !!(response && typeof response.id === "string" && pending.has(response.id));

	// The chat is closed, replaced or stopped: its open prompts end as a deny and leave the screen.
	// With a handle, only that process's prompts (an old process ending must not close the prompts of its replacement).
	function closeChat(chatId, handle) {
		for (const p of [...pending.values()]) if (p.chatId === chatId && (handle === undefined || p.handle === handle)) p.settle(undefined, "closed");
	}
	function closeAll() {
		for (const p of [...pending.values()]) p.settle(undefined, "closed");
	}
	return { ask, answer, owns, closeChat, closeAll, size: () => pending.size };
}

module.exports = { createApprovals };
