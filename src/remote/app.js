"use strict";
// Pi Crust Remote: the phone UI. Talks to remote-server.js (REST + one SSE stream).
// Strict CSP (no inline script/style): all DOM is built with createElement/textContent;
// the only innerHTML is DOMPurify-sanitized markdown.
(() => {
	const $ = (s) => document.querySelector(s);
	const el = (tag, cls, text) => {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	};

	// --- state -------------------------------------------------------------------------
	let appState = null; // GET /api/state
	const chats = new Map(); // id -> Summary
	let stream = null; // AbortController of the open event stream
	let retryHint = 0; // server's `retry:` in ms, a floor for the reconnect wait
	let clockOffset = 0; // server time minus our time, to turn the server's expiresAt into our clock
	let backoffStep = 0;
	let reconnectTimer = null;
	let connecting = false;
	let screen = "";
	const settings = new Map(); // chatId -> { model, models, thinkingLevel, thinkingLevels } (GET /settings)
	const drafts = new Map(); // chatId -> unsent composer text, kept per tab like the desktop does

	const view = {
		id: null,
		seq: 0, // guards stale openChat responses
		loading: false,
		buffer: [], // record events that arrive while the history loads: { seq, record }
		lastSeq: 0,
		streaming: false,
		asks: [], // pending ui requests
		queue: { steering: [], followUp: [] }, // Pi's queue (queue_update records)
		held: [], // messages paused by Stop (shared with the desktop)
		heldLive: false, // a held event arrived while the history loaded: it is newer than the response
		cur: null, // current assistant message { blocks: Map }
		tools: new Map(),
		workEl: null,
		dirty: new Set(),
		raf: 0,
		atBottom: true,
	};

	// --- helpers -------------------------------------------------------------------------
	const BACKOFF = [1000, 2000, 5000, 10000];
	const STATUS_LABEL = { working: "Working", waiting: "Waiting for you", idle: "Idle", done: "Done", stopped: "Stopped", starting: "Starting" };
	const DOT = { working: "✻", waiting: "?", done: "●", idle: "○", stopped: "!", starting: "…" };
	const TAB_STATE = { working: "✻", waiting: "?", done: "●", stopped: "!" }; // desktop renderTabs: nothing when idle
	const MODE_IDS = ["plan", "ask-edits", "ask-commands", "trusted"];

	// "41s", "5m 41s", "1h 05m" (the desktop's tab clock).
	function fmtDur(ms) {
		const s = Math.max(0, Math.floor(ms / 1000));
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
		return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	}
	// The server's `since` is on its clock: clockOffset moves it onto ours.
	const elapsed = (since) => Date.now() + clockOffset - since;

	function readJsonKey(key) {
		try {
			return JSON.parse(localStorage.getItem(key) || "null");
		} catch {
			return null;
		}
	}
	function writeKey(key, value) {
		try {
			if (value == null) localStorage.removeItem(key);
			else localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
		} catch {}
	}
	// Tabs closed on this phone (× only hides them here: the chat keeps running on the desktop). New activity brings one back.
	const hiddenTabs = () => readJsonKey("crust.hiddenTabs") || {};
	function setHidden(id, on) {
		const h = hiddenTabs();
		if (on) h[id] = Date.now() + clockOffset; // on the server's clock, like updatedAt
		else delete h[id];
		for (const k of Object.keys(h)) if (!chats.has(k) && k !== id) delete h[k];
		writeKey("crust.hiddenTabs", h);
	}
	const isHidden = (c) => {
		const at = hiddenTabs()[c.id];
		return !!at && !(c.updatedAt > at) && c.status !== "waiting";
	};
	const chatNum = (id) => Number(String(id).replace(/^chat-/, "")) || 0;
	// Desktop order: oldest tab left, newest right (chat ids count up).
	const tabList = () => [...chats.values()].filter((c) => c.id === view.id || !isHidden(c)).sort((a, b) => chatNum(a.id) - chatNum(b.id));

	function toast(msg, kind) {
		const t = el("div", `toast${kind ? ` ${kind}` : ""}`, msg);
		$("#toasts").append(t);
		setTimeout(() => t.remove(), kind === "error" ? 6000 : 3500);
	}

	function lastViewed() {
		try {
			return JSON.parse(localStorage.getItem("crust.lastViewed") || "{}") || {};
		} catch {
			return {};
		}
	}
	function markViewed(id, at) {
		try {
			const lv = lastViewed();
			lv[id] = at || Date.now();
			const keys = Object.keys(lv);
			if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete lv[k];
			localStorage.setItem("crust.lastViewed", JSON.stringify(lv));
		} catch {}
	}
	function displayStatus(c) {
		if (c.status === "idle" && c.lastText && c.updatedAt > (lastViewed()[c.id] || 0)) return "done";
		return c.status;
	}

	function baseName(p) {
		return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
	}
	function textOf(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
	}

	function md(text) {
		if (typeof marked === "undefined" || typeof DOMPurify === "undefined") return null;
		try {
			const html = DOMPurify.sanitize(marked.parse(String(text || "")), { USE_PROFILES: { html: true } });
			return html;
		} catch {
			return null;
		}
	}
	function setMd(node, text) {
		const html = md(text);
		if (html == null) {
			node.textContent = text;
			node.style.whiteSpace = "pre-wrap";
			return;
		}
		node.innerHTML = html; // sanitized by DOMPurify
		for (const a of node.querySelectorAll("a")) {
			a.target = "_blank";
			a.rel = "noopener noreferrer";
		}
	}

	function toolSummary(name, args) {
		args = args && typeof args === "object" ? args : {};
		if (name === "bash") return args.command || "";
		if (["read", "edit", "write", "ls", "find", "grep"].includes(name)) return args.path || args.pattern || "";
		if (args.path) return args.path;
		if (args.command) return args.command;
		if (args.pattern) return args.pattern;
		if (args.url) return args.url;
		if (name === "subagent") {
			if (args.agent) return `${args.agent}: ${args.task || ""}`;
			if (args.tasks) return `${args.tasks.length} in parallel`;
			if (args.chain) return `chain: ${args.chain.map((t) => t.agent).join(" → ")}`;
		}
		const first = Object.values(args).find((v) => typeof v === "string");
		return first || "";
	}
	const shortName = (n) => String(n || "tool").replace(/^mcp__/, "").split("__").pop();

	// --- token ---------------------------------------------------------------------------
	// A bearer token in localStorage, not a cookie: a cookie would also be sent to other ports on this host.
	const TOKEN_KEY = "crust.token";
	const getToken = () => {
		try {
			return localStorage.getItem(TOKEN_KEY) || "";
		} catch {
			return "";
		}
	};
	const setToken = (t) => {
		try {
			if (t) localStorage.setItem(TOKEN_KEY, t);
			else localStorage.removeItem(TOKEN_KEY);
		} catch {}
	};
	const authHeader = () => {
		const t = getToken();
		return t ? { Authorization: `Bearer ${t}` } : {};
	};

	// --- api -----------------------------------------------------------------------------
	async function api(method, path, body) {
		const opts = { method, headers: { "X-Crust-Remote": "1", ...(path === "/api/pair" ? {} : authHeader()) }, cache: "no-store" };
		if (method !== "GET") {
			opts.headers["Content-Type"] = "application/json";
			opts.body = JSON.stringify(body || {});
		}
		const res = await fetch(path, opts);
		let data = {};
		try {
			data = await res.json();
		} catch {}
		if (res.status === 401 && path !== "/api/pair") {
			setToken("");
			showPair();
			const e = new Error("Not paired");
			e.status = 401;
			throw e;
		}
		if (!res.ok) {
			const e = new Error(data.error || `Request failed (${res.status})`);
			e.status = res.status;
			throw e;
		}
		return data;
	}

	// --- screens -------------------------------------------------------------------------
	function show(name) {
		screen = name;
		for (const s of ["pair", "main"]) $(`#${s}`).hidden = s !== name;
		closeMenu();
		if (name === "pair") closeSheet();
	}

	function showPair() {
		closeStream();
		show("pair");
		view.id = null;
		if (!$("#pair-name").value) $("#pair-name").value = guessDeviceName();
	}

	function guessDeviceName() {
		const ua = navigator.userAgent || "";
		if (/iPhone/.test(ua)) return "iPhone";
		if (/iPad/.test(ua)) return "iPad";
		if (/Android/.test(ua)) return "Android phone";
		return "Phone";
	}

	async function pair() {
		const code = $("#pair-code").value;
		const err = $("#pair-error");
		err.textContent = "";
		if (!code.trim()) return;
		const btn = $("#pair-go");
		btn.disabled = true;
		try {
			const r = await api("POST", "/api/pair", { code, deviceName: $("#pair-name").value.trim() || guessDeviceName() });
			if (!r.token) throw new Error("The desktop didn't send a login. Try again.");
			setToken(r.token);
			$("#pair-code").value = "";
			await boot();
		} catch (e) {
			err.textContent = e.message;
		} finally {
			btn.disabled = false;
		}
	}

	function showMain() {
		if (screen !== "main") show("main");
		updateNotifyButton();
	}

	// --- menu & sheets ---------------------------------------------------------------------
	function closeMenu() {
		$("#menu").hidden = true;
		$("#menu-btn").setAttribute("aria-expanded", "false");
	}
	function toggleMenu() {
		const open = $("#menu").hidden;
		$("#menu").hidden = !open;
		$("#menu-btn").setAttribute("aria-expanded", String(open));
	}

	let sheetKind = null; // "chats" | "models"
	function openSheet(kind, title) {
		closeMenu();
		sheetKind = kind;
		$("#sheet-title").textContent = title;
		$("#sheet-backdrop").hidden = false;
		$("#model-btn").setAttribute("aria-expanded", String(kind === "models"));
		renderSheet();
	}
	function closeSheet() {
		sheetKind = null;
		$("#sheet-backdrop").hidden = true;
		$("#sheet-body").replaceChildren();
		$("#model-btn").setAttribute("aria-expanded", "false");
	}
	function renderSheet() {
		if (sheetKind === "chats") renderChatsSheet();
		else if (sheetKind === "models") renderModelsSheet();
	}

	// Every shared chat, also the ones whose tab was closed on this phone (the desktop's "Earlier chats").
	function renderChatsSheet() {
		const box = $("#sheet-body");
		box.replaceChildren();
		const list = [...chats.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		if (!list.length) box.append(el("div", "empty", 'No chats are shared yet. On your computer, open a chat and turn on "Use this chat from your phone" from the phone button in the chat header.'));
		for (const c of list) {
			const st = displayStatus(c);
			const row = el("button", `row ${st}${c.id === view.id ? " current" : ""}`);
			row.type = "button";
			const top = el("div", "top");
			top.append(el("span", `dot-s ${st}`, DOT[st] || "\u25cb"), el("span", "name", c.title || "New chat"), el("span", "st", STATUS_LABEL[st] || ""));
			row.append(top);
			if (c.lastText) row.append(el("div", "last", c.lastText));
			const meta = el("div", "meta");
			if (c.cwd) meta.append(el("span", "", baseName(c.cwd)));
			if (c.branch) meta.append(el("span", "chip", c.branch));
			if (isHidden(c)) meta.append(el("span", "", "Tab closed"));
			if (meta.childNodes.length) row.append(meta);
			row.addEventListener("click", () => {
				closeSheet();
				openChat(c.id);
			});
			box.append(row);
		}
	}

	const ctxText = (ctx) => `${ctx.approx ? "\u2248" : ""}${ctx.pct}%`;

	// The desktop's model pill popover: context fill and the model list.
	function renderModelsSheet() {
		const box = $("#sheet-body");
		const keepFilter = box.querySelector(".sheet-filter")?.value || "";
		box.replaceChildren();
		const c = view.id ? chats.get(view.id) : null;
		const s = view.id ? settings.get(view.id) : null;
		if (c?.ctx) {
			const line = el("div", "ctx-line");
			const bar = el("span", "ctx-bar");
			const fill = el("span");
			fill.style.width = `${c.ctx.pct}%`;
			bar.append(fill);
			line.append(el("span", "", "Context"), bar, el("span", "", ctxText(c.ctx)));
			box.append(line);
		}
		box.append(el("div", "sheet-section", "Model"));
		if (!s) {
			box.append(el("div", "empty", !c ? "Open a chat first." : c.status === "stopped" ? "Pi isn't running in this chat." : "Loading models\u2026"));
			return;
		}
		if (!s.models.length) {
			box.append(el("div", "empty", "No models available."));
			return;
		}
		const providers = new Set(s.models.map((m) => m.provider));
		let filter = null;
		if (s.models.length > 8) {
			filter = el("input", "sheet-filter");
			filter.type = "search";
			filter.placeholder = "Filter models\u2026";
			filter.value = keepFilter;
			filter.setAttribute("aria-label", "Filter models");
			box.append(filter);
		}
		const list = el("div");
		box.append(list);
		const opts = [];
		for (const m of s.models) {
			const selected = !!s.model && s.model.provider === m.provider && s.model.id === m.id;
			const b = el("button", `opt${selected ? " selected" : ""}`);
			b.type = "button";
			b.append(el("span", "check", selected ? "\u2713" : ""), el("span", "o-label", m.name || m.id), el("span", "o-meta", providers.size > 1 ? m.provider.replace(/^github-copilot$/, "Copilot") : ""));
			b.dataset.search = `${m.name || ""} ${m.id} ${m.provider}`.toLowerCase();
			b.addEventListener("click", () => {
				closeSheet();
				if (!selected) setSetting({ model: { provider: m.provider, id: m.id } }, `Model: ${m.name || m.id}`);
			});
			opts.push(b);
			list.append(b);
		}
		if (filter) {
			const apply = () => {
				const q = filter.value.trim().toLowerCase();
				for (const b of opts) b.hidden = !!q && !b.dataset.search.includes(q);
			};
			filter.addEventListener("input", apply);
			apply();
		}
		list.querySelector(".selected")?.scrollIntoView({ block: "center" });
	}

	// --- tabs & header --------------------------------------------------------------------
	function renderTabs() {
		const strip = $("#tabs");
		const list = tabList();
		strip.replaceChildren(
			...list.map((c) => {
				const st = c.id === view.id && displayStatus(c) === "done" ? "idle" : displayStatus(c);
				const t = el("div", `tab ${st}`);
				t.setAttribute("role", "tab");
				t.setAttribute("aria-selected", String(c.id === view.id));
				t.dataset.id = c.id;
				t.append(el("span", "t-state", TAB_STATE[st] || ""));
				t.append(el("span", "t-label", c.title || "New chat"));
				// The active chat shows its clock in the working line; other tabs show it here.
				if (st === "working" && c.since && c.id !== view.id) {
					const time = el("span", "t-time", fmtDur(elapsed(c.since)));
					time.dataset.since = c.since;
					t.append(time);
				}
				const x = el("button", "t-close", "\u00d7");
				x.type = "button";
				x.setAttribute("aria-label", `Close ${c.title || "chat"} on this phone`);
				x.addEventListener("click", (e) => {
					e.stopPropagation();
					closeTab(c.id);
				});
				t.append(x);
				t.addEventListener("click", () => openChat(c.id));
				return t;
			}),
		);
		strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
	}

	// \u00d7 hides the tab on this phone only; the chat stays open on the desktop and in "All chats".
	function closeTab(id) {
		const list = tabList();
		const i = list.findIndex((c) => c.id === id);
		setHidden(id, true);
		drafts.delete(id);
		if (id === view.id) {
			const next = list[i + 1] || list[i - 1];
			if (next && next.id !== id) openChat(next.id);
			else selectNone();
		} else renderTabs();
	}

	// Model pill, context, permission mode, thinking level, composer state: everything that follows the active chat.
	function renderChrome() {
		const c = view.id ? chats.get(view.id) : null;
		const s = view.id ? settings.get(view.id) : null;
		$("#model-name").textContent = s?.model?.name || s?.model?.id || (c ? "Model" : "Pi Crust");
		const seg = $("#ctx-seg");
		seg.hidden = !c?.ctx;
		if (c?.ctx) {
			seg.querySelector(".ctx-bar > span").style.width = `${c.ctx.pct}%`;
			seg.querySelector(".ctx-pct").textContent = ctxText(c.ctx);
			seg.classList.toggle("warn", c.ctx.pct >= 75 && c.ctx.pct < 90);
			seg.classList.toggle("full", c.ctx.pct >= 90);
		}

		const stopped = c?.status === "stopped";
		$("#stopped").hidden = !stopped;
		const usable = !!c && !stopped;
		$("#composer").classList.toggle("disabled", !usable);
		$("#input").disabled = !c;
		$("#send").disabled = !usable;

		const mode = $("#perm-mode");
		const modeKnown = MODE_IDS.includes(c?.mode); // only what the extension reported: no guess, and no mode shown when nothing is enforced
		if (!mode.dataset.busy) mode.value = modeKnown ? c.mode : "";
		mode.disabled = !usable || !!mode.dataset.busy || !modeKnown;
		mode.title = modeKnown ? "" : "Permission modes are not active in this chat (not enforced)";
		syncPill(mode);

		const think = $("#thinking-level");
		const levels = s?.thinkingLevels || [];
		const want = levels.join("|");
		if (think.dataset.levels !== want) {
			think.replaceChildren(
				...levels.map((l) => {
					const o = el("option", "", l);
					o.value = l;
					return o;
				}),
			);
			think.dataset.levels = want;
		}
		if (!think.dataset.busy && s?.thinkingLevel && levels.includes(s.thinkingLevel)) think.value = s.thinkingLevel;
		$("#thinking-wrap").hidden = !usable || !levels.length || (levels.length === 1 && levels[0] === "off");
		think.disabled = !!think.dataset.busy;
		syncPill(think);
	}

	// The pill shows the select's current option (and, for the permission mode, its colour).
	function syncPill(sel) {
		const wrap = sel.parentElement;
		wrap.querySelector(".ps-label").textContent = sel.selectedOptions[0]?.textContent || "";
		if (sel.id === "perm-mode") wrap.className = `pill-select mode-${sel.value}`;
	}

	// No chat to show: the empty state, with the same "New chat" the header has.
	function selectNone() {
		if (view.id) markViewed(view.id);
		saveDraft();
		view.id = null;
		view.seq++;
		view.loading = false;
		writeKey("crust.activeChat", null);
		resetTranscript();
		renderAsk();
		setStreaming(false);
		const box = el("div", "empty");
		box.append(el("div", "", chats.size ? "All tabs are closed on this phone." : 'No chats are shared yet. On your computer, open a chat and turn on "Use this chat from your phone" from the phone button in the chat header.'));
		const actions = el("div");
		if (chats.size) {
			const all = el("button", "btn secondary", "All chats");
			all.type = "button";
			all.addEventListener("click", () => openSheet("chats", "All chats"));
			actions.append(all, document.createTextNode(" "));
		}
		const nb = el("button", "btn", "New chat");
		nb.type = "button";
		nb.addEventListener("click", newChat);
		actions.append(nb);
		box.append(actions);
		tr().append(box);
		$("#input").value = "";
		autosize();
		renderTabs();
		renderChrome();
	}

	// Which chat to show after (re)connecting: the one asked for, the last one open, else the newest tab.
	function pickChat(preferred) {
		if (preferred && chats.has(preferred)) return preferred;
		const last = readJsonKey("crust.activeChat");
		if (typeof last === "string" && chats.has(last) && !isHidden(chats.get(last))) return last;
		const tabs = tabList();
		return tabs.length ? [...tabs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id : null;
	}
	function showPicked(preferred) {
		const id = pickChat(preferred);
		if (id) openChat(id);
		else selectNone();
	}

	// --- settings ------------------------------------------------------------------------------
	async function loadSettings(id) {
		const c = chats.get(id);
		if (!c || c.status === "stopped" || c.status === "starting") return;
		try {
			const s = await api("GET", `/api/chats/${encodeURIComponent(id)}/settings`);
			settings.set(id, { model: s.model || null, models: s.models || [], thinkingLevel: s.thinkingLevel || null, thinkingLevels: s.thinkingLevels || [] });
			if (id === view.id) {
				renderChrome();
				if (sheetKind === "models") renderModelsSheet();
			}
		} catch {}
	}

	async function setSetting(change, okMessage) {
		const id = view.id;
		if (!id) return false;
		try {
			await api("POST", `/api/chats/${encodeURIComponent(id)}/settings`, change);
			if (okMessage) toast(okMessage);
			if (!change.mode) await loadSettings(id);
			return true;
		} catch (e) {
			if (e.status === 404) onChatRemoved(id);
			else if (e.status !== 401) toast(e.message, "error");
			return false;
		}
	}

	async function changeMode() {
		const sel = $("#perm-mode");
		const c = chats.get(view.id);
		const prev = MODE_IDS.includes(c?.mode) ? c.mode : "";
		const next = sel.value;
		syncPill(sel);
		sel.dataset.busy = "1";
		sel.disabled = true;
		const ok = await setSetting({ mode: next });
		delete sel.dataset.busy;
		// The extension's status confirms the switch (summary.mode); nothing is assumed before it arrives.
		if (!ok) sel.value = prev;
		renderChrome();
	}

	async function changeThinking() {
		const sel = $("#thinking-level");
		const s = settings.get(view.id);
		const prev = s?.thinkingLevel;
		syncPill(sel);
		sel.dataset.busy = "1";
		sel.disabled = true;
		const ok = await setSetting({ thinkingLevel: sel.value });
		delete sel.dataset.busy;
		if (!ok && prev) sel.value = prev;
		renderChrome();
	}

	// --- stream --------------------------------------------------------------------------
	// Server-sent events over fetch(): EventSource can't send the Authorization header.
	function closeStream() {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
		closeStreamOnly();
		connecting = false;
	}

	function closeStreamOnly() {
		if (stream) {
			const s = stream;
			stream = null;
			s.abort();
		}
	}

	function setConn(ok) {
		$("#conn").hidden = !!ok;
	}

	function scheduleReconnect() {
		if (reconnectTimer || screen === "pair") return;
		const wait = Math.min(Math.max(BACKOFF[Math.min(backoffStep++, BACKOFF.length - 1)], retryHint), BACKOFF[BACKOFF.length - 1]);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, wait);
	}

	function unauthorized() {
		setToken("");
		showPair();
	}

	// Reads "event:/data:/retry:" lines until the stream ends. Comment lines (": ping") only prove the connection is alive.
	async function readEvents(body, onEvent, onActivity) {
		const reader = body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let event = "message";
		let data = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			onActivity();
			buf += dec.decode(value, { stream: true });
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				let line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line === "") {
					if (data.length) onEvent(event, data.join("\n"));
					event = "message";
					data = [];
				} else if (line[0] !== ":") {
					const i = line.indexOf(":");
					const field = i < 0 ? line : line.slice(0, i);
					let val = i < 0 ? "" : line.slice(i + 1);
					if (val[0] === " ") val = val.slice(1);
					if (field === "event") event = val;
					else if (field === "data") data.push(val);
					else if (field === "retry" && /^\d+$/.test(val)) retryHint = Math.min(Number(val), 10000);
				}
			}
		}
	}

	function onEvent(name, raw) {
		let d;
		try {
			d = JSON.parse(raw);
		} catch {
			return;
		}
		switch (name) {
			case "hello":
				backoffStep = 0;
				if (typeof d.serverTime === "number") clockOffset = d.serverTime - Date.now();
				setConn(true);
				replaceChats(d);
				break;
			case "reset":
				replaceChats(d);
				break;
			case "chat":
				onChat(d.chat);
				break;
			case "chat_removed":
				onChatRemoved(d.chatId);
				break;
			case "record":
				if (d.chatId !== view.id) break;
				// While the history loads, keep the records: the ones newer than the history are replayed after it.
				if (view.loading) view.buffer.push(d);
				else applyLive(d);
				break;
			case "held":
				if (d.chatId !== view.id) break;
				view.held = d.held || [];
				if (view.loading) view.heldLive = true;
				renderQueue();
				break;
			case "ui_request":
				if (d.chatId === view.id) addAsk(d.request);
				break;
			case "ui_resolved": {
				if (d.chatId !== view.id) break;
				const had = view.asks.some((a) => a.id === d.id);
				view.asks = view.asks.filter((a) => a.id !== d.id);
				renderAsk();
				if (had && d.by === "desktop") toast("Answered on the desktop");
				break;
			}
			case "toast":
				if (d.chatId === view.id) toast(d.message, d.kind === "error" ? "error" : "");
				break;
		}
	}

	async function connect() {
		if (connecting || screen === "pair" || !getToken()) return;
		connecting = true;
		closeStreamOnly();
		try {
			// A cheap authenticated request first: it tells us about a 401 and the clock offset.
			appState = await api("GET", "/api/state");
			if (typeof appState.serverTime === "number") clockOffset = appState.serverTime - Date.now();
		} catch (e) {
			connecting = false;
			if (e.status !== 401) {
				setConn(false);
				scheduleReconnect();
			}
			return;
		}
		connecting = false;
		const ctrl = new AbortController();
		stream = ctrl;
		let lastRx = Date.now();
		let stale = false;
		// The server pings every 25 s: silence for 60 s means a dead connection that never reported itself.
		const watchdog = setInterval(() => {
			if (Date.now() - lastRx > 60000) {
				stale = true;
				ctrl.abort();
			}
		}, 10000);
		try {
			const res = await fetch("/api/events", { headers: { ...authHeader(), Accept: "text/event-stream" }, cache: "no-store", signal: ctrl.signal });
			if (res.status === 401) {
				if (stream === ctrl) stream = null;
				return unauthorized();
			}
			if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);
			await readEvents(res.body, onEvent, () => (lastRx = Date.now()));
		} catch {
			// Aborted on purpose (new connect, pair screen): whoever aborted took over.
			if (ctrl.signal.aborted && !stale) return;
		} finally {
			clearInterval(watchdog);
		}
		if (stream !== ctrl) return;
		stream = null;
		setConn(false);
		scheduleReconnect();
	}

	function replaceChats(d) {
		if (d.repo !== undefined && appState) appState.repo = d.repo;
		chats.clear();
		for (const c of d.chats || []) chats.set(c.id, c);
		for (const id of [...settings.keys()]) if (!chats.has(id)) settings.delete(id);
		if (screen === "pair") show("main");
		const wanted = pendingChatHash;
		pendingChatHash = null;
		if (wanted && chats.has(wanted)) return openChat(wanted);
		if (view.id && chats.has(view.id)) openChat(view.id, true);
		else if (view.id) onChatRemoved(view.id);
		else showPicked();
		if (sheetKind === "chats") renderChatsSheet();
	}

	function onChat(c) {
		const prev = chats.get(c.id);
		chats.set(c.id, c);
		if (sheetKind === "chats") renderChatsSheet();
		if (c.id === view.id) {
			markViewed(c.id, c.updatedAt);
			// Pi came (back) up: its model and levels can be read now.
			if (prev && (prev.status === "starting" || prev.status === "stopped") && c.status !== prev.status && c.status !== "stopped") loadSettings(c.id);
			// Resync running state from the summary (covers missed agent_* records).
			const working = c.status === "working" || c.status === "waiting";
			if (working !== view.streaming) setStreaming(working);
			else if (view.workEl && c.since) view.workEl.dataset.since = c.since;
			renderChrome();
			if (sheetKind === "models") renderModelsSheet();
		} else if (!view.id && screen === "main" && !isHidden(c)) {
			return showPicked(c.id); // the first chat to show up (shared on the desktop, or started here)
		}
		renderTabs();
	}

	function onChatRemoved(id) {
		chats.delete(id);
		settings.delete(id);
		drafts.delete(id);
		if (sheetKind === "chats") renderChatsSheet();
		if (id === view.id) {
			toast("This chat is no longer shared"); // unshared or closed: the phone only needs to know it is gone
			view.id = null;
			showPicked();
		} else renderTabs();
	}

	// --- chat view -----------------------------------------------------------------------
	function saveDraft() {
		if (!view.id) return;
		const v = $("#input").value;
		if (v) drafts.set(view.id, v);
		else drafts.delete(view.id);
	}

	function resetTranscript() {
		$("#transcript").replaceChildren();
		view.cur = null;
		view.tools.clear();
		view.workEl = null;
		view.dirty.clear();
		view.asks = [];
		view.queue = { steering: [], followUp: [] };
		view.held = [];
		view.heldLive = false;
		view.atBottom = true;
	}

	async function openChat(id, resync) {
		if (!resync && id === view.id && !view.loading) {
			scrollEnd(true);
			return;
		}
		if (!resync && view.id && view.id !== id) {
			markViewed(view.id);
			saveDraft();
		}
		const seq = ++view.seq;
		const c = chats.get(id);
		view.id = id;
		view.loading = true;
		view.buffer = [];
		writeKey("crust.activeChat", JSON.stringify(id));
		if (c && hiddenTabs()[id]) setHidden(id, false); // opened from All chats: its tab comes back
		showMain();
		if (!resync) {
			resetTranscript();
			renderAsk();
			renderQueue();
			setStreaming(false);
			$("#input").value = drafts.get(id) || "";
			autosize();
		}
		renderTabs();
		renderChrome();
		loadSettings(id);
		let data;
		try {
			data = await api("GET", `/api/chats/${encodeURIComponent(id)}/messages`);
		} catch (e) {
			if (seq !== view.seq) return;
			view.loading = false;
			if (e.status === 401) return;
			if (e.status === 404) return onChatRemoved(id);
			if (chats.get(id)?.status !== "stopped") toast(e.status === 409 ? "Pi isn't running for this chat" : e.message, "error");
			renderChrome();
			return;
		}
		if (seq !== view.seq) return;
		const heldLive = view.heldLive; // resetTranscript clears it
		resetTranscript();
		if (data.chat) chats.set(id, data.chat);
		if (data.truncated) $("#transcript").append(el("div", "trunc", "Earlier messages are not shown."));
		renderHistory(data.messages || []);
		// Records the history already contains (seq up to the cut) are dropped; the rest happened after it.
		const cut = typeof data.seq === "number" ? data.seq : 0;
		const later = view.buffer.filter((d) => d.seq > cut);
		view.buffer = [];
		view.loading = false;
		view.lastSeq = cut;
		view.queue = { steering: data.queue?.steering || [], followUp: data.queue?.followUp || [] };
		if (!heldLive) view.held = data.held || [];
		for (const d of later) applyLive(d);
		renderQueue();
		view.asks = (data.asks || []).map(withDeadline);
		renderAsk();
		setStreaming(data.chat ? data.chat.status === "working" || data.chat.status === "waiting" : false);
		if (data.chat) markViewed(id, data.chat.updatedAt);
		renderTabs();
		renderChrome();
		scrollEnd(true);
		if (!resync) $("#input").blur();
	}

	function autosize() {
		const t = $("#input");
		t.style.height = "auto";
		t.style.height = `${Math.min(t.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	}

	const tr = () => $("#transcript");
	function append(node) {
		const box = tr();
		if (view.workEl && view.workEl.parentNode === box) box.insertBefore(node, view.workEl);
		else box.append(node);
	}
	function scrollEnd(force) {
		const box = tr();
		if (force || view.atBottom) box.scrollTop = box.scrollHeight;
	}

	// The desktop's working indicator: a spinning star, "Working", the turn's clock.
	function setStreaming(on) {
		view.streaming = on;
		$("#stop").hidden = !on;
		if (on) {
			if (!view.workEl) {
				view.workEl = el("div", "working-line");
				view.workEl.append(el("span", "w-star", "\u273b"), el("span", "", "Working\u2026"), el("span", "w-clock"));
				tr().append(view.workEl);
			}
			const since = chats.get(view.id)?.since;
			if (since) view.workEl.dataset.since = since;
			tickClocks();
			scrollEnd();
		} else if (view.workEl) {
			view.workEl.remove();
			view.workEl = null;
		}
	}

	// One timer for every clock on screen (tabs and the working line).
	function tickClocks() {
		for (const n of document.querySelectorAll(".t-time[data-since]")) n.textContent = fmtDur(elapsed(Number(n.dataset.since)));
		const w = view.workEl;
		if (w) {
			const since = Number(w.dataset.since || 0);
			w.querySelector(".w-clock").textContent = since ? fmtDur(elapsed(since)) : "";
		}
	}
	setInterval(tickClocks, 1000);

	function addNotice(text, kind) {
		append(el("div", `notice${kind ? ` ${kind}` : ""}`, text));
		scrollEnd();
	}

	function renderUser(m) {
		const text = textOf(m.content);
		if (!text) return;
		append(el("div", "user", text));
		view.cur = null;
	}

	function startAssistant() {
		view.cur = { blocks: new Map() };
	}

	function block(index, kind) {
		if (!view.cur) startAssistant();
		let b = view.cur.blocks.get(index);
		if (b && b.kind !== kind) b = null;
		if (!b) {
			let node;
			let body;
			if (kind === "thinking") {
				node = el("details", "think");
				node.append(el("summary", "", "Thinking"));
				body = el("pre");
				node.append(body);
			} else {
				node = el("div", "md");
				body = node;
			}
			b = { kind, raw: "", node, body, final: false };
			view.cur.blocks.set(index, b);
			append(node);
		}
		return b;
	}

	function paint(b) {
		if (b.kind === "thinking") b.body.textContent = b.raw;
		else if (b.final) setMd(b.body, b.raw);
		else setMd(b.body, b.raw);
	}
	function queuePaint(b) {
		view.dirty.add(b);
		if (view.raf) return;
		view.raf = requestAnimationFrame(flushPaint);
	}
	function flushPaint() {
		view.raf = 0;
		for (const b of view.dirty) paint(b);
		view.dirty.clear();
		scrollEnd();
	}

	function toolCard(id, name, args) {
		let t = view.tools.get(id);
		if (!t) {
			const d = el("details", "tool running");
			const sum = el("summary");
			const status = el("span", "dot");
			const nm = el("span", "tn", shortName(name));
			const arg = el("span", "ta");
			sum.append(status, nm, arg);
			const out = el("pre");
			d.append(sum, out);
			t = { d, nm, arg, out, name };
			view.tools.set(id, t);
			append(d);
			scrollEnd();
		}
		if (name && name !== t.name) {
			t.name = name;
			t.nm.textContent = shortName(name);
		}
		if (args && typeof args === "object") {
			t.args = args;
			const s = toolSummary(t.name, args);
			t.arg.textContent = s.split("\n")[0].slice(0, 200);
		}
		return t;
	}

	function setToolOutput(t, result, isError) {
		if (!result) return;
		const text = textOf(result.content ?? result);
		t.out.textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text;
		if (isError) t.d.open = true;
	}

	function finishTool(t, isError) {
		t.d.classList.remove("running");
		t.d.classList.add(isError ? "err" : "ok");
	}

	function renderHistory(list) {
		for (const m of list) {
			if (m.role === "user") {
				renderUser(m);
			} else if (m.role === "assistant") {
				startAssistant();
				(m.content || []).forEach((c, i) => {
					if (c.type === "text") {
						const b = block(i, "text");
						b.raw = c.text || "";
						b.final = true;
						paint(b);
					} else if (c.type === "thinking") {
						const b = block(i, "thinking");
						b.raw = c.thinking || "";
						paint(b);
					} else if (c.type === "toolCall") {
						toolCard(c.id, c.name, c.arguments);
					}
				});
				if (m.stopReason === "error" && m.errorMessage) addNotice(m.errorMessage, "error");
			} else if (m.role === "toolResult") {
				const t = view.tools.get(m.toolCallId) || toolCard(m.toolCallId, m.toolName, {});
				finishTool(t, !!m.isError);
				t.d.open = false;
				setToolOutput(t, m, m.isError);
			} else if (m.role === "custom" && m.display !== false) {
				const text = textOf(m.content);
				if (text) addNotice(text);
			} else if (m.role === "compactionSummary") {
				addNotice("Earlier messages were compacted into a summary.");
			}
		}
		view.cur = null;
	}

	function applyLive(d) {
		if (typeof d.seq === "number") {
			if (d.seq <= view.lastSeq) return; // already shown
			view.lastSeq = d.seq;
		}
		applyRecord(d.record);
	}

	// Mirrors renderer.js handleRecord, for slim records. A delta or tool update can arrive for an assistant message that
	// isn't in the loaded history (it was still streaming): block() and toolCard() create what is missing.
	function applyRecord(r) {
		if (!r) return;
		switch (r.type) {
			case "queue_update":
				view.queue = { steering: r.steering || [], followUp: r.followUp || [] };
				renderQueue();
				return;
			case "agent_start":
				setStreaming(true);
				return;
			case "agent_settled":
			case "agent_end":
				if (r.type === "agent_settled") setStreaming(false);
				return;
			case "message_start": {
				const m = r.message || {};
				if (m.role === "user") renderUser(m);
				else if (m.role === "assistant") startAssistant();
				keepWorkingLast();
				return;
			}
			case "message_update": {
				const ev = r.assistantMessageEvent || {};
				if (ev.type === "text_delta") {
					const b = block(ev.contentIndex, "text");
					b.raw += ev.delta || "";
					queuePaint(b);
				} else if (ev.type === "text_end" || ev.type === "thinking_end") {
					const b = block(ev.contentIndex, ev.type === "text_end" ? "text" : "thinking");
					if (typeof ev.content === "string") b.raw = ev.content;
					if (ev.type === "text_end") b.final = true;
					queuePaint(b);
				} else if (ev.type === "toolcall_start") {
					toolCard(ev.id, ev.toolName);
				} else if (ev.type === "toolcall_end" && ev.toolCall) {
					toolCard(ev.toolCall.id, ev.toolCall.name, ev.toolCall.arguments);
				}
				keepWorkingLast();
				return;
			}
			case "message_end": {
				const m = r.message || {};
				if (m.role === "assistant") {
					if (m.stopReason === "error" || m.errorMessage) addNotice(m.errorMessage || "The model returned an error.", "error");
					else if (m.stopReason === "aborted") addNotice("Stopped.");
					flushPaint();
				} else if (m.role === "custom" && m.display !== false) {
					const text = textOf(m.content);
					if (text) addNotice(text);
				}
				keepWorkingLast();
				return;
			}
			case "tool_execution_start":
				toolCard(r.toolCallId, r.toolName, r.args);
				keepWorkingLast();
				return;
			case "tool_execution_update": {
				const t = toolCard(r.toolCallId, r.toolName, r.args);
				setToolOutput(t, r.partialResult, false);
				return;
			}
			case "tool_execution_end": {
				const t = toolCard(r.toolCallId, r.toolName, r.args);
				finishTool(t, !!r.isError);
				setToolOutput(t, r.result, r.isError);
				return;
			}
			case "auto_retry_start":
				addNotice(`Retrying (${r.attempt}/${r.maxAttempts}): ${r.errorMessage || ""}`);
				return;
			case "compaction_start":
				addNotice("Compacting the conversation…");
				return;
			case "compaction_end":
				addNotice(r.result ? "Conversation compacted." : `Compaction ${r.aborted ? "stopped" : "failed"}${r.errorMessage ? `: ${r.errorMessage}` : ""}.`);
				return;
		}
	}
	function keepWorkingLast() {
		if (view.workEl && view.workEl.parentNode === tr()) tr().append(view.workEl);
		scrollEnd();
	}

	// --- ask panel -------------------------------------------------------------------------
	// The server's expiresAt is on its clock; clockOffset moves it onto ours. Without it, fall back to the timeout.
	function withDeadline(req) {
		if (!req) return req;
		if (req.expiresAt) return { ...req, deadline: req.expiresAt - clockOffset };
		return req.timeout ? { ...req, deadline: Date.now() + req.timeout } : req;
	}
	function addAsk(req) {
		if (!req || view.asks.some((a) => a.id === req.id)) return;
		view.asks.push(withDeadline(req));
		renderAsk();
	}

	let askTimer = 0;
	function renderAsk() {
		clearInterval(askTimer);
		const box = $("#ask");
		box.replaceChildren();
		const now = Date.now();
		view.asks = view.asks.filter((a) => !a.deadline || a.deadline > now);
		const req = view.asks[0];
		box.hidden = !req;
		if (!req) return;

		const respond = async (payload, btns) => {
			for (const b of btns) b.disabled = true;
			try {
				await api("POST", `/api/chats/${encodeURIComponent(view.id)}/ui/${encodeURIComponent(req.id)}`, payload);
				view.asks = view.asks.filter((a) => a !== req);
				renderAsk();
			} catch (e) {
				if (e.status === 404 && /not shared/.test(e.message)) onChatRemoved(view.id);
				else if (e.status === 409 || e.status === 404) {
					view.asks = view.asks.filter((a) => a !== req);
					renderAsk();
					toast(e.status === 409 ? "Already answered" : "That question is no longer open");
				} else {
					toast(e.message, "error");
					for (const b of btns) b.disabled = false;
				}
			}
		};
		const btns = [];
		const mk = (label, cls, fn) => {
			const b = el("button", cls || "", label);
			b.type = "button";
			b.addEventListener("click", fn);
			btns.push(b);
			return b;
		};
		const cancel = () => mk("Cancel", "", () => respond({ cancelled: true }, btns));

		// A permission prompt ("Allow once" ...): the question, the whole text to approve in a wrapping, scrollable box, the mode.
		// Only its own answers, no Cancel (closing or a timeout count as Deny). Same layout as the desktop's.
		const optLabels = (req.options || []).map((o) => (typeof o === "string" ? o : o.label || o.value || String(o)));
		const perm = req.method === "select" && typeof req.title === "string" && optLabels.includes("Allow once") && optLabels.includes("Deny");
		box.classList.toggle("perm", perm);
		let risky = false;
		const openedAt = performance.now();
		if (perm) {
			const lines = req.title.split("\n");
			const question = lines.shift();
			const mode = lines.length && /^Mode: /.test(lines[lines.length - 1]) ? lines.pop() : "";
			const reasonRe = /^(This file can |This name is a Windows device name|This text has hidden characters|This is a network path|The project folder is |Pi Crust could not read |The computer may send |Resolves to )/;
			const longRe = /^This (command|path|tool call) is [\d,.]+ characters long/;
			let longKind = "";
			const reasons = [];
			const peel = (end) => {
				const i = end ? lines.length - 1 : 0;
				const m = lines[i].match(longRe);
				if (m) longKind = m[1];
				else reasons.push(lines[i]);
				end ? lines.pop() : lines.shift();
			};
			while (lines.length && (reasonRe.test(lines[0]) || longRe.test(lines[0]))) peel(false);
			while (lines.length > 1 && (reasonRe.test(lines[lines.length - 1]) || longRe.test(lines[lines.length - 1]))) peel(true);
			// Risky (a warning line, outside the project folder, long text, no "for this chat"): "Deny" is the filled, focused answer.
			risky = reasons.length > 0 || !!longKind || /OUTSIDE/.test(question || "") || !optLabels.includes("Allow for this chat");
			box.append(el("div", "q", question || "Pi asks"));
			if (reasons.length) box.append(el("div", "m ask-reason", reasons.join("\n")));
			const detail = el("div", `ask-detail${longKind ? " long" : ""}`);
			const text = lines.join("\n");
			const pre = el("pre", "ask-text");
			let last = 0;
			for (const m of text.matchAll(/\u27e8[^\u27e9\n]{1,40}\u27e9/g)) {
				if (m.index > last) pre.append(text.slice(last, m.index));
				pre.append(el("span", "ask-mark", m[0]));
				last = m.index + m[0].length;
			}
			if (last < text.length) pre.append(text.slice(last));
			detail.append(pre);
			if (longKind) {
				detail.append(el("div", "ask-end", `End of ${longKind}`));
				detail.tabIndex = 0;
			}
			box.append(detail);
			if (mode) box.append(el("div", "ask-mode", mode));
			if (longKind) box.append(el("div", "ask-long", `Long ${longKind}: scroll to read all of it.`));
		} else box.append(el("div", "q", req.title || "Pi asks"));
		if (req.message) box.append(el("div", "m", req.message));
		if (req.method === "select") {
			const opts = el("div", "opts");
			let deny = null;
			for (const o of req.options || []) {
				const label = typeof o === "string" ? o : o.label || o.value || String(o);
				const value = typeof o === "string" ? o : o.value ?? label;
				const b = mk(label, perm ? (label === (risky ? "Deny" : "Allow once") ? "primary" : label === "Deny" ? "ask-deny" : "") : "", () => respond({ value }, btns));
				if (perm && label === "Deny") deny = b;
				opts.append(b);
			}
			if (!perm) opts.append(cancel());
			box.append(opts);
			// The filled answer is the focused one (an attached keyboard's Enter does what the screen suggests); keys are ignored for the first 500 ms.
			const first = perm ? (risky ? deny : opts.querySelector("button.primary")) : null;
			if (first) {
				first.focus({ preventScroll: true });
				const guard = (e) => {
					if (performance.now() - openedAt < 500 && (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow"))) {
						e.preventDefault();
						e.stopPropagation();
					}
				};
				box.addEventListener("keydown", guard, true);
				box.addEventListener("keyup", guard, true);
			}
		} else if (req.method === "confirm") {
			const opts = el("div", "opts inline");
			opts.append(mk("Yes", "primary", () => respond({ confirmed: true }, btns)), mk("No", "", () => respond({ confirmed: false }, btns)));
			box.append(opts);
			const c = el("div", "opts");
			c.append(cancel());
			box.append(c);
		} else {
			const multi = req.method === "editor";
			const inp = multi ? el("textarea") : el("input");
			if (multi) inp.rows = 6;
			else inp.type = "text";
			inp.placeholder = req.placeholder || "";
			inp.value = req.prefill || "";
			box.append(inp);
			const opts = el("div", "opts inline");
			opts.append(mk("Submit", "primary", () => respond({ value: inp.value }, btns)), cancel());
			box.append(opts);
		}
		if (req.deadline) {
			const cd = el("div", "cd");
			box.append(cd);
			const tick = () => {
				const left = Math.ceil((req.deadline - Date.now()) / 1000);
				if (left <= 0) {
					clearInterval(askTimer);
					view.asks = view.asks.filter((a) => a !== req);
					renderAsk();
					return;
				}
				cd.textContent = `Times out in ${left}s`;
			};
			tick();
			askTimer = setInterval(tick, 1000);
		}
	}

	// --- queued and held messages, above the composer (desktop: renderQueue) ----------------------
	function renderQueue() {
		const box = $("#queue");
		const row = (kind, label, text, i) => {
			const r = el("div", `q-item ${kind}`);
			const head = el("div", "q-head");
			head.append(el("span", "q-kind", label), el("span", "q-text", text));
			r.append(head);
			if (kind === "held") {
				const bar = el("div", "q-actions");
				for (const [name, act] of [["Send", heldSend], ["Edit", heldEdit], ["Remove", heldRemove]]) {
					const b = el("button", `btn secondary q-btn${name === "Send" ? " primary" : ""}`, name);
					b.type = "button";
					b.setAttribute("aria-label", `${name} paused message: ${text.slice(0, 40)}`);
					b.addEventListener("click", () => act(i, b));
					bar.append(b);
				}
				r.append(bar);
			}
			return r;
		};
		const q = view.queue;
		box.replaceChildren(
			...q.steering.map((t, i) => row("steering", "Next step", t, i)),
			...q.followUp.map((t, i) => row("followUp", "After this run", t, i)),
			...view.held.map((t, i) => row("held", "Paused", t, i)),
		);
		box.hidden = !box.childElementCount;
	}

	// The server removes the item only if it is still at that place with that text (the desktop may have taken it).
	async function heldTake(i, btn) {
		const id = view.id;
		const text = view.held[i];
		if (btn) btn.disabled = true;
		try {
			return (await api("POST", `/api/chats/${encodeURIComponent(id)}/held/take`, { index: i, text })).text;
		} catch (e) {
			if (e.status === 404) onChatRemoved(id);
			else if (e.status !== 401) toast(e.message, "error");
			return null;
		} finally {
			if (btn) btn.disabled = false;
		}
	}
	async function heldSend(i, btn) {
		const id = view.id; // the chat it was held in, even if the user switches meanwhile
		const text = await heldTake(i, btn);
		if (text === null) return;
		try {
			await api("POST", `/api/chats/${encodeURIComponent(id)}/prompt`, { text, mode: "auto" });
			if (view.id === id) {
				view.atBottom = true;
				scrollEnd(true);
			}
		} catch (e) {
			// Pi didn't take it: put it back where it belongs.
			if (view.id === id) {
				const input = $("#input");
				input.value = input.value ? `${text}\n${input.value}` : text;
				autosize();
			} else drafts.set(id, drafts.get(id) ? `${text}\n${drafts.get(id)}` : text);
			if (e.status === 404) onChatRemoved(id);
			else if (e.status !== 401) toast(e.message, "error");
		}
	}
	async function heldEdit(i, btn) {
		const text = await heldTake(i, btn);
		if (text === null) return;
		const input = $("#input");
		input.value = input.value ? `${text}\n${input.value}` : text;
		autosize();
		input.focus();
	}
	const heldRemove = (i, btn) => heldTake(i, btn);

	// --- composer ----------------------------------------------------------------------------
	async function send() {
		const input = $("#input");
		const text = input.value.trim();
		if (!text || !view.id) return;
		const id = view.id;
		input.value = "";
		drafts.delete(id);
		autosize();
		const btn = $("#send");
		btn.disabled = true;
		try {
			await api("POST", `/api/chats/${encodeURIComponent(id)}/prompt`, { text, mode: "auto" });
			if (view.id === id) {
				view.atBottom = true;
				scrollEnd(true);
			}
		} catch (e) {
			// Give the text back to the chat it was meant for (the user may have switched tabs meanwhile).
			if (view.id === id) {
				if (!input.value) input.value = text;
				autosize();
			} else if (!drafts.get(id)) drafts.set(id, text);
			if (e.status === 404) onChatRemoved(id);
			else if (e.status !== 401) toast(e.message, "error");
		} finally {
			btn.disabled = false;
			renderChrome();
		}
	}

	// Stop pauses what was queued: it comes back as "held" (a held event), the same list the desktop shows.
	async function stop() {
		const btn = $("#stop");
		btn.disabled = true;
		try {
			await api("POST", `/api/chats/${encodeURIComponent(view.id)}/abort`, {});
		} catch (e) {
			if (e.status === 404) onChatRemoved(view.id);
			else if (e.status !== 401) toast(e.message, "error");
		} finally {
			btn.disabled = false;
		}
	}

	async function newChat() {
		const btn = $("#new-chat");
		btn.disabled = true;
		try {
			const res = await api("POST", "/api/chats", {});
			// The chat event usually arrives first; open it either way.
			if (res.chatId) {
				if (!chats.has(res.chatId)) chats.set(res.chatId, { id: res.chatId, title: "", status: "starting", updatedAt: Date.now() });
				openChat(res.chatId);
			}
		} catch (e) {
			if (e.status !== 401) toast(e.message, "error");
		} finally {
			btn.disabled = false;
		}
	}

	async function restart() {
		try {
			await api("POST", `/api/chats/${encodeURIComponent(view.id)}/restart`, {});
			toast("Restarting…");
		} catch (e) {
			if (e.status === 404) onChatRemoved(view.id);
			else if (e.status !== 401) toast(e.message, "error");
		}
	}

	async function unpair() {
		try {
			await api("POST", "/api/unpair", {});
		} catch {}
		setToken("");
		try {
			const reg = await navigator.serviceWorker?.getRegistration();
			const sub = await reg?.pushManager?.getSubscription();
			await sub?.unsubscribe();
		} catch {}
		chats.clear();
		settings.clear();
		drafts.clear();
		appState = null;
		resetTranscript();
		showPair();
	}

	// --- notifications -------------------------------------------------------------------------
	function updateNotifyButton() {
		const ok = window.isSecureContext && "PushManager" in window && "serviceWorker" in navigator && appState?.push?.available && !appState?.push?.subscribed && (typeof Notification === "undefined" || Notification.permission !== "denied");
		$("#notify-btn").hidden = !ok;
	}

	function b64urlToUint8(s) {
		const pad = "=".repeat((4 - (s.length % 4)) % 4);
		const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(raw, (c) => c.charCodeAt(0));
	}

	async function enableNotifications() {
		try {
			const perm = await Notification.requestPermission();
			if (perm !== "granted") return toast("Notifications are blocked", "error");
			const reg = await navigator.serviceWorker.ready;
			let sub = await reg.pushManager.getSubscription();
			if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToUint8(appState.vapidPublicKey) });
			await api("POST", "/api/push/subscribe", { subscription: sub.toJSON() });
			appState.push.subscribed = true;
			updateNotifyButton();
			toast("Notifications on");
		} catch (e) {
			if (e.status !== 401) toast(`Notifications failed: ${e.message}`, "error");
		}
	}

	// --- boot --------------------------------------------------------------------------------------
	let pendingChatHash = null;

	function parseHash() {
		const h = location.hash.replace(/^#/, "");
		if (!h) return;
		const params = new URLSearchParams(h);
		const code = params.get("pair");
		const chat = params.get("chat");
		if (code) $("#pair-code").value = code.slice(0, 12);
		if (chat && /^chat-\d{1,9}$/.test(chat)) pendingChatHash = chat;
		history.replaceState(null, "", location.pathname + location.search);
	}

	async function boot() {
		if (!getToken()) return showPair();
		try {
			appState = await api("GET", "/api/state");
		} catch (e) {
			if (e.status === 401) return; // showPair already ran
			showMain();
			setConn(false);
			renderTabs();
			renderChrome();
			scheduleReconnect();
			return;
		}
		chats.clear();
		for (const c of appState.chats || []) chats.set(c.id, c);
		showMain();
		const wanted = pendingChatHash;
		pendingChatHash = null;
		if (wanted && chats.has(wanted)) openChat(wanted);
		else if (view.id && chats.has(view.id)) openChat(view.id, true);
		else showPicked();
		connect();
	}

	function init() {
		$("#pair-go").addEventListener("click", pair);
		$("#pair-code").addEventListener("keydown", (e) => e.key === "Enter" && pair());
		$("#new-chat").addEventListener("click", newChat);
		$("#history-btn").addEventListener("click", () => openSheet("chats", "All chats"));
		$("#model-btn").addEventListener("click", () => openSheet("models", "Model"));
		$("#sheet-close").addEventListener("click", closeSheet);
		$("#sheet-backdrop").addEventListener("click", (e) => e.target === e.currentTarget && closeSheet());
		$("#perm-mode").addEventListener("change", changeMode);
		$("#thinking-level").addEventListener("change", changeThinking);
		document.addEventListener("click", (e) => {
			if (!$("#menu").hidden && !e.target.closest("#menu, #menu-btn")) closeMenu();
		});
		document.addEventListener("keydown", (e) => {
			if (e.key !== "Escape") return;
			if (sheetKind) closeSheet();
			else closeMenu();
		});
		$("#restart").addEventListener("click", restart);
		$("#stop").addEventListener("click", stop);
		$("#notify-btn").addEventListener("click", enableNotifications);
		$("#menu-btn").addEventListener("click", toggleMenu);
		$("#unpair").addEventListener("click", unpair);
		$("#composer").addEventListener("submit", (e) => {
			e.preventDefault();
			send();
		});
		$("#input").addEventListener("input", autosize);
		tr().addEventListener("scroll", () => {
			const b = tr();
			view.atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
		});
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && screen !== "pair" && appState) {
				backoffStep = 0;
				closeStreamOnly();
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
				connect(); // the hello event resyncs the open chat
			}
		});
		window.addEventListener("online", () => document.visibilityState === "visible" && connect());

		if (window.isSecureContext && "serviceWorker" in navigator) {
			navigator.serviceWorker.register("/sw.js").catch(() => {});
			navigator.serviceWorker.addEventListener("message", (e) => {
				const id = e.data && e.data.open;
				if (typeof id === "string" && chats.has(id)) openChat(id);
			});
		}
		parseHash();
		boot();
	}

	init();
})();
