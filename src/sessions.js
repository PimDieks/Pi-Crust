// Earlier chats: list Pi's saved sessions for this repo, switch to one and replay its messages.
"use strict";

function timeAgo(ms) {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
	return new Date(ms).toLocaleDateString();
}

async function openHistory() {
	const list = await crust.sessions.list();
	// Session files that are already open in a tab.
	const open = new Set();
	await Promise.all(
		[...chats.values()].map(async (c) => {
			if (c.sessionFile) open.add(c.sessionFile);
			if (c.state.ready) {
				const st = await rpcTo(c, "get_state");
				if (st.data?.sessionFile) open.add(st.data.sessionFile);
			}
		}),
	);
	const res = await showDialog({
		method: "custom",
		title: "Earlier chats",
		render(modal, finish) {
			const filter = el("input");
			filter.placeholder = "Filter…";
			const box = el("div", "history-list");
			const draw = () => {
				const q = filter.value.toLowerCase();
				const shown = list.filter((s) => !q || (s.name || "").toLowerCase().includes(q) || (s.firstPrompt || "").toLowerCase().includes(q));
				box.replaceChildren(
					...shown.map((s) => {
						const isOpen = open.has(s.path);
						const b = el("button", `history-item${isOpen ? " current" : ""}`);
						b.type = "button";
						b.append(el("span", "h-title", s.name || s.firstPrompt), el("span", "h-meta", `${timeAgo(s.mtime)} · ${(s.size / 1024).toFixed(0)} KB${s.cwd ? ` · worktree ${s.branch || ""}` : ""}${isOpen ? " · open in a tab" : ""}`));
						b.onclick = () => finish({ value: s.path });
						return b;
					}),
				);
				if (!shown.length) box.append(el("div", "muted", list.length ? "No match." : "No saved chats for this repo yet."));
			};
			filter.oninput = draw;
			filter.onkeydown = (e) => {
				if (e.key === "Enter") box.querySelector(".history-item")?.click();
			};
			draw();
			modal.append(filter, el("div", "", " "), box);
			setTimeout(() => filter.focus());
		},
	});
	if (!res.value) return;
	const s = list.find((x) => x.path === res.value);
	// Opens in its own tab (or focuses the tab that has it); the current chat keeps its session.
	await openSessionInTab(res.value, s?.name || s?.firstPrompt || "", s?.cwd ? { cwd: s.cwd, branch: s.branch } : {});
}

// Redraw a chat from Pi's current session (after a fork, clone or reload, or when resuming a saved one).
async function showCurrentSession(c = view) {
	withChat(c, () => {
		setWorking(false);
		c.turn = null;
		clearChat();
	});
	const msgs = await rpcTo(c, "get_messages");
	if (!chats.has(c.id)) return;
	withChat(c, () => renderHistory(msgs.data?.messages || []));
	if (!c.name && !c.label) {
		const first = (msgs.data?.messages || []).find((m) => m.role === "user");
		c.label = first ? textOf(first.content).replace(/\s+/g, " ").trim() : "";
		renderTabs();
	}
	await loadModels(c);
}

// Replay stored messages with the same components as live streaming.
function renderHistory(list) {
	const spans = Duration.turnSpans(list);
	list.forEach((m, i) => {
		if (m.role === "user") {
			renderUser(m, true);
		} else if (m.role === "assistant") {
			startAssistant();
			(m.content || []).forEach((c, i) => {
				if (c.type === "text") {
					const b = block(i, "text");
					b.raw = c.text;
					b.dirty = true;
					b.final = true;
				} else if (c.type === "thinking") {
					const b = block(i, "thinking");
					b.raw = c.thinking || "";
					b.dirty = true;
				} else if (c.type === "toolCall") {
					toolCard(c.id, c.name, c.arguments);
				}
			});
			flushRender();
			if (m.stopReason === "error" && m.errorMessage) addNotice(m.errorMessage, "error");
		} else if (m.role === "toolResult") {
			const t = tools.get(m.toolCallId) || toolCard(m.toolCallId, m.toolName, {});
			t.d.classList.remove("running");
			t.d.classList.add(m.isError ? "err" : "ok");
			updateToolGroup(t.d);
			t.meta.textContent = m.toolName === "subagent" && m.details?.results ? renderSubagents(t, m.details, true) : setToolOutput(t, m, m.isError);
			t.clock.textContent = m.durationMs >= 100 ? Duration.formatDuration(m.durationMs, { precise: true }) : "";
			if (m.durationMs != null) t.clock.title = `Took ${Duration.formatDuration(m.durationMs, { precise: true })}`;
			if ((m.toolName === "edit" || m.toolName === "write") && t.argEl.title) touched.add(relPath(t.argEl.title));
			emitCrust("tool:end", view, { toolName: m.toolName, toolCallId: m.toolCallId, args: t.args || {}, result: m, isError: !!m.isError, history: true });
		} else if (m.role === "custom" && m.display !== false) {
			const text = textOf(m.content);
			if (text) addNotice(text);
		} else if (m.role === "compactionSummary") {
			addNotice("Earlier messages were compacted into a summary.");
		}
		const s = spans.get(i);
		if (s && (s.ms >= 1000 || s.tools)) messages.append(el("div", "turn-stats", Duration.turnSummary(s)));
	});
	current = null;
	atBottom = true;
	scroll();
}

function initSessions() {
	$("#history").addEventListener("click", openHistory);
}
