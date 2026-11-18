// Pi's built-in TUI slash commands. RPC mode doesn't handle them (the text would go to the model), so Crust
// maps them onto the matching RPC commands. Anything not listed here still goes to Pi as a normal prompt.
"use strict";

const TERMINAL_ONLY = {
	settings: "Open settings",
	"scoped-models": "Configure the models used by interactive cycling",
	login: "Add provider authentication",
	logout: "Remove provider authentication",
	llama: "Manage models on the configured llama.cpp router",
	tree: "Navigate the session tree",
	import: "Import and resume a JSONL session",
	share: "Upload the session and return a viewer link",
	bug: "Prepare a private bug report for the Pi developers",
	trust: "Save a project trust decision",
	hotkeys: "Show active keyboard shortcuts",
	changelog: "Show changelog entries",
};

// A toast with a button that opens the Terminal tab.
function terminalOnly(name) {
	const t = el("div", "toast warning", `/${name} is only available in terminal Pi. `);
	const b = el("button", "", "Open Terminal");
	b.type = "button";
	b.onclick = () => {
		t.remove();
		switchTab("terminal");
	};
	t.append(b);
	$("#toasts").append(t);
	setTimeout(() => t.remove(), 9000);
}

async function confirmStopIfWorking(what) {
	if (!state.streaming) return true;
	const ok = await showDialog({ method: "confirm", title: "Pi is still working", message: `Stop the current run and ${what}?`, yesLabel: "Stop and continue" });
	if (!ok.confirmed) return false;
	await stop();
	return true;
}

async function reloadPi() {
	const st = await rpc("get_state");
	const file = st.success ? st.data?.sessionFile : undefined;
	if (!file) return toast("No session file to reload", "error");
	if (st.data.isCompacting) return toast("Pi is compacting; try again in a moment", "warning");
	if (!(await confirmStopIfWorking("reload Pi"))) return;
	const c = view;
	c.state.ready = false;
	const back = waitForPi(120_000, c); // registered before the restart; onStarted doesn't settle it
	back.catch(() => {});
	await crust.pi.restart(c.id, file);
	try {
		await back;
	} catch {
		return; // the exit box already informs the user
	}
	await showCurrentSession(c);
	withChat(c, () => addNotice("Reloaded"));
}

async function pickModel(arg) {
	if (!arg) return openContextPanel({ focusModels: true });
	const i = arg.indexOf("/");
	if (i < 1) return toast("Use /model provider/model", "warning");
	const res = await rpc("set_model", { provider: arg.slice(0, i), modelId: arg.slice(i + 1) });
	if (!res.success) return toast(res.error || "Couldn't switch model", "error");
	toast(`Model: ${res.data?.name || res.data?.id}`);
	await loadModels();
}

async function pickThinking(arg) {
	let level = arg;
	const r = await rpc("get_available_thinking_levels");
	if (!r.success) return toast(r.error || "Couldn't read thinking levels", "error");
	const levels = r.data?.levels || [];
	if (!level) {
		const res = await showDialog({ method: "select", title: "Thinking level", options: levels });
		if (!res.value) return;
		level = res.value;
	} else if (!levels.includes(level)) {
		return toast(`Unknown thinking level "${level}". Valid: ${levels.join(", ")}`, "error");
	}
	const res = await rpc("set_thinking_level", { level });
	if (!res.success) return toast(res.error || "Couldn't set thinking level", "error");
	toast(`Thinking: ${level}`);
	window.refreshThinking?.();
}

async function nameSession(arg) {
	if (!arg) {
		const st = await rpc("get_state");
		return addNotice(st.data?.sessionName ? `Session name: ${st.data.sessionName}` : "This session has no name yet. Use /name <name>.");
	}
	const res = await rpc("set_session_name", { name: arg });
	if (!res.success) return toast(res.error || "Couldn't set the name", "error");
	addNotice(`Session name: ${arg}`);
}

async function sessionInfo() {
	const res = await rpc("get_session_stats");
	if (!res.success) return toast(res.error || "Couldn't read session stats", "error");
	const d = res.data || {};
	const n = (v) => (typeof v === "number" ? v.toLocaleString() : v);
	const lines = [];
	if (d.sessionFile) lines.push(`File: ${d.sessionFile}`);
	if (d.sessionId) lines.push(`ID: ${d.sessionId}`);
	lines.push(`Messages: ${n(d.totalMessages)} (${n(d.userMessages)} user, ${n(d.assistantMessages)} assistant)`);
	lines.push(`Tool calls: ${n(d.toolCalls)}, results: ${n(d.toolResults)}`);
	if (d.tokens) lines.push(`Tokens: ${n(d.tokens.total)} (input ${n(d.tokens.input)}, output ${n(d.tokens.output)}, cache read ${n(d.tokens.cacheRead)}, cache write ${n(d.tokens.cacheWrite)})`);
	if (typeof d.cost === "number") lines.push(`Cost: $${d.cost.toFixed(4)}`);
	if (d.contextUsage) {
		const c = d.contextUsage;
		const used = c.tokens == null || c.percent == null ? "" : `${n(c.tokens)} / `;
		const pct = c.tokens == null || c.percent == null ? "" : ` (${Math.round(c.percent)}%)`;
		lines.push(`Context: ${used}${n(c.contextWindow)} tokens${pct}`);
	}
	addNotice(lines.join("\n"));
	messages.lastElementChild.style.whiteSpace = "pre-wrap";
}

// Forks and clones get their own copies of the checkpoints, so rewinding keeps working there.
async function sessionFileNow(c) {
	if (c.sessionFile) return c.sessionFile;
	const st = await rpcTo(c, "get_state");
	return st.success ? st.data?.sessionFile || null : null;
}
async function copyCheckpoints(c, oldFile) {
	const newFile = await sessionFileNow(c);
	if (oldFile && newFile && oldFile !== newFile) await crust.checkpoints.copy(oldFile, newFile, undefined, c.id).catch(() => {});
}

async function forkChat() {
	const r = await rpc("get_fork_messages");
	if (!r.success) return toast(r.error || "Couldn't read the messages", "error");
	const list = r.data?.messages || [];
	if (!list.length) return toast("Nothing to fork from yet", "warning");
	const label = (m, i) => `${i + 1}. ${(m.text || "").replace(/\s+/g, " ").slice(0, 100)}`;
	const res = await showDialog({ method: "select", title: "Fork from which message?", options: list.map(label) });
	if (!res.value) return;
	const picked = list.find((m, i) => label(m, i) === res.value);
	if (!picked) return;
	if (!(await confirmStopIfWorking("fork"))) return;
	const c = view;
	const oldFile = await sessionFileNow(c);
	const f = await rpc("fork", { entryId: picked.entryId });
	if (!f.success) return toast(f.error || "Fork failed", "error");
	if (f.data?.cancelled) return toast("Fork cancelled by an extension", "warning");
	c.sessionFile = null; // showCurrentSession reads the new one
	await showCurrentSession(c);
	await copyCheckpoints(c, oldFile);
	addNotice("Forked");
	if (f.data?.text) {
		$("#input").value = f.data.text;
		$("#input").focus();
	}
}

async function cloneChat() {
	if (!(await confirmStopIfWorking("clone"))) return;
	const c = view;
	const oldFile = await sessionFileNow(c);
	const res = await rpc("clone");
	if (!res.success) return toast(res.error || "Clone failed", "error");
	if (res.data?.cancelled) return toast("Clone cancelled by an extension", "warning");
	c.sessionFile = null;
	await showCurrentSession(c);
	await copyCheckpoints(c, oldFile);
	addNotice("Cloned");
}

async function exportChat(arg) {
	if (/\.jsonl$/i.test(arg || "")) return toast("JSONL export is only available in terminal Pi", "warning");
	const res = await rpc("export_html", arg ? { outputPath: arg } : {});
	if (!res.success) return toast(res.error || "Export failed", "error");
	toast(`Exported to ${res.data?.path}`);
}

async function copyLast() {
	const res = await rpc("get_last_assistant_text");
	if (!res.success) return toast(res.error || "Couldn't read the last answer", "error");
	if (!res.data?.text) return toast("No assistant message to copy yet", "warning");
	try {
		await crust.clipboard.write(res.data.text);
		toast("Copied the last answer");
	} catch (e) {
		toast(`Couldn't copy: ${e.message}`, "error");
	}
}

const BUILTIN_COMMANDS = [
	{ name: "reload", description: "Restart Pi (keeps this chat) to reload extensions, skills and templates", run: reloadPi },
	{ name: "new", description: "Open a new chat in a new tab", run: () => newChat() },
	{ name: "resume", description: "Open a saved session in a tab", run: () => openHistory() },
	{
		name: "compact",
		args: "[instructions]",
		description: "Compact the current context",
		run: async (arg) => {
			const r = await rpc("compact", arg ? { customInstructions: arg } : {});
			if (!r.success) toast(r.error || "Compaction failed", "error");
		},
	},
	{ name: "model", args: "[provider/model]", description: "Select a model", run: pickModel },
	{ name: "thinking", args: "[level]", description: "Set the thinking level", run: pickThinking },
	{ name: "name", args: "[name]", description: "Set the session name, or show it", run: nameSession },
	{ name: "session", description: "Show session information and statistics", run: sessionInfo },
	{ name: "fork", description: "New session from an earlier user message", run: forkChat },
	{ name: "rewind", description: "Rewind files and/or the conversation to before an earlier message", run: () => window.rewindPick?.() },
	{ name: "clone", description: "Duplicate the session at its current position", run: cloneChat },
	{ name: "export", args: "[path]", description: "Export the session as HTML", run: exportChat },
	{ name: "copy", description: "Copy the last assistant message", run: copyLast },
	{ name: "setup", description: "Open the setup checklist (Pi, AI account, Git, project)", always: true, run: () => openSetup("slash", view?.id) },
	{ name: "remote", description: "Control your chats from your phone (Remote access)", run: () => window.crustRemote?.open() },
	{ name: "quit", description: "Close Pi Crust", run: () => window.close() },
	...Object.entries(TERMINAL_ONLY).map(([name, description]) => ({ name, description: `${description} (terminal Pi only)`, run: () => terminalOnly(name) })),
];

// Extension commands, prompt templates and skills defined by Pi win over a built-in of the same name.
function isShadowed(name) {
	return commandList.some((c) => c.name === name);
}

// Built-ins plus machine-local ones: src/local/*.js push { name, description, paletteLabel?, run } onto this registry.
window.crustLocalCommands ||= [];
const allBuiltinCommands = () => [...BUILTIN_COMMANDS, ...window.crustLocalCommands];

// Returns true when `text` was a built-in command and has been handled here.
// Commands that need no running Pi (/setup).
const isAlwaysCommand = (text) => {
	const m = /^\/(\S+)/.exec(text.trim());
	return !!m && allBuiltinCommands().some((c) => c.always && c.name === m[1]);
};

async function handleBuiltinCommand(text) {
	const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!m) return false;
	const cmd = allBuiltinCommands().find((c) => c.name === m[1]);
	if (!cmd) return false;
	if (cmd.always) {
		// works without Pi: it is the way to get one
		try {
			await cmd.run((m[2] || "").trim());
		} catch (e) {
			toast(`/${cmd.name} failed: ${e.message}`, "error");
		}
		return true;
	}
	if (!state.ready) {
		notReadyToast();
		return true;
	}
	const r = await rpc("get_commands");
	if (r.success) commandList = r.data?.commands || [];
	if (isShadowed(cmd.name)) return false;
	try {
		await cmd.run((m[2] || "").trim());
	} catch (e) {
		toast(`/${cmd.name} failed: ${e.message}`, "error");
	}
	return true;
}
