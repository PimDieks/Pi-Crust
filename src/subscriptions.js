// Subscriptions section of the model popover (context-panel.js): which account Pi uses (Claude, Copilot, ChatGPT,
// Ollama). Status, sign-out and the Ollama models.json sync live in the main process (subscriptions-main.js).
// "Connect" runs Pi's own login in a helper process (subscriptions-main.js) and shows its steps inline in the row.
// A running RPC Pi reads auth.json / models.json once at start (get_available_models returns a snapshot), so after
// every change idle chats are restarted on their session and streaming ones follow when their turn ends.
"use strict";

(() => {
	const KEY = "crust.subscription"; // "all" or a provider id
	let rows = [];
	let defaultModel = null;
	let selected = localStorage.getItem(KEY) || "all";
	let flow = null; // the running sign-in: { id, label, state, draft } (state: see uiState in subscriptions-main.js)
	const stale = new Set(); // streaming chats that still run on the old credentials

	// The main process decides what counts as connected (an OAuth login, or an API key on rows that accept one).
	const isConnected = (row) => !!row && row.status === "connected";
	const rowById = (id) => rows.find((r) => r.id === id);
	const isOpen = () => typeof ctxOpen !== "undefined" && ctxOpen;
	const repaint = () => isOpen() && renderContextPanel();
	// Don't rebuild the popover under a focused control of it while a background poll finishes.
	const repaintQuiet = () => isOpen() && !$("#ctx-panel")?.contains(document.activeElement) && renderContextPanel();

	// Only the newest answer counts: an older, slower status call must not overwrite a newer one.
	let statusSeq = 0;
	async function refresh() {
		const mine = ++statusSeq;
		try {
			const r = await crust.subs.status();
			if (mine !== statusSeq) return rows;
			rows = r.rows || [];
			defaultModel = r.defaultModel || null;
		} catch (e) {
			console.error("subs:status failed", e);
		}
		// The stored choice stays through a transient failure: filterModels shows everything while it isn't connected.
		if (mine === statusSeq) repaintQuiet();
		return rows;
	}

	function setSelected(id) {
		selected = id;
		localStorage.setItem(KEY, id);
	}

	// The model list below shows only the selected subscription's provider.
	function filterModels(models) {
		return selected === "all" || !isConnected(rowById(selected)) ? models : models.filter((m) => m.provider === selected);
	}

	// Use the subscription: filter the list and, if the model is from elsewhere, switch to its first (preferably the default) model.
	async function select(id) {
		setSelected(id);
		repaint();
		if (id === "all") return;
		const cur = active?.state.model;
		if (cur?.provider === id) return;
		const mine = (active?.models || []).filter((m) => m.provider === id);
		const pick = (defaultModel?.provider === id && mine.find((m) => m.id === defaultModel.id)) || mine[0];
		if (!pick) return toast(`No ${rowById(id)?.label || id} models in this chat yet`, "warning");
		await switchModel(pick.provider, pick.id);
	}

	// --- reload Pi after a credentials / models change ---------------------------------------------------
	async function restartIdle(c) {
		const st = await rpcTo(c, "get_state");
		const file = st.data?.sessionFile;
		if (!st.success || !file || st.data.isStreaming || st.data.isCompacting || c.state.streaming) return false;
		if (c.state.streaming) return false; // a turn started while we were asking
		c.state.ready = false;
		const back = waitForPi(120_000, c); // registered before the restart; onStarted doesn't settle it
		back.catch(() => {});
		await crust.pi.restart(c.id, file);
		try {
			await back;
		} catch {
			return false;
		}
		await showCurrentSession(c);
		return true;
	}

	async function reloadChats() {
		let later = 0;
		for (const c of [...chats.values()]) {
			if (!c.state.ready) continue; // a starting Pi reads the new files anyway
			if (c.state.streaming) {
				stale.add(c);
				later++;
			} else if (!(await restartIdle(c))) {
				stale.add(c); // busy compacting or no session file: try again after its next turn
				later++;
			}
		}
		if (later) toast(`${later} chat${later === 1 ? " is" : "s are"} still working: ${later === 1 ? "it picks" : "they pick"} up the change after the current turn or on restart`, "info");
		await refresh();
		// Re-apply the choice: the active chat may now start on another provider.
		if (selected !== "all" && isConnected(rowById(selected))) await select(selected);
	}
	onCrust("turn:settled", async (c) => {
		if (!stale.has(c) || !chats.has(c.id)) return;
		stale.delete(c);
		if (!(await restartIdle(c)) && chats.has(c.id)) stale.add(c);
	});
	onCrust("chat:closed", (c) => stale.delete(c));

	// --- sign-in ----------------------------------------------------------------------------------------
	async function connect(row) {
		if (flow) return toast(`Finish or cancel the ${flow.label} sign-in first`, "warning");
		flow = { id: row.id, label: row.label, state: { kind: "starting" }, draft: "" };
		repaint();
		let r;
		try {
			r = await crust.subs.login(row.id);
		} catch (e) {
			r = { ok: false, error: e?.message || String(e) };
		} finally {
			flow = null;
		}
		if (r.cancelled) return repaint();
		if (!r.ok) {
			toast(`${row.label}: ${r.error}`, "error");
			return repaint();
		}
		toast(r.warning ? `Signed in to ${row.label} (${r.warning})` : `Signed in to ${row.label}`, r.warning ? "warning" : "success");
		setSelected(row.id); // reloadChats refreshes the status and then switches the model once
		await reloadChats();
	}

	crust.subs.onLoginState(({ provider, state }) => {
		if (!flow || flow.id !== provider) return;
		if (state.kind === "cancel-prompt") {
			if (flow.state.kind !== "prompt" || flow.state.id !== state.id) return;
			flow.state = { kind: "progress", message: "Signing in…" };
		} else {
			flow.state = state;
			if (state.kind === "opening" && state.url) flow.url = state.url;
			flow.draft = "";
			flow.focus = state.kind === "prompt";
		}
		// The code is already on the clipboard (main copies it); show the panel even if the popover was closed.
		if (!isOpen() && (state.kind === "device" || state.kind === "prompt")) openContextPanel();
		else repaint();
	});

	const submitPrompt = (value) => {
		const st = flow?.state;
		if (st?.kind !== "prompt") return;
		flow.state = { kind: "progress", message: "Signing in…" };
		crust.subs.loginAnswer(st.id, value);
		repaint();
	};
	const cancelLogin = () => crust.subs.loginCancel();

	// The row's second line while signing in.
	function flowDetail(st) {
		if (st.kind === "starting") return "Starting…";
		if (st.kind === "opening") return "Opening browser…";
		if (st.kind === "device") return "Enter the code on the page";
		if (st.kind === "prompt") return st.type === "manual_code" ? "Waiting for the browser…" : "Waiting for you…";
		return st.message || "Signing in…";
	}

	const link = (url, label) => {
		const a = el("a", "subs-link", label);
		a.href = url;
		a.target = "_blank";
		a.rel = "noreferrer";
		return a;
	};

	// The inline panel under the row: device code, a field for a pasted code, or a short note.
	function flowPanel() {
		const st = flow.state;
		const box = el("div", "subs-login");
		if (st.kind === "device") {
			const code = el("div", "subs-code", st.code);
			const copy = el("button", "subs-act", "Copy");
			copy.type = "button";
			copy.onclick = async () => {
				await crust.clipboard.write(st.code);
				toast("Code copied", "success");
			};
			const line = el("div", "subs-code-row");
			line.append(code, copy);
			const note = el("div", "subs-note", "Copied to the clipboard. Enter it on ");
			note.append(st.uri ? link(st.uri, st.uri.replace(/^https?:\/\//, "")) : "the sign-in page");
			box.append(line, note);
		} else if (st.kind === "opening") {
			const note = el("div", "subs-note", st.instructions || "Finish signing in in your browser. ");
			if (st.url) note.append(link(st.url, "Open the page again"));
			box.append(note);
		} else if (st.kind === "info") {
			const note = el("div", "subs-note", st.message);
			for (const l of st.links) note.append(" ", link(l.url, l.label));
			box.append(note);
		} else if (st.kind === "prompt") {
			const note = el("div", "subs-note", st.message);
			if (st.type === "manual_code" && flow.url) note.append(" ", link(flow.url, "Open the page again"));
			box.append(note);
			if (st.type === "select") {
				const sel = el("select", "subs-input");
				for (const o of st.options) sel.append(Object.assign(el("option", "", o.label), { value: o.id }));
				sel.setAttribute("aria-label", st.message);
				box.append(sel);
				box.append(promptButtons(() => submitPrompt(sel.value)));
				if (flow.focus) setTimeout(() => sel.focus(), 0);
			} else {
				const input = el("input", "subs-input");
				input.type = st.type === "secret" ? "password" : "text";
				input.placeholder = st.placeholder || (st.type === "manual_code" ? "Paste the redirect URL or code" : "");
				input.setAttribute("aria-label", st.message);
				input.value = flow.draft;
				input.oninput = () => (flow.draft = input.value);
				input.onkeydown = (e) => {
					if (e.key === "Enter" && input.value.trim()) submitPrompt(input.value.trim());
				};
				box.append(input, promptButtons(() => input.value.trim() && submitPrompt(input.value.trim())));
				if (flow.focus) setTimeout(() => input.focus(), 0);
			}
			flow.focus = false;
			return box;
		} else return null;
		return box;
	}

	function promptButtons(onSubmit) {
		const bar = el("div", "subs-prompt-actions");
		const ok = el("button", "subs-act", "Submit");
		ok.type = "button";
		ok.onclick = onSubmit;
		const no = el("button", "subs-act", "Cancel");
		no.type = "button";
		no.onclick = cancelLogin;
		bar.append(ok, no);
		return bar;
	}

	async function signOut(row) {
		const ok = await showDialog({ method: "confirm", title: `Sign out of ${row.label}?`, message: "Removes the stored login from Pi's auth.json. You can sign in again with Connect.", yesLabel: "Sign out" });
		if (!ok.confirmed) return;
		const r = await crust.subs.logout(row.id);
		if (!r.ok) return toast(r.error, "error");
		toast(`Signed out of ${row.label}`);
		if (selected === row.id) setSelected("all");
		await reloadChats();
	}

	// A stored API key instead of a login: Pi's logout removes the stored credential of any type.
	async function removeKey(row) {
		const ok = await showDialog({ method: "confirm", title: `Remove the ${row.label} API key?`, message: "Removes the key from Pi's auth.json. The key itself stays valid at Anthropic. You can add it again later.", yesLabel: "Remove key" });
		if (!ok.confirmed) return;
		const r = await crust.subs.logout(row.id);
		if (!r.ok) return toast(r.error, "error");
		toast(`Removed the ${row.label} API key`);
		if (selected === row.id) setSelected("all");
		await reloadChats();
	}

	async function ollama(call, done) {
		const r = await call();
		if (!r.ok) return toast(r.error, "error");
		toast(done(r));
		await reloadChats();
	}
	const syncOllama = () => ollama(crust.subs.ollamaSync, (r) => `Ollama: ${r.models} model${r.models === 1 ? "" : "s"} added to Pi`);
	const removeOllama = async () => {
		if (selected === "ollama") setSelected("all");
		await ollama(crust.subs.ollamaRemove, () => "Ollama removed from Pi");
	};

	// The row's buttons: [label, handler, title].
	function actions(row) {
		if (flow?.id === row.id) return flow.state.kind === "prompt" ? [] : [["Cancel", cancelLogin, "Stop signing in"]];
		if (row.kind === "oauth") {
			if (isConnected(row) && row.authType === "api_key") return [["Remove key", () => removeKey(row), "Remove the stored API key from Pi"]];
			if (isConnected(row) && row.authType === "env") return []; // an environment variable can't be removed from here
			if (isConnected(row)) return [["Sign out", () => signOut(row), "Remove the stored login"]];
			if (row.status === "disconnected") return [["Connect", () => connect(row), row.authType === "api_key" ? "Sign in with the subscription instead of the API key" : "Sign in with your browser"]];
			return [];
		}
		if (row.status === "unavailable") return [];
		const out = [[row.status !== "connected" ? "Sync models" : row.outOfSync ? "Sync (out of date)" : "Sync", syncOllama, "Add the installed Ollama models to Pi's models.json"]];
		if (row.status === "connected") out.push(["Remove", removeOllama, "Remove Ollama from Pi's models.json"]);
		return out;
	}

	function subRow(row) {
		const on = selected === row.id;
		const wrap = el("div", `subs-row${on ? " selected" : ""}`);
		const pick = el("button", "subs-pick");
		pick.type = "button";
		pick.setAttribute("aria-pressed", String(on));
		const connected = isConnected(row);
		pick.disabled = !connected;
		const dot = el("span", `subs-dot ${flow?.id === row.id ? "waiting" : row.status}`);
		const detail = flow?.id === row.id ? flowDetail(flow.state) : row.detail;
		pick.title = connected ? `Use ${row.label}: only its models are listed below` : detail;
		const text = el("span", "subs-text");
		text.append(el("span", "ctx-label", row.label), el("span", "subs-detail", detail));
		pick.append(dot, text, el("span", "check", on ? "✓" : ""));
		pick.onclick = () => select(row.id);
		wrap.append(pick);
		pick.disabled = pick.disabled || flow?.id === row.id;
		for (const [label, fn, title] of actions(row)) {
			const b = el("button", "subs-act", label);
			b.type = "button";
			b.title = title;
			b.onclick = (e) => {
				e.stopPropagation();
				fn();
			};
			wrap.append(b);
		}
		const panel = flow?.id === row.id ? flowPanel() : null;
		if (!panel) return wrap;
		const item = el("div", "subs-item");
		item.append(wrap, panel);
		return item;
	}

	// Elements for the top of the popover.
	function parts() {
		const head = el("div", "ctx-head");
		head.append(el("span", "ctx-title", "Subscriptions"));
		const out = [head];
		if (!rows.length) return [...out, el("div", "ctx-empty", "Checking…")];
		const list = el("div", "subs-list");
		list.setAttribute("role", "group");
		list.setAttribute("aria-label", "Subscriptions");
		const all = el("div", `subs-row${selected === "all" ? " selected" : ""}`);
		const allPick = el("button", "subs-pick");
		allPick.type = "button";
		allPick.setAttribute("aria-pressed", String(selected === "all"));
		const t = el("span", "subs-text");
		t.append(el("span", "ctx-label", "All"), el("span", "subs-detail", "Every model Pi can use"));
		allPick.append(el("span", "subs-dot none"), t, el("span", "check", selected === "all" ? "✓" : ""));
		allPick.onclick = () => select("all");
		all.append(allPick);
		list.append(all, ...rows.map(subRow));
		return [...out, list];
	}

	window.crustSubs = { parts, filterModels, refresh, rows: () => rows, selected: () => selected, select };

	selftestSteps.push(async ({ snap, wait }) => {
		await refresh();
		openContextPanel();
		await wait(300);
		const shown = $("#ctx-panel")?.querySelectorAll(".subs-row").length || 0;
		await snap("subscriptions");
		closeContextPanel();
		console.error(`SELFTEST subscriptions: ${rows.map((r) => `${r.id}=${r.status} (${r.detail})`).join(", ")}; selected=${selected}; rows shown=${shown} -> ${shown === rows.length + 1 && rows.length ? "OK" : "MISMATCH"}`);
	});
})();
