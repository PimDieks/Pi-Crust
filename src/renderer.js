// Pi Crust UI: file tree, browser toolbar, chat over Pi RPC, extension dialogs.
"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};

// Clicking or focusing UI after the embedded browser had focus: give this webContents OS focus back,
// otherwise inputs focus without a visible caret (main.js "ui:focus").
for (const t of ["mousedown", "focusin"]) document.addEventListener(t, () => document.hasFocus() || crust.focusUi(), true);

marked.setOptions({ gfm: true, breaks: false });
// Sanitized straight into a DOM fragment (no string round trip through innerHTML).
const md = (text) => {
	const frag = DOMPurify.sanitize(marked.parse(text || ""), { RETURN_DOM_FRAGMENT: true });
	for (const a of frag.querySelectorAll("a")) {
		a.target = "_blank";
		a.rel = "noopener noreferrer";
	}
	for (const pre of frag.querySelectorAll("pre")) addCodeActions(pre);
	return frag;
};

// Code blocks in the chat get Copy, and shell blocks also Run (sends the command to the Terminal tab).
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "shell-session", "terminal"]);
const PS_LANGS = new Set(["powershell", "pwsh", "ps1"]); // Windows only
if (isWin) for (const l of PS_LANGS) SHELL_LANGS.add(l);
// Ready to type into the shell: drop blank and comment-only lines (zsh doesn't allow interactive comments by
// default) and leading "$ " prompts.
function shellCommand(code) {
	return code
		.split("\n")
		.map((l) => l.replace(/^\s*\$ /, ""))
		.filter((l) => l.trim() && !/^\s*#/.test(l))
		.join(isWin ? "\r" : "\n"); // typed as Enter presses (PSReadLine handles continuations); zsh keeps one command per line
}
function addCodeActions(pre) {
	const code = pre.querySelector("code");
	if (!code) return;
	const lang = (code.className.match(/language-([\w-]+)/) || [])[1]?.toLowerCase();
	const bar = el("div", "code-actions");
	const copy = el("button", "code-action", "Copy");
	copy.type = "button";
	copy.title = "Copy to the clipboard";
	copy.addEventListener("click", async () => {
		await crust.clipboard.write(code.textContent.replace(/\n$/, ""));
		copy.textContent = "Copied";
		setTimeout(() => (copy.textContent = "Copy"), 1200);
	});
	bar.append(copy);
	// On Windows the terminal is PowerShell: bash fences only get Run as a single line (multi-line bash usually
	// needs &&, export or $VAR).
	if (SHELL_LANGS.has(lang) && (!isWin || PS_LANGS.has(lang) || !shellCommand(code.textContent).includes("\r"))) {
		const run = el("button", "code-action run", "▶ Run");
		run.type = "button";
		run.title = "Run in the Terminal tab";
		run.addEventListener("click", async () => {
			const cmd = shellCommand(code.textContent);
			if (!cmd) return;
			await runInTerminal(cmd);
			run.textContent = "✓ Sent";
			setTimeout(() => (run.textContent = "▶ Run"), 1500);
		});
		bar.append(run);
	}
	const wrap = el("div", "code-block");
	pre.replaceWith(wrap);
	wrap.append(pre, bar);
}

let info = { repo: "", devUrl: "" };

// ===========================================================================
// Hook bus: feature scripts (notify.js, chat-find.js, ...) subscribe with onCrust(name, fn); renderer.js and
// sessions.js only emit. Events: turn:start(chat), turn:settled(chat,{aborted}), user:rendered(chat,node,message,history),
// assistant:turn(chat,root), text:final(chat,blockEl,raw), tool:end(chat,{toolName,toolCallId,args,result,isError,history}),
// chat:cleared(chat), chat:activated(chat), chat:closed(chat), models:loaded(chat,stateData), ask:added(chat,spec),
// changes:loaded(count,chatId,paths), rewind:restored(chat,{files,paths}).
// ===========================================================================
const crustHooks = new Map();
function onCrust(name, fn) {
	if (!crustHooks.has(name)) crustHooks.set(name, new Set());
	crustHooks.get(name).add(fn);
	return () => crustHooks.get(name).delete(fn);
}
function emitCrust(name, ...args) {
	for (const fn of [...(crustHooks.get(name) || [])]) {
		try {
			fn(...args);
		} catch (e) {
			console.error(`hook ${name} failed`, e);
		}
	}
}
// Extra steps for the self-test tour: async ({ snap, wait }) => {}, registered by feature scripts.
// Each step is named after the script that pushed it (timeline.js -> "timeline"), or push(fn, name).
// PI_CRUST_SELFTEST_ONLY / `npm run selftest -- timeline` runs only matching steps.
const selftestSteps = [];
selftestSteps.push = (fn, name) => {
	const caller = (new Error().stack || "").split("\n")[2] || "";
	fn.stepName = (name || (caller.match(/([\w-]+)\.js:\d+/) || [])[1] || "?").toLowerCase();
	return Array.prototype.push.call(selftestSteps, fn);
};
const selftestWants = (name) => !info?.selftestOnly?.length || info.selftestOnly.includes(name);

// --- live clocks: ONE 1 s interval for every running timer (tools, turns, tabs, subagents, terminal) ---
// startClock(node, since, paint?) — paint(node, text, ms) defaults to node.textContent = text.
// Disconnected nodes drop out on the next tick; the interval stops when nothing is left.
const liveClocks = new Map();
let clockTimer = 0;
function paintClock(node, c, now) {
	const ms = Math.max(0, now - c.since);
	const text = Duration.formatDuration(ms);
	try {
		c.paint ? c.paint(node, text, ms) : (node.textContent = text);
	} catch (e) {
		console.error("clock paint", e);
	}
}
function startClock(node, since, paint) {
	const c = { since, paint };
	liveClocks.set(node, c);
	paintClock(node, c, Date.now());
	if (!clockTimer) clockTimer = setInterval(tickClocks, 1000);
	return node;
}
function stopClock(node, finalText) {
	liveClocks.delete(node);
	if (finalText !== undefined) node.textContent = finalText;
}
function tickClocks() {
	const now = Date.now();
	for (const [n, c] of liveClocks) {
		if (!n.isConnected) liveClocks.delete(n);
		else paintClock(n, c, now);
	}
	if (!liveClocks.size) {
		clearInterval(clockTimer);
		clockTimer = 0;
	}
}
const refreshClocks = () => liveClocks.size && tickClocks();
selftestSteps.push(async () => {
	const stats = active.el.querySelectorAll(".turn-stats").length;
	const clocks = [...active.el.querySelectorAll(".tool .tclock")].filter((n) => n.textContent || n.title).length;
	const cards = active.el.querySelectorAll(".tool .tclock").length;
	console.error(`SELFTEST durations: turn-stats=${stats} tool-clocks=${clocks}/${cards} -> ${stats >= 1 && clocks === cards ? "OK" : "MISMATCH"}`);
}, "durations");

// ===========================================================================
// Layout: resizable side panes, browser view follows its slot.
// ===========================================================================
const layout = JSON.parse(localStorage.getItem("layout") || "{}");
if (layout.tree) $("#tree-pane").style.width = `${layout.tree}px`;
if (layout.chat) $("#chat-pane").style.width = `${layout.chat}px`;
if (layout.changes) $("#changes-list").style.width = `${layout.changes}px`;

for (const splitter of document.querySelectorAll(".splitter")) {
	splitter.addEventListener("pointerdown", (e) => {
		const leftId = splitter.dataset.left;
		const rightId = splitter.dataset.right;
		const pane = $(`#${leftId || rightId}`);
		const startX = e.clientX;
		const startW = pane.getBoundingClientRect().width;
		splitter.classList.add("dragging");
		splitter.setPointerCapture(e.pointerId);
		const move = (ev) => {
			const dx = ev.clientX - startX;
			const min = Math.max(180, parseFloat(getComputedStyle(pane).minWidth) || 0);
			const w = Math.max(min, Math.min(900, leftId ? startW + dx : startW - dx));
			pane.style.width = `${w}px`;
			syncBrowserBounds();
		};
		const up = () => {
			splitter.classList.remove("dragging");
			splitter.removeEventListener("pointermove", move);
			layout.tree = $("#tree-pane").getBoundingClientRect().width;
			layout.chat = $("#chat-pane").getBoundingClientRect().width;
			if (leftId === "changes-list") layout.changes = Math.round(pane.getBoundingClientRect().width);
			localStorage.setItem("layout", JSON.stringify(layout));
		};
		splitter.addEventListener("pointermove", move);
		splitter.addEventListener("pointerup", up, { once: true });
	});
}

function syncBrowserBounds() {
	const r = $("#browser-slot").getBoundingClientRect();
	crust.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(syncBrowserBounds).observe($("#browser-slot"));
window.addEventListener("resize", syncBrowserBounds);

// ===========================================================================
// Browser toolbar
// ===========================================================================
// Keep the dev browser's colour scheme and empty background in step with the app theme,
// so it isn't a white box in dark mode. Read the colour after the theme cross-fade.
let browserThemeTimer;
function syncBrowserTheme() {
	crust.browser.setTheme(themeSetting()); // colour scheme right away (also drives "system" in this UI)
	clearTimeout(browserThemeTimer);
	browserThemeTimer = setTimeout(() => {
		const clear = (c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c);
		let bg = "transparent";
		for (let n = $("#browser-slot"); n && clear(bg); n = n.parentElement) bg = getComputedStyle(n).backgroundColor;
		if (clear(bg)) bg = currentTheme() === "dark" ? "#1b1b1b" : "#eef0f0";
		crust.browser.setTheme(themeSetting(), bg);
	}, 360);
}
onThemeChange(syncBrowserTheme);
syncBrowserTheme();
for (const b of document.querySelectorAll(".browser-bar [data-action]")) {
	b.addEventListener("click", () => crust.browser.action(b.dataset.action));
}
$("#url-form").addEventListener("submit", (e) => {
	e.preventDefault();
	$("#browser-error").hidden = true;
	crust.browser.navigate($("#url").value);
});
// Element picker: runs in the page; each picked element becomes a pill above the composer.
// The full <browser-element> context is only added to the prompt when it is sent.
let picking = false;
async function pickElement() {
	if (picking) return crust.browser.pick(); // second press cancels the running pick
	picking = true;
	$("#pick-element").setAttribute("aria-pressed", "true");
	try {
		if (activeTab !== "browser") {
			switchTab("browser");
			await new Promise((r) => setTimeout(r, 150));
		}
		const r = await crust.browser.pick(window.crustDesign?.pickOpts());
		if (r.error) return toast(`Pick failed: ${r.error}`, "error");
		if (!r.items?.length) return;
		addPicks(r.items);
	} finally {
		picking = false;
		$("#pick-element").removeAttribute("aria-pressed");
	}
}
$("#pick-element").addEventListener("click", pickElement);

// Figma desktop picker: the current selection (via the Figma desktop MCP server) becomes a <figma-node> pill.
let figmaPicking = false;
async function pickFigma() {
	if (figmaPicking) return;
	figmaPicking = true;
	$("#pick-figma").setAttribute("aria-busy", "true");
	try {
		const r = await crust.figma.pickSelection();
		if (r.error) {
			toast(r.error, "error", r.needsFileLink ? { label: "Open Figma status", onClick: () => openFigmaPanel() } : undefined);
			if (r.needsFileLink) openFigmaPanel();
			else window.crustFigma?.recheck();
			return;
		}
		const id = (r.block.match(/node-id="([^"]*)"/) || [])[1];
		if (id && active?.picks.some((b) => typeof b === "string" && b.startsWith("<figma-node") && b.includes(`node-id="${id}"`))) return toast("Already added", "info");
		addPicks([r.block]);
	} catch (e) {
		toast(`Figma pick failed: ${e.message || e}. See Design › Figma status.`, "error");
		window.crustFigma?.recheck();
	} finally {
		figmaPicking = false;
		$("#pick-figma").removeAttribute("aria-busy");
	}
}
$("#pick-figma").addEventListener("click", pickFigma);
// Opens the Design tab with the Figma status panel (the picker needs the file link, set there).
function openFigmaPanel() {
	switchTab("design");
	window.crustFigma?.openPanel();
}
// The URL the embedded browser really has (the address bar can hold unsubmitted text); design captures use this one.
let liveBrowserUrl = "";
crust.browser.onState((s) => {
	liveBrowserUrl = s.url || "";
	if (document.activeElement !== $("#url")) $("#url").value = s.url || "";
	$('[data-action="back"]').disabled = !s.canGoBack;
	$('[data-action="forward"]').disabled = !s.canGoForward;
	if (s.loading) $("#browser-error").hidden = true;
});
crust.browser.onError((err) => {
	const box = $("#browser-error");
	box.replaceChildren(
		el("strong", "", "Can't load the page"),
		el("div", "", `${err.desc} (${err.code})`),
		el("div", "", err.url),
	);
	if (/localhost|127\.0\.0\.1/.test(err.url) && /REFUSED/i.test(err.desc)) {
		const hint = el("div");
		hint.append("Is the dev server running? Start it with ", el("code", "", "npm run dev"), " (or the repo's own command) in the Terminal tab, then reload.");
		box.append(hint);
	}
	box.hidden = false;
});

// ===========================================================================
// File tree
// ===========================================================================
let git = { branch: null, files: {} };
const expanded = new Set(); // per repo, filled by applyRepo()
let selectedPath = null;

function gitInfo(p, dir) {
	if (!dir) return git.files[p];
	const prefix = `${p}/`;
	for (const f in git.files) if (f.startsWith(prefix)) return "dirty";
	return undefined;
}

async function renderDir(container, rel, depth) {
	let entries;
	try {
		entries = await crust.fs.list(rel);
	} catch {
		return;
	}
	const frag = document.createDocumentFragment();
	for (const ent of entries) {
		const row = el("div", "node");
		row.tabIndex = 0;
		row.setAttribute("role", "treeitem");
		row.dataset.path = ent.path;
		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.title = ent.dir ? ent.path : `${ent.path}\nClick: open in the editor · Double-click: mention in chat · ${keyLabel("⌘-click")}: open in VS Code`;
		const twisty = el("span", "twisty", ent.dir ? (expanded.has(ent.path) ? "▾" : "▸") : "");
		const name = el("span", "name", ent.name);
		row.append(twisty, name);
		const g = gitInfo(ent.path, ent.dir);
		if (g) {
			if (ent.dir) row.classList.add("git-dirty");
			else {
				const code = g === "??" ? "U" : g.replace(/\s/g, "")[0] || "M";
				row.classList.add(g === "??" ? "git-untracked" : "git-dirty");
				row.append(el("span", `git git-${g === "??" ? "new" : code}`, code));
			}
		}
		if (ent.path === selectedPath) row.classList.add("selected");
		frag.append(row);
		if (ent.dir) {
			row.setAttribute("aria-expanded", String(expanded.has(ent.path)));
			const kids = el("div");
			kids.setAttribute("role", "group");
			frag.append(kids);
			if (expanded.has(ent.path)) renderDir(kids, ent.path, depth + 1);
			row._kids = kids;
		}
		row._ent = ent;
		row._depth = depth;
	}
	container.replaceChildren(frag);
}

function toggleDir(row) {
	const p = row._ent.path;
	if (expanded.has(p)) {
		expanded.delete(p);
		row._kids.replaceChildren();
	} else {
		expanded.add(p);
		renderDir(row._kids, p, row._depth + 1);
	}
	row.querySelector(".twisty").textContent = expanded.has(p) ? "▾" : "▸";
	row.setAttribute("aria-expanded", String(expanded.has(p)));
	localStorage.setItem(`expanded:${info.repo}`, JSON.stringify([...expanded]));
}

function select(row) {
	for (const r of document.querySelectorAll(".node.selected")) r.classList.remove("selected");
	row.classList.add("selected");
	selectedPath = row._ent.path;
}

function mention(p) {
	const input = $("#input");
	const pre = input.value && !/\s$/.test(input.value) ? " " : "";
	input.value += `${pre}\`${p}\` `;
	input.focus();
}

$("#tree").addEventListener("click", (e) => {
	const row = e.target.closest(".node");
	if (!row) return;
	select(row);
	if (row._ent.dir) toggleDir(row);
	else if (hasMod(e)) crust.fs.openInEditor(row._ent.path);
	else if (e.detail === 1) openFile(row._ent.path);
});
$("#tree").addEventListener("dblclick", (e) => {
	const row = e.target.closest(".node");
	if (row && !row._ent.dir) mention(row._ent.path);
});
$("#tree").addEventListener("keydown", (e) => {
	const row = e.target.closest(".node");
	if (!row) return;
	const rows = [...document.querySelectorAll("#tree .node")];
	const i = rows.indexOf(row);
	if (e.key === "ArrowDown" && rows[i + 1]) rows[i + 1].focus();
	else if (e.key === "ArrowUp" && rows[i - 1]) rows[i - 1].focus();
	else if (e.key === "ArrowRight" && row._ent.dir && !expanded.has(row._ent.path)) toggleDir(row);
	else if (e.key === "ArrowLeft" && row._ent.dir && expanded.has(row._ent.path)) toggleDir(row);
	else if (e.key === "Enter") {
		select(row);
		row._ent.dir ? toggleDir(row) : openFile(row._ent.path);
	} else return;
	e.preventDefault();
});

let treeDirty = false; // a change came in while the window was hidden: refresh once when it shows again
async function refreshTree() {
	if (document.hidden) return void (treeDirty = true);
	treeDirty = false;
	git = await crust.fs.gitStatus(true); // the tree always shows the main checkout
	$("#branch").textContent = git.branch ? `⎇ ${git.branch}` : "";
	await renderDir($("#tree"), "", 0);
}
$("#tree-refresh").addEventListener("click", refreshTree);
crust.fs.onChanged(refreshTree);
document.addEventListener("visibilitychange", () => treeDirty && refreshTree());

// ===========================================================================
// Chats: one Pi process per chat. The module-level names below (state, messages, tools, touched, pending,
// current, working, atBottom, renderQueued) are bound to ONE chat (`view`). Incoming records are handled
// inside withChat(chat, ...), which binds that chat for the duration of the (synchronous) handler, so
// background chats keep rendering into their own hidden messages container. `active` is the chat on screen.
// ===========================================================================
const chats = new Map(); // chatId -> chat
let active = null;
let view = null;
// Placeholders until the first chat exists.
let state = { streaming: false, ready: false, model: null, statuses: new Map(), widgets: new Map(), queue: { steering: [], followUp: [] }, held: [] };
let messages = el("div");
let tools = new Map();
let pending = new Map();
let current = null; // { root, blocks: Map<index, {kind, el, raw}> }
let working = null;
let atBottom = true;
let renderQueued = false;
let welcomeNotice = null;

function bind(c) {
	view = c;
	state = c.state;
	messages = c.el;
	tools = c.tools;
	touched = c.touched;
	pending = c.pending;
	current = c.current;
	working = c.working;
	atBottom = c.atBottom;
	renderQueued = c.renderQueued;
}
function unbind(c) {
	c.current = current;
	c.working = working;
	c.atBottom = atBottom;
	c.renderQueued = renderQueued;
}
function withChat(c, fn) {
	if (!c || view === c) return fn();
	const prev = view;
	if (prev) unbind(prev);
	bind(c);
	try {
		return fn();
	} finally {
		unbind(c);
		if (prev) bind(prev);
		else view = null;
	}
}

function makeChat(id, opts = {}) {
	const c = {
		id,
		el: el("div", "scroll messages"),
		state: { streaming: false, ready: false, model: null, statuses: new Map(), widgets: new Map(), queue: { steering: [], followUp: [] }, held: [] },
		tools: new Map(),
		touched: new Set(),
		pending: new Map(),
		current: null,
		turn: null, // { start, tools, running, last, ended } of the current Pi turn
		working: null,
		atBottom: true,
		renderQueued: false,
		label: opts.label || "",
		name: "",
		unread: false,
		dead: false,
		draft: "",
		picks: [], // picked <browser-element> blocks, shown as pills, sent with the next prompt
		modes: undefined, // permission-mode status text
		models: [],
		sessionFile: opts.sessionFile || null,
		agent: opts.agent || null, // { id, label, capabilities } from pi:started; nothing gates on it yet
		cwd: opts.cwd || null, // a git worktree of the repo (worktree.js), null = the repo itself
		branch: opts.branch || null,
		resume: !!opts.sessionFile, // replay the stored messages once Pi is ready
		waiters: [],
		asks: [], // Pi's open questions, shown above the composer
		stderrTail: "",
		scrollTop: 0,
	};
	c.el.hidden = true;
	c.el.addEventListener("scroll", () => {
		if (c.el.hidden) return;
		c.atBottom = c.el.scrollHeight - c.el.scrollTop - c.el.clientHeight < 40;
		if (view === c) atBottom = c.atBottom;
	});
	$("#messages-host").append(c.el);
	chats.set(id, c);
	if (!view) bind(c);
	if (welcomeNotice) {
		const text = welcomeNotice;
		welcomeNotice = null;
		withChat(c, () => addNotice(text));
	}
	return c;
}

const chatLabel = (c) => (c.name || c.label || "New chat").slice(0, 40);
const anyWorking = () => [...chats.values()].some((c) => c.state.streaming);

function renderTabs() {
	const strip = $("#chat-tabs");
	strip.replaceChildren(
		...[...chats.values()].map((c) => {
			const busy = c.state.streaming;
			const asking = c.asks.length > 0;
			const t = el("div", `chat-tab${asking ? " asking" : ""}${busy ? " busy" : ""}${c.unread && c !== active ? " unread" : ""}${c.dead ? " dead" : ""}`);
			t.setAttribute("role", "tab");
			t.setAttribute("aria-selected", String(c === active));
			t.title = chatLabel(c) + (asking ? " (waiting for your answer)" : busy ? " (working)" : c.dead ? " (stopped)" : "");
			t.append(el("span", "ct-state", asking ? "?" : busy ? "✻" : c.unread && c !== active ? "●" : c.dead ? "!" : ""));
			if (c.cwd) {
				const wt = window.worktreeBadge?.(c);
				if (wt) {
					t.append(wt);
					t.title += `\nWorktree ${c.branch || ""}`;
				}
			}
			const rb = window.crustRemote?.tabBadge?.(c);
			if (rb) {
				t.append(rb);
				t.title += " · shared with your phone";
			}
			t.append(el("span", "ct-label", chatLabel(c)));
			const base = t.title;
			if (busy && c.turn && !c.turn.ended) {
				const time = el("span", "ct-time");
				time.hidden = c === active; // the active chat has the working indicator
				startClock(time, c.turn.start, (n, txt) => {
					n.textContent = txt;
					const a = Duration.activityLabel(c.turn);
					t.title = `${base}\nWorking for ${txt}${a ? ` · ${a}` : ""}`;
				});
				t.append(time);
			}
			const x = el("button", "ct-close", "×");
			x.type = "button";
			x.title = "Close chat";
			x.onclick = (e) => {
				e.stopPropagation();
				closeChat(c);
			};
			t.append(x);
			t.onclick = () => activate(c);
			t.onauxclick = (e) => e.button === 1 && closeChat(c);
			return t;
		}),
	);
	strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
	window.crustRemote?.onActiveChat?.(); // the phone button shows whether the active chat is shared
}

function activate(c) {
	if (!c || !chats.has(c.id)) return;
	const rootChanged = (active?.cwd || null) !== (c.cwd || null);
	if (c === active) {
		$("#input").focus();
		return;
	}
	if (active) {
		active.draft = $("#input").value;
		active.scrollTop = active.el.scrollTop;
		active.el.hidden = true;
		unbind(view);
	}
	bind(c);
	active = c;
	crust.pi.activeChat(c.id);
	c.unread = false;
	c.el.hidden = false;
	$("#input").value = c.draft;
	renderPicks();
	c.el.scrollTop = c.atBottom ? c.el.scrollHeight : c.scrollTop;
	$("#stop").hidden = !state.streaming;
	$("#send").textContent = state.streaming ? "Queue" : "Send";
	$("#send").title = state.streaming ? keyLabel("Queue: Pi reads it when the run is done (⌥Enter steers right away)") : "";
	syncModeFromStatus(c.modes);
	renderAsk();
	renderQueue();
	renderModelSelect();
	renderStatus();
	window.renderContextMeter?.();
	renderTabs();
	document.title = c.name ? `Pi Crust — ${c.name}` : info.repo ? `Pi Crust — ${baseName(info.repo)}` : "Pi Crust";
	try {
		if (rootChanged) loadChanges(); // Changes follow the chat's worktree
		else renderChanges(); // the "files this chat changed" filter
	} catch {}
	$("#input").focus();
	emitCrust("chat:activated", c);
	window.crustRemote?.onActiveChat?.();
}

function cycleChat(dir) {
	const list = [...chats.values()];
	if (list.length < 2) return;
	activate(list[(list.indexOf(active) + dir + list.length) % list.length]);
}

async function closeChat(c) {
	if (c.state.streaming) {
		const ok = await showDialog({ method: "confirm", title: `“${chatLabel(c)}” is still working`, message: "Close it and stop the run?", yesLabel: "Close chat", danger: true });
		if (!ok.confirmed) return;
	}
	if (!chats.has(c.id)) return;
	const removeWorktree = c.cwd && window.worktreeAskRemove ? await window.worktreeAskRemove(c) : null; // null: keep it
	if (!chats.has(c.id)) return;
	const list = [...chats.values()];
	const next = list[list.indexOf(c) + 1] || list[list.indexOf(c) - 1];
	dropAsks(c);
	failPending(c, "Chat closed");
	settlePiWaiters(c, "Chat closed");
	const closed = crust.pi.closeChat(c.id);
	emitCrust("chat:closed", c);
	chats.delete(c.id);
	c.el.remove();
	if (view === c) {
		unbind(c);
		view = null;
	}
	if (active === c) active = null;
	if (next) activate(next);
	else await newChat();
	renderTabs();
	if (removeWorktree) closed.then(() => window.worktreeRemove?.(c, removeWorktree));
}

// Forget all chats (the repo changed; main has killed the processes).
function resetChats() {
	for (const c of chats.values()) {
		dropAsks(c);
		failPending(c, "Repo changed");
		settlePiWaiters(c, "Repo changed");
		c.el.remove();
	}
	chats.clear();
	active = null;
	view = null;
	renderTabs();
}

// A new chat: a new Pi process, shown in a new tab. Never touches the existing chats.
// opts.cwd / opts.branch: work in a git worktree of the repo (worktree.js).
async function newChat(sessionFile, label, opts = {}) {
	const file = typeof sessionFile === "string" ? sessionFile : undefined;
	const id = await crust.pi.newChat(file, opts.cwd ? { cwd: opts.cwd } : undefined);
	if (!id) return toast(opts.cwd ? "Couldn't start a chat in that worktree" : "Couldn't start a new chat (no repo open)", "error");
	const c = chats.get(id) || makeChat(id, { sessionFile: file, label: typeof label === "string" ? label : "", cwd: opts.cwd, branch: opts.branch });
	if (opts.cwd) {
		c.cwd = opts.cwd;
		c.branch = opts.branch || c.branch;
	}
	activate(c);
	renderTabs();
}

// Focus the tab that has this session file open, or open it in a new tab.
async function openSessionInTab(file, label, opts = {}) {
	for (const c of chats.values()) {
		let f = c.sessionFile;
		if (c.state.ready) {
			const st = await rpcTo(c, "get_state");
			if (st.success) f = st.data?.sessionFile || f;
		}
		if (f === file) return activate(c);
	}
	await newChat(file, label, opts);
}

// --- Pi RPC client -----------------------------------------------------------
let seq = 0;
const RPC_TIMEOUT_MS = 10 * 60_000; // abort and compaction can legitimately take a while
function rpcTo(c, type, extra = {}) {
	if (!c) return Promise.resolve({ success: false, error: "No chat" });
	const id = `ui-${++seq}`;
	return new Promise((resolve) => {
		const timer = setTimeout(() => settle({ success: false, error: `No answer from Pi to ${type}` }), RPC_TIMEOUT_MS);
		const settle = (r) => {
			clearTimeout(timer);
			c.pending.delete(id);
			resolve(r);
		};
		c.pending.set(id, settle);
		crust.pi.send(c.id, { id, type, ...extra }).then((ok) => {
			if (!ok) settle({ success: false, error: "Pi is not running" });
		});
	});
}
// RPC to the chat on screen (or the one being handled inside withChat).
const rpc = (type, extra) => rpcTo(view, type, extra);
// When Pi stops or restarts, nothing will answer the open requests: settle them so callers don't hang.
function failPending(c, error) {
	for (const settle of [...c.pending.values()]) settle({ success: false, error });
}

const scroll = () => {
	if (atBottom) messages.scrollTop = messages.scrollHeight;
};
function addNotice(text, cls = "notice") {
	messages.append(el("div", `msg ${cls}`, text));
	scroll();
}

// Setup (the welcome view) isn't built yet: this only announces the request. The welcome view listens for it:
//   window.addEventListener("crust:open-setup", (e) => open the view; e.detail = { source: "pi-missing" | "toast", chatId? })
function openSetup(source, chatId) {
	window.dispatchEvent(new CustomEvent("crust:open-setup", { detail: { source, chatId } }));
}
// A message was typed while Pi isn't ready: "starting" for a real start, "open setup" when Pi isn't installed.
function notReadyToast() {
	if (active?.piMissing) toast("Pi isn't running. Open setup.", "warning", { label: "Open setup", onClick: () => openSetup("toast", active.id) });
	else toast("Pi is still starting…", "warning");
}

// `action` ({ label, onClick }) adds a small button to the toast.
function toast(message, type = "info", action) {
	const t = el("div", `toast ${type}`, message);
	if (action) {
		const b = el("button", "btn tertiary toast-action", action.label);
		b.type = "button";
		b.onclick = () => {
			t.remove();
			action.onClick();
		};
		t.append(b);
	}
	$("#toasts").append(t);
	setTimeout(() => t.remove(), type === "error" ? 9000 : action ? 15000 : 5000);
}

// Notifications (#toasts) float on the right, over the chat, just above the composer (and above Pi's questions, the
// queue and the todos docked over it). With the chat pane hidden they sit in the bottom-right corner.
function placeToasts() {
	const box = $("#toasts");
	const pane = $("#chat-pane")?.getBoundingClientRect();
	if (!box) return;
	if (!pane?.width) return Object.assign(box.style, { right: "16px", bottom: "16px", maxWidth: "420px" });
	let top = $("#composer").getBoundingClientRect().top;
	for (const s of ["#todo-panel", "#ask", "#queue", "#first-task"]) {
		const r = $(s)?.getBoundingClientRect();
		if (r?.height) top = Math.min(top, r.top);
	}
	// Menus open in the toast column (slash, @, worktree, view, remote) sit in the chat pane's own stacking context or under the
	// toasts: the toasts stay above their top edge instead of over them, so a menu is never covered.
	const col = { left: pane.right - 16 - Math.min(420, pane.width - 32), right: pane.right - 16 };
	for (const m of document.querySelectorAll(".slash-menu:not([hidden])")) {
		const r = m.getBoundingClientRect();
		if (r.height && r.right > col.left && r.left < col.right && ($("#composer").contains(m) || r.top > innerHeight / 2)) top = Math.min(top, r.top); // a menu under the header button never pushes them off the top
	}
	Object.assign(box.style, { right: `${Math.max(8, innerWidth - pane.right + 16)}px`, bottom: `${Math.max(8, innerHeight - top + 8)}px`, maxWidth: `${Math.max(200, Math.min(420, pane.width - 32))}px` });
}
{
	const ro = new ResizeObserver(() => placeToasts());
	for (const s of ["#chat-pane", "#composer", "#todo-panel", "#ask", "#queue", "#first-task"]) if ($(s)) ro.observe($(s));
	if ($("#toasts")) new MutationObserver(() => placeToasts()).observe($("#toasts"), { childList: true });
	new MutationObserver(() => placeToasts()).observe(document.body, { childList: true }); // menus are added to the page and removed again
	if ($("#composer")) new MutationObserver(() => placeToasts()).observe($("#composer"), { childList: true, subtree: true, attributeFilter: ["hidden"] });
	addEventListener("resize", placeToasts);
	placeToasts();
}

// --- message rendering -----------------------------------------------------
const textOf = (content) =>
	typeof content === "string" ? content : (content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function renderUser(message, history = false) {
	const text = textOf(message.content);
	const images = Array.isArray(message.content) ? message.content.filter((c) => c.type === "image") : [];
	if (!text.trim() && !images.length) return;
	const { blocks, rest } = splitPicks(text);
	const node = el("div", "msg user");
	if (blocks.length || images.length) {
		const row = el("div", "pick-pills");
		for (const b of blocks) row.append(pickPill(b));
		images.forEach((img, i) => row.append(pickPill({ ...img, name: `image ${i + 1}` })));
		node.append(row);
	}
	if (rest) node.append(document.createTextNode(rest));
	messages.append(node);
	if (!view.label) {
		view.label = (rest || blocks.map((b) => pickInfo(b).label).join(", ") || "image").replace(/\s+/g, " ").trim();
		renderTabs();
	}
	atBottom = true;
	scroll();
	emitCrust("user:rendered", view, node, message, history);
}

function startAssistant() {
	const root = el("div", "msg assistant-turn");
	messages.append(root);
	current = { root, blocks: new Map() };
	emitCrust("assistant:turn", view, root);
	return current;
}

function block(index, kind) {
	if (!current) startAssistant();
	let b = current.blocks.get(index);
	if (b) return b;
	if (kind === "text") b = { kind, el: el("div", "msg assistant"), raw: "" };
	else if (kind === "thinking") {
		const d = el("details", "thinking");
		const sum = el("summary");
		sum.append(el("span", "thinking-label", "Thinking"), el("span", "thinking-preview"));
		d.append(sum, el("div", "thinking-body"));
		d.hidden = true; // shown once it has text (redacted/empty blocks stay hidden)
		b = { kind, el: d, raw: "" };
	} else return null;
	if (kind === "thinking") placeActivity(b.el);
	else current.root.append(b.el);
	current.blocks.set(index, b);
	return b;
}

// Thinking block: collapsed it shows a one-line preview (the latest line, so you
// can follow along while it streams); open it shows the full text.
function renderThinking(b) {
	const text = b.raw.trim();
	b.el.hidden = !text;
	const body = b.el.querySelector(".thinking-body");
	const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
	body.textContent = b.raw;
	if (stick) body.scrollTop = body.scrollHeight;
	const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	const line = lines[lines.length - 1] || ""; // usually "now let me…", i.e. why the next tool runs
	b.el.querySelector(".thinking-preview").textContent = line.replace(/[*_`#]+/g, "");
}

function flushRender() {
	renderQueued = false;
	if (!current) return;
	for (const b of current.blocks.values()) {
		if (!b.dirty) continue;
		b.dirty = false;
		if (b.kind === "text") {
			b.el.replaceChildren(md(b.raw));
			if (b.final) emitCrust("text:final", view, b.el, b.raw);
		} else renderThinking(b);
	}
	scroll();
}
const queueRender = () => {
	if (!renderQueued) {
		renderQueued = true;
		const c = view;
		requestAnimationFrame(() => withChat(c, flushRender));
	}
};

// --- tool cards --------------------------------------------------------------
function toolSummary(name, args = {}) {
	if (name === "bash") return args.command || "";
	if (["read", "edit", "write", "ls", "find", "grep"].includes(name)) return args.path || args.pattern || "";
	if (name === "subagent") {
		if (args.agent) return `${args.agent}: ${args.task || ""}`;
		if (args.tasks) return `${args.tasks.length} in parallel: ${args.tasks.map((t) => t.agent).join(", ")}`;
		if (args.chain) return `chain: ${args.chain.map((t) => t.agent).join(" → ")}`;
	}
	if (name === "codemode") return (args.code || "").split("\n").find((l) => l.trim() && !l.startsWith("//")) || "";
	const first = Object.values(args).find((v) => typeof v === "string");
	return first || "";
}

const TOOL_LABEL = { read: "Read", bash: "Bash", edit: "Edit", write: "Write", subagent: "Subagent", codemode: "Code", todo: "Todo", question: "Question" };

// --- tool groups ---------------------------------------------------------------
// A run of tool calls (and the thinking between them) with no answer text in between
// goes into one .tool-group. From GROUP_MIN tool calls on, the group collapses behind a
// one-line header ("12 tool calls · Write ×6, figma_execute ×6"); below that it shows
// its cards as before. Runs span assistant messages: Pi sends one message per call.
const GROUP_MIN = 3;
const STANDALONE_TOOLS = new Set(["subagent", "question"]); // never hidden in a group
const shortToolName = (name) => TOOL_LABEL[name] || name.replace(/^mcp__/, "").split("__").pop();

// Nothing visible: lets a group continue past empty assistant turns, hidden thinking etc.
function isQuiet(n) {
	if (n === working || n.hidden) return true;
	if (n.classList.contains("assistant-turn")) return [...n.children].every(isQuiet);
	return false;
}
// The last group in the chat, if nothing visible came after it.
function openToolGroup() {
	const all = messages.querySelectorAll(":scope > .assistant-turn > .tool-group");
	const g = all[all.length - 1];
	if (!g) return null;
	for (let n = g; n && n !== messages; n = n.parentElement) {
		for (let s = n.nextElementSibling; s; s = s.nextElementSibling) if (!isQuiet(s)) return null;
	}
	return g;
}
function placeActivity(node) {
	if (!current) startAssistant();
	let g = openToolGroup();
	if (!g) {
		g = el("details", "tool-group");
		g.open = true; // ungrouped: the summary is hidden and the cards show as usual
		const s = el("summary");
		s.append(el("span", "dot"), el("span", "tname"), el("span", "targ"), el("span", "tmeta"));
		g.append(s, el("div", "tg-body"));
		current.root.append(g);
	}
	g.lastElementChild.append(node);
}
// Recount a group's header; pass the group or any card in it.
function updateToolGroup(node) {
	const g = node?.closest?.(".tool-group");
	if (!g) return;
	const cards = [...g.querySelectorAll(":scope > .tg-body > .tool")];
	if (cards.length < GROUP_MIN) return;
	if (!g.classList.contains("grouped")) {
		g.classList.add("grouped");
		g.open = false; // collapse once; after that the user decides
	}
	const counts = new Map();
	for (const c of cards) {
		const n = c._toolName || "tool";
		counts.set(n, (counts.get(n) || 0) + 1);
	}
	const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([n, k]) => (k > 1 ? `${shortToolName(n)} ×${k}` : shortToolName(n)));
	const breakdown = parts.length > 4 ? `${parts.slice(0, 4).join(", ")} +${parts.length - 4} more` : parts.join(", ");
	const running = cards.some((c) => c.classList.contains("running"));
	const failed = cards.filter((c) => c.classList.contains("err")).length;
	g.classList.toggle("running", running);
	g.classList.toggle("err", !running && failed > 0);
	g.classList.toggle("ok", !running && !failed);
	const s = g.firstElementChild;
	s.querySelector(".tname").textContent = `${cards.length} tool calls`;
	s.querySelector(".targ").textContent = breakdown;
	s.querySelector(".targ").title = breakdown;
	s.querySelector(".tmeta").textContent = failed ? `${failed} failed` : "";
}

function toolCard(id, name, args) {
	let t = tools.get(id);
	if (!t) {
		const d = el("details", "tool running");
		d._toolName = name;
		const s = el("summary");
		const nameEl = el("span", "tname", TOOL_LABEL[name] || name.replace(/^mcp__/, "").replace(/__/g, " › "));
		const argEl = el("span", "targ");
		const meta = el("span", "tmeta");
		const clock = el("span", "tclock");
		s.append(el("span", "dot"), nameEl, argEl, meta, clock);
		d.append(s);
		if (!current) startAssistant();
		if (STANDALONE_TOOLS.has(name)) current.root.append(d);
		else placeActivity(d);
		t = { d, argEl, meta, clock, name, out: null, args: undefined, started: 0 };
		tools.set(id, t);
		updateToolGroup(d);
	}
	if (args) {
		t.args = args;
		const summary = toolSummary(name, args);
		t.argEl.textContent = summary;
		t.argEl.title = summary;
	}
	scroll();
	return t;
}

function setToolOutput(t, result, isError) {
	const text = textOf(result?.content).trim();
	const diff = result?.details?.diff;
	if (!t.out) {
		t.out = el("pre");
		t.d.append(t.out);
	}
	if (diff && !isError) {
		t.out.replaceChildren(
			...diff.split("\n").slice(0, 400).map((line) => {
				const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
				return el("span", cls, `${line}\n`);
			}),
		);
		let add = 0, del = 0;
		for (const l of diff.split("\n")) {
			if (l.startsWith("+") && !l.startsWith("+++")) add++;
			else if (l.startsWith("-") && !l.startsWith("---")) del++;
		}
		return `+${add} −${del}`;
	}
	t.out.textContent = text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length - 8000} more characters)` : text;
	const lines = text ? text.split("\n").length : 0;
	return lines ? `${lines} line${lines === 1 ? "" : "s"}` : "";
}

// --- working indicator ------------------------------------------------------------
function setWorking(on) {
	state.streaming = on;
	if (view === active) {
		$("#stop").hidden = !on;
		$("#send").textContent = on ? "Queue" : "Send";
		$("#send").title = on ? keyLabel("Queue: Pi reads it when the run is done (⌥Enter steers right away)") : "";
	}
	renderTabs();
	if (on && !working) {
		working = el("div", "working");
		const label = el("span", "w-label", "Working"), clock = el("span", "w-clock"), act = el("span", "w-act");
		working.append(dotsOrbit(), label, clock, act);
		working._clock = clock;
		working._act = act;
		messages.append(working);
		scroll();
	} else if (!on && working) {
		stopClock(working._clock);
		working.remove();
		working = null;
	}
	if (on && working) {
		const c = view, w = working;
		startClock(w._clock, c.turn?.start ?? Date.now(), (n, txt) => {
			n.textContent = txt;
			const a = Duration.activityLabel(c.turn);
			w._act.textContent = a ? `· ${a}` : "";
		});
	}
}
// Three dots turning in 4D space (the working-3d Pi extension only draws in the terminal:
// RPC mode ignores setWorkingIndicator). The dots sit on a circle in 4D that keeps
// rotating in several planes at once (XY, ZW, XW, YZ) at different speeds. They are projected
// 4D -> 3D -> 2D with perspective; depth (both z and w) is shown with size and brightness.
// The path is sampled once into CSS @keyframes (transform + opacity only), so the browser runs it
// on the compositor with no JS per frame, and nothing runs while the chat is hidden or detached.
// The keyframes hold only plain numbers (translate in % of the R×R dot box, no var()/calc()): keyframes with
// CSS variables can't run on the compositor, so the dots stuttered whenever the renderer was busy streaming.
// Rotation speeds are whole numbers of turns per loop, so the loop is seamless.
const ORBIT_LOOP = 12; // seconds
const ORBIT_SAMPLES = 120;
let orbitSheet = false;
function orbitCss() {
	const w = (2 * Math.PI) / ORBIT_LOOP;
	const rot = (v, i, j, a) => {
		const c = Math.cos(a), s = Math.sin(a), vi = v[i], vj = v[j];
		v[i] = vi * c - vj * s;
		v[j] = vi * s + vj * c;
	};
	let css = "";
	for (let d = 0; d < 3; d++) {
		const a0 = (d * Math.PI * 2) / 3;
		css += `@keyframes orbit-${d} {`;
		for (let n = 0; n <= ORBIT_SAMPLES; n++) {
			const t = (n / ORBIT_SAMPLES) * ORBIT_LOOP;
			const v = [Math.cos(a0), Math.sin(a0), 0, 0];
			rot(v, 0, 1, t * 4 * w); // XY: the dots chase each other
			rot(v, 2, 3, t * 2 * w); // ZW
			rot(v, 0, 3, t * 2 * w + 0.4); // XW: tips the circle into the 4th dimension
			rot(v, 1, 2, t * w + 1.1); // YZ
			rot(v, 1, 3, Math.sin(t * w) * 1.2); // YW: slow wobble
			const k4 = 2.4 / (2.4 - v[3]);
			const x = v[0] * k4, y = v[1] * k4, z = v[2] * k4;
			const k3 = 3 / (3 - z);
			const near = Math.max(0, Math.min(1, ((v[3] + z) / 2 + 1) / 2));
			css += `${((n / ORBIT_SAMPLES) * 100).toFixed(3)}%{transform:translate(${(x * k3 * 100).toFixed(2)}%,${(y * k3 * 0.85 * 100).toFixed(2)}%) scale(${(0.45 + 0.4 * k4 * k3).toFixed(3)});opacity:${(0.3 + 0.7 * near).toFixed(3)}}`;
		}
		css += "}";
	}
	return css;
}
function dotsOrbit() {
	if (!orbitSheet) {
		orbitSheet = true;
		const st = document.createElement("style");
		st.textContent = orbitCss();
		document.head.append(st);
	}
	const box = el("span", "orbit");
	box.append(...[0, 1, 2].map((i) => el("span", `orbit-dot orbit-dot-${i}`)));
	return box;
}
// Moves the nodes added after the indicator to before it, instead of re-appending the indicator itself:
// taking it out of the DOM restarts its CSS animation, which made the dots jump back and stutter on every new message.
function keepWorkingLast() {
	if (!working) return;
	if (working.parentNode !== messages) return void messages.append(working);
	while (working.nextSibling) messages.insertBefore(working.nextSibling, working);
}

// --- status line --------------------------------------------------------------------
function renderStatus() {
	if (!view || view !== active) return;
	const parts = [];
	if (!state.ready) parts.push("Starting Pi…");
	for (const [k, v] of state.statuses) if (v && !["permission-mode", "crust-context", "copilot-usage"].includes(k)) parts.push(v.replace(/\x1b\[[0-9;]*m/g, ""));
	$("#status-line").replaceChildren(...parts.map((p) => el("span", "", p)));
	$("#widgets").textContent = [...state.widgets.values()].map((l) => l.join("\n")).join("\n");
}

// --- event handling ------------------------------------------------------------------
// Ends the current turn once: stops tool clocks and adds the "Worked …" line. Runs inside withChat.
function finishTurn(chat) {
	const turn = chat.turn;
	if (!turn || turn.ended) return;
	turn.ended = true;
	for (const t of tools.values()) {
		if (t.clock && t.d.classList.contains("running")) stopClock(t.clock);
		t.subBox?.querySelectorAll(".sub-clock").forEach((n) => stopClock(n));
		if (t.subProg) t.subProg.hidden = true;
	}
	if (working?._clock) stopClock(working._clock); // the "Worked …" line takes over
	renderStatus();
	const ms = Date.now() - turn.start;
	if (ms < 1000 && !turn.tools) return;
	const n = el("div", "turn-stats", Duration.turnSummary({ ms, tools: turn.tools, aborted: !!chat.aborted }));
	n.title = `Started ${new Date(turn.start).toLocaleTimeString()}`;
	messages.append(n);
	keepWorkingLast();
	scroll();
}

function handleRecord(r) {
	const chat = view;
	switch (r.type) {
		case "response": {
			const resolve = pending.get(r.id);
			if (resolve) {
				pending.delete(r.id);
				resolve(r);
			}
			return;
		}
		case "agent_start":
			chat.aborted = false;
			if (!chat.turn || chat.turn.ended) chat.turn = { start: Date.now(), tools: 0, running: 0, last: "", ended: false };
			setWorking(true);
			renderStatus();
			emitCrust("turn:start", chat);
			return;
		case "agent_end":
			finishTurn(chat);
			return;
		case "queue_update":
			state.queue = { steering: r.steering || [], followUp: r.followUp || [] };
			if (chat === active) renderQueue();
			return;
		case "agent_settled":
			finishTurn(chat);
			chat.turn = null;
			setWorking(false);
			renderStatus();
			current = null;
			if (chat !== active) {
				chat.unread = true;
				renderTabs();
			}
			emitCrust("turn:settled", chat, { aborted: !!chat.aborted });
			if (info.selftest && !selftestTouring) {
				selftestTouring = true;
				runSelftestTour();
			}
			return;
		case "message_start":
			if (r.message.role === "user") renderUser(r.message);
			else if (r.message.role === "assistant") startAssistant();
			keepWorkingLast();
			return;
		case "message_update": {
			const ev = r.assistantMessageEvent;
			if (ev.type === "text_delta" || ev.type === "thinking_delta") {
				const b = block(ev.contentIndex, ev.type === "text_delta" ? "text" : "thinking");
				b.raw += ev.delta;
				b.dirty = true;
				queueRender();
			} else if (ev.type === "text_end" || ev.type === "thinking_end") {
				const b = block(ev.contentIndex, ev.type === "text_end" ? "text" : "thinking");
				if (typeof ev.content === "string") b.raw = ev.content;
				if (ev.type === "text_end") b.final = true;
				b.dirty = true;
				queueRender();
			} else if (ev.type === "toolcall_start") {
				toolCard(ev.id, ev.toolName);
			} else if (ev.type === "toolcall_end") {
				toolCard(ev.toolCall.id, ev.toolCall.name, ev.toolCall.arguments);
			}
			keepWorkingLast();
			return;
		}
		case "message_end": {
			const m = r.message;
			if (m.role === "assistant") {
				if (m.stopReason === "error" || m.errorMessage) addNotice(m.errorMessage || "The model returned an error.", "error");
				else if (m.stopReason === "aborted") {
					chat.aborted = true;
					addNotice("Stopped.");
				}
				flushRender();
			} else if (m.role === "custom" && m.display !== false) {
				const text = textOf(m.content);
				if (text) addNotice(text);
			}
			keepWorkingLast();
			return;
		}
		case "tool_execution_start": {
			const t = toolCard(r.toolCallId, r.toolName, r.args);
			if ((r.toolName === "edit" || r.toolName === "write") && r.args?.path) touched.add(relPath(r.args.path));
			if (r.toolName === "subagent") t.d.open = true;
			t.started = Date.now();
			t.clock.title = `Running since ${new Date(t.started).toLocaleTimeString()}`;
			startClock(t.clock, t.started);
			if (chat.turn) {
				chat.turn.tools++;
				chat.turn.running++;
				chat.turn.last = `${TOOL_LABEL[r.toolName] || r.toolName.replace(/^mcp__/, "")} ${toolSummary(r.toolName, r.args)}`.trim().slice(0, 80);
			}
			refreshClocks();
			return;
		}
		case "tool_execution_update": {
			const t = toolCard(r.toolCallId, r.toolName, r.args);
			if (r.toolName === "subagent" && r.partialResult?.details?.results) renderSubagents(t, r.partialResult.details, false);
			else setToolOutput(t, r.partialResult, false);
			return;
		}
		case "tool_execution_end": {
			const t = toolCard(r.toolCallId, r.toolName, r.args);
			t.d.classList.remove("running");
			t.d.classList.add(r.isError ? "err" : "ok");
			const summary =
				r.toolName === "subagent" && r.result?.details?.results ? renderSubagents(t, r.result.details, true) : setToolOutput(t, r.result, r.isError);
			if (r.toolName === "edit" || r.toolName === "write") refreshChangesSoon();
			t.meta.textContent = summary;
			const ms = r.durationMs ?? (t.started ? Date.now() - t.started : undefined);
			stopClock(t.clock, ms >= 100 ? Duration.formatDuration(ms, { precise: true }) : "");
			if (ms != null) t.clock.title = `Took ${Duration.formatDuration(ms, { precise: true })}`;
			if (chat.turn) chat.turn.running = Math.max(0, chat.turn.running - 1);
			refreshClocks();
			if (r.isError) t.d.open = true;
			updateToolGroup(t.d);
			emitCrust("tool:end", chat, { toolName: r.toolName, toolCallId: r.toolCallId, args: r.args, result: r.result, isError: !!r.isError, history: false });
			return;
		}
		case "auto_retry_start":
			addNotice(`Retrying (${r.attempt}/${r.maxAttempts}): ${r.errorMessage}`);
			return;
		case "compaction_start":
			addNotice("Compacting the conversation…");
			return;
		case "compaction_end":
			addNotice(r.result ? "Conversation compacted." : `Compaction ${r.aborted ? "stopped" : "failed"}${r.errorMessage ? `: ${r.errorMessage}` : ""}.`);
			return;
		case "extension_error":
			// The permission extension failed: nothing is enforced any more, so the selector must say so.
			if (/permission-modes/i.test(String(r.extensionPath || ""))) {
				chat.modes = undefined;
				if (chat === active) syncModeFromStatus(undefined);
			}
			toast(`Extension error (${baseName(r.extensionPath)}): ${r.error}`, "error");
			return;
		case "extension_ui_request":
			handleUiRequest(r);
			return;
		case "session_info_changed":
			chat.name = r.name || "";
			if (chat === active) document.title = r.name ? `Pi Crust — ${r.name}` : "Pi Crust";
			renderTabs();
			return;
	}
}

// --- self-test tour: visit every feature and take a screenshot of each ----------------------
let selftestTouring = false;
async function runSelftestTour() {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const snap = (name) => crust.selftest.capture(name);
	const only = info?.selftestOnly || [];
	if (only.length) {
		const known = ["core", ...new Set(selftestSteps.map((s) => s.stepName))];
		const unknown = only.filter((n) => !known.includes(n));
		console.error(`SELFTEST only: ${only.join(",")}${unknown.length ? ` -> MISMATCH unknown ${unknown.join(",")} (known: ${known.join(",")})` : ""}`);
	}
	try {
		await snap("chat");
		if (selftestWants("core")) {
			await runCoreTour(wait, snap);
		}
		for (const step of selftestSteps) {
			if (!selftestWants(step.stepName)) continue;
			$("#toasts")?.replaceChildren(); // a toast one step caused on purpose must not show in the next step's screenshots
			try {
				await step({ snap, wait });
			} catch (e) {
				console.error(`selftest step ${step.stepName} failed`, e);
			}
		}
	} catch (e) {
		console.error("tour failed", e);
	}
	crust.selftest.done();
}

// The built-in part of the tour ("core"): context panel, changes, theme, terminal, editor, palette, tabs, layout, zoom.
async function runCoreTour(wait, snap) {
	{
		{
			const meter = $("#ctx-meter");
			console.error(`SELFTEST model+usage pill: "${meter.textContent}" models=${active?.models.length} -> ${meter.hidden || !active?.models.length ? "MISSING" : "OK"}`);
			if (!meter.hidden) {
				meter.click();
				await wait(1200);
				await snap("context-panel");
				// The popover scrolls when it's taller than the window: also show its lower half.
				const panel = $("#ctx-panel");
				if (panel && panel.scrollHeight > panel.clientHeight) {
					panel.scrollTop = panel.scrollHeight;
					await wait(500);
					panel.scrollTop = panel.scrollHeight; // again, in case a refresh re-rendered it
					await snap("context-panel-bottom");
				}
				closeContextPanel();
			}
		}
		switchTab("changes");
		await wait(1500);
		const first = document.querySelector(".change");
		if (first) first.click();
		await wait(2500);
		await snap("changes");
		if (first) {
			// Editable diff: type on the right side (no save), check it's dirty, then undo.
			const mod = chDiff?.getModifiedEditor();
			mod?.focus();
			mod?.trigger("selftest", "type", { text: "x" });
			await wait(300);
			const dirty = !!chModified()?.dirty;
			await snap("changes-edit");
			mod?.trigger("selftest", "undo");
			await wait(300);
			await chCopy();
			await wait(300);
			console.error(`SELFTEST changes copy: clipboard written (check with pbpaste)`);
			console.error(`SELFTEST changes diff editor: path=${chPath} visible=${!$("#diff-editor-host").hidden} toolbar=${!$("#diff-toolbar").hidden} dirty=${dirty} clean-after-undo=${!chModified()?.dirty} -> ${chPath && dirty && !chModified()?.dirty ? "OK" : "MISMATCH"}`);
		}
		{
			const was = themeSetting();
			setTheme("light");
			await wait(400);
			console.error(`SELFTEST theme: data-theme=${document.documentElement.dataset.theme} bg=${getComputedStyle(document.body).backgroundColor} -> ${document.documentElement.dataset.theme === "light" ? "OK" : "MISMATCH"}`);
			await snap("changes-light");
			setTheme(was);
		}
		switchTab("terminal");
		await wait(2500);
		await crust.term.input(termActive, "echo pi-crust-terminal-ok && node -v\r");
		await wait(2000);
		await snap("terminal");
		{
			// Editor: open a file from the tree, type into it (no save), check it is dirty, then discard.
			const rows = [...document.querySelectorAll("#tree .node")].filter((r) => !r._ent.dir);
			const row = rows.find((r) => /\.(json|[jt]sx?)$/.test(r._ent.path)) || rows[0];
			if (row) {
				row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
				await wait(4000);
				const f = edFiles.get(row._ent.path);
				edEditor?.trigger("selftest", "type", { text: "x" });
				await wait(500);
				await snap("editor");
				console.error(`SELFTEST editor: ${row._ent.path} model=${!!f?.model} lang=${f?.model?.getLanguageId()} dirty=${edDirty(f)} -> ${f?.model && edDirty(f) ? "OK" : "MISMATCH"}`);
				await edClose(row._ent.path, true);
			}
		}
		switchTab("browser");
		await openPalette("pack");
		await wait(2500);
		await snap("palette");
		closePalette();
		openHistory();
		await wait(2000);
		await snap("history");
		$("#modal-backdrop .modal-actions button")?.click();
		{
			// A second chat in a new tab, then back to the first one.
			const first = active;
			await newChat();
			await wait(3500);
			await snap("chat-tabs");
			const n = chats.size;
			activate(first);
			console.error(`SELFTEST chat tabs: ${n} chats, first kept ${first.el.childElementCount} nodes -> ${n === 2 && first.el.childElementCount > 0 ? "OK" : "MISMATCH"}`);
			await closeChat([...chats.values()].find((c) => c !== first));
		}
		await setMode("plan");
		await wait(2500);
		await snap("mode-plan");
		await setMode("trusted");
		await wait(1500);
		// Commit graph: click the newest commit to open it in Changes.
		document.querySelectorAll(".commit")[1]?.click(); // a merge commit in most repos
		await wait(1500);
		await snap("commit");
		switchTab("browser");
		// Repo picker.
		await openRepoPicker();
		await wait(2500);
		await snap("picker");
		closeRepoPicker();
		// Terminal at the bottom, then without side panels.
		setBottom(true);
		await wait(2000);
		await snap("bottom-terminal");
		const widthsBefore = [$("#tree-pane").offsetWidth, $("#chat-pane").offsetWidth];
		setPane("left", false);
		setPane("right", false);
		await wait(110);
		await snap("panels-closing");
		await wait(900);
		await snap("panels-hidden");
		setPane("left", true);
		setPane("right", true);
		await wait(120);
		setPane("right", false); // reverse mid-way
		await wait(60);
		setPane("right", true);
		await wait(600);
		const widthsAfter = [$("#tree-pane").offsetWidth, $("#chat-pane").offsetWidth];
		console.error(`SELFTEST panel motion: ${widthsBefore} -> ${widthsAfter} -> ${String(widthsBefore) === String(widthsAfter) && !document.querySelector(".panel-animating") ? "OK" : "MISMATCH"}`);
		setBottom(false);
		// Zoom: the browser view must stay inside its slot.
		await crust.selftest.zoom(1.5);
		await wait(1500);
		await snap("zoomed");
		{
			// The native browser view must cover exactly the slot, scaled by the zoom factor. (Hidden by "error" is fine: no dev server on the start URL.)
			const { view, z, visible, hidden } = await crust.selftest.bounds();
			const r = $("#browser-slot").getBoundingClientRect();
			const off = Math.max(Math.abs(view.x - r.left * z), Math.abs(view.y - r.top * z), Math.abs(view.width - r.width * z), Math.abs(view.height - r.height * z));
			console.error(`SELFTEST zoom check: factor ${z.toFixed(2)}, view ${JSON.stringify(view)}, slot*z off by ${off.toFixed(1)}px, visible=${visible}${hidden.length ? ` (hidden: ${hidden})` : ""} -> ${off <= 2 && (visible || hidden.every((h) => h === "error")) ? "OK" : "MISMATCH"}`);
		}
		await crust.selftest.zoom(0);
		await wait(800);
	}
}

// --- dialogs: one queue for Pi's extension dialogs and the app's own -------------------------
// spec: { method: "select"|"confirm"|"input"|"editor"|"custom", title, message, options, placeholder, prefill,
//         timeout, render(modal, finish) } -> Promise<{ value } | { confirmed } | { cancelled: true }>
const dialogQueue = [];
let dialogOpen = false;

function showDialog(spec) {
	return new Promise((resolve) => {
		dialogQueue.push({ spec, resolve });
		pumpDialogs();
	});
}

// A permission prompt's title: question, reason lines, the exact text, "Mode: ...". The text is plain text, never HTML.
const PERM_REASON = /^(This file can |This name is a Windows device name|This text has hidden characters|This is a network path|The project folder is |Pi Crust could not read |The computer may send |Resolves to )/;
const PERM_LONG = /^This (command|path|tool call) is [\d,.]+ characters long/;
const PERM_KEY_GUARD_MS = 500;
function parsePermTitle(title) {
	const lines = title.split("\n");
	const question = lines.shift();
	const mode = lines.length && /^Mode: /.test(lines[lines.length - 1]) ? lines.pop() : "";
	let longKind = "";
	const reasons = [];
	while (lines.length && (PERM_REASON.test(lines[0]) || PERM_LONG.test(lines[0]))) {
		const m = lines[0].match(PERM_LONG);
		if (m) longKind = m[1];
		else reasons.push(lines[0]);
		lines.shift();
	}
	while (lines.length > 1 && (PERM_REASON.test(lines[lines.length - 1]) || PERM_LONG.test(lines[lines.length - 1]))) {
		const m = lines[lines.length - 1].match(PERM_LONG);
		if (m) longKind = m[1];
		else reasons.push(lines[lines.length - 1]);
		lines.pop();
	}
	return { question, reasons, detail: lines.join("\n"), mode, longKind };
}
// Text with the visible markers for hidden characters (⟨U+202E⟩, ⟨TAB⟩, ⟨400 spaces⟩) set apart from the rest.
function markedText(text) {
	const out = el("pre", "ask-text");
	let last = 0;
	for (const m of text.matchAll(/⟨[^⟩\n]{1,40}⟩/g)) {
		if (m.index > last) out.append(text.slice(last, m.index));
		out.append(el("span", "ask-mark", m[0]));
		last = m.index + m[0].length;
	}
	if (last < text.length) out.append(text.slice(last));
	return out;
}

// Fills `box` with the controls for one dialog spec; `finish(response)` answers it.
function fillDialog(box, r, finish) {
	// A permission prompt ("Allow once" ...): the question, the exact thing to approve in a scrollable monospace block, the mode below.
	// It offers only its own answers (no Cancel): Esc, closing and a timeout all count as Deny.
	// The highlighted answer is always the focused one (so Enter does what the screen suggests). An ordinary prompt opens on "Allow once";
	// a risky one (protected file, outside the project folder, long text: the ones with a warning line) opens on "Deny".
	// For the first PERM_KEY_GUARD_MS, Enter, Space and the arrows do nothing, so a key meant for the message box can't answer it.
	const perm = r.method === "select" && Array.isArray(r.options) && r.options.includes("Allow once") && r.options.includes("Deny") && typeof r.title === "string";
	const parts = perm ? parsePermTitle(r.title) : null;
	const risky = !!parts && (parts.reasons.length > 0 || !!parts.longKind || /OUTSIDE/.test(parts.question) || !r.options.includes("Allow for this chat"));
	const openedAt = performance.now();
	const guarded = () => perm && performance.now() - openedAt < PERM_KEY_GUARD_MS;
	box.classList.toggle("perm", !!parts);
	box.classList.toggle("risky", risky);
	if (parts && (parts.detail || parts.reasons.length || parts.longKind)) {
		box.replaceChildren(el("h2", "", parts.question));
		if (parts.reasons.length) box.append(el("p", "ask-reason", parts.reasons.join("\n")));
		const detail = el("div", `ask-detail${parts.longKind ? " long" : ""}`);
		detail.append(markedText(parts.detail));
		if (parts.longKind) {
			detail.append(el("div", "ask-end", `End of ${parts.longKind}`));
			detail.tabIndex = 0; // reachable and scrollable from the keyboard
			detail.setAttribute("role", "region");
			detail.setAttribute("aria-label", `Full ${parts.longKind} to approve`);
		}
		box.append(detail);
		if (parts.mode) box.append(el("div", "ask-mode", parts.mode));
		if (parts.longKind) box.append(el("div", "ask-long", `Long ${parts.longKind}: scroll to read all of it.`));
	} else box.replaceChildren(el("h2", "", r.title || "Pi asks"));
	if (r.message) box.append(el("p", "", r.message));
	const actions = el("div", "modal-actions");
	const cancel = el("button", "secondary", r.cancelLabel || "Cancel");
	cancel.type = "button";
	cancel.onclick = () => finish({ cancelled: true });

	if (r.method === "custom") {
		actions.append(cancel);
		r.render(box, finish, actions); // may add its own buttons after Cancel
	} else if (r.method === "select") {
		const list = el("div", "options");
		for (const opt of r.options || []) {
			const b = el("button", perm ? (opt === "Allow once" ? "ask-allow" : opt === "Deny" ? "ask-deny" : "ask-alt") : "", opt);
			b.type = "button";
			// A click from the keyboard has no pointer (detail 0): inside the guard it is ignored. Mouse clicks are never delayed.
			b.onclick = (e) => {
				if (e.detail === 0 && guarded()) return;
				finish({ value: opt });
			};
			list.append(b);
		}
		box.append(list);
		if (!perm) actions.append(cancel);
	} else if (r.method === "confirm") {
		const no = el("button", "secondary", r.noLabel || "No");
		const yes = el("button", r.danger ? "danger" : "", r.yesLabel || "Yes");
		no.type = yes.type = "button";
		no.onclick = () => finish({ confirmed: false });
		yes.onclick = () => finish({ confirmed: true });
		actions.append(no, yes);
	} else if (r.method === "info") {
		if (r.pre) box.append(el("pre", "modal-pre", r.pre));
		const ok = el("button", "", "OK");
		ok.type = "button";
		ok.onclick = () => finish({ confirmed: true });
		actions.append(ok);
	} else {
		const field = r.method === "editor" ? el("textarea") : el("input");
		if (r.placeholder) field.placeholder = r.placeholder;
		if (r.prefill) field.value = r.prefill;
		const ok = el("button", "", "OK");
		ok.type = "button";
		ok.onclick = () => finish({ value: field.value });
		field.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (r.method === "input" || hasMod(e))) ok.click();
		});
		box.append(field);
		actions.append(cancel, ok);
	}
	if (actions.children.length) box.append(actions);
	if (perm) {
		const guardKey = (e) => {
			if (guarded() && (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow"))) {
				e.preventDefault();
				e.stopPropagation();
				return true;
			}
			return false;
		};
		box.onkeyup = guardKey;
		if (box._guardKey) box.removeEventListener("keydown", box._guardKey, true);
		box.addEventListener("keydown", (box._guardKey = guardKey), true);
	}
	box.onkeydown = (e) => {
		if (perm && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && e.target.closest?.(".options")) {
			// The arrows move between the answers, like Tab does.
			const btns = [...box.querySelectorAll(".options button")];
			const at = btns.indexOf(e.target);
			if (at >= 0) {
				e.preventDefault();
				btns[Math.max(0, Math.min(btns.length - 1, at + (e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1)))].focus();
			}
		}
		if (e.key === "Escape") {
			e.stopPropagation();
			finish(perm ? { value: "Deny" } : { cancelled: true });
		}
	};
	const first = (perm && box.querySelector(risky ? ".ask-deny" : ".ask-allow")) || box.querySelector(".options button, .history-item, input, textarea, .modal-actions button:last-child") || box;
	first.focus();
}

function pumpDialogs() {
	if (dialogOpen || !dialogQueue.length) return;
	const { spec: r, resolve } = dialogQueue.shift();
	dialogOpen = true;
	crust.browser.hide(true, "dialog"); // the browser view is drawn above HTML, so hide it behind modals
	const modal = $("#modal");
	let timer;
	let finished = false;
	const finish = (response) => {
		if (finished) return; // a timeout and a click, or a double click
		finished = true;
		clearTimeout(timer);
		$("#modal-backdrop").hidden = true;
		dialogOpen = false;
		crust.browser.hide(false, "dialog");
		resolve(response);
		if (!dialogQueue.length) $("#input").focus();
		pumpDialogs();
	};
	if (r.timeout) timer = setTimeout(() => finish({ cancelled: true }), r.timeout);
	$("#modal-backdrop").hidden = false;
	fillDialog(modal, r, finish);
}

// --- Pi's questions: inline above the composer, one queue per chat ----------------------------
// A question from a background chat waits there (its tab shows "?") until you open that chat.
function askInChat(chat, r) {
	const ask = { spec: r, done: false };
	// Closes the question here. False when it was already closed.
	const close = () => {
		if (ask.done) return false;
		ask.done = true;
		clearTimeout(ask.timer);
		chat.asks = chat.asks.filter((a) => a !== ask);
		renderTabs();
		if (chat === active) {
			renderAsk();
			if (!chat.asks.length) $("#input").focus();
		}
		return true;
	};
	ask.finish = (response) => {
		if (close()) crust.pi.send(chat.id, { type: "extension_ui_response", id: r.id, ...response });
	};
	ask.dismiss = close; // answered elsewhere (Remote): close without answering again
	if (r.timeout) ask.timer = setTimeout(() => ask.finish({ cancelled: true }), r.timeout);
	chat.asks.push(ask);
	renderTabs();
	emitCrust("ask:added", chat, r);
	if (chat === active) renderAsk();
}

// Drop a chat's open questions without answering (its Pi process is gone).
function dropAsks(chat) {
	for (const a of chat.asks || []) {
		a.done = true;
		clearTimeout(a.timer);
	}
	if (chat.asks) chat.asks = [];
	if (chat === active) renderAsk();
}

function renderAsk() {
	const box = $("#ask");
	const ask = active?.asks?.[0];
	if (!ask) {
		box.hidden = true;
		box.replaceChildren();
		box.dataset.askId = "";
		return;
	}
	if (box.dataset.askId === ask.spec.id && !box.hidden) return; // already shown
	box.dataset.askId = ask.spec.id;
	box.hidden = false;
	closeContextPanel(); // its panel is above the chat pane and would cover the question
	// A question Pi is waiting on must not sit behind the full setup view: close it (the Setup pill brings it back).
	if (window.crustOnboarding?.isOpen()) window.crustOnboarding.close({ restore: false });
	fillDialog(box, ask.spec, ask.finish);
	if (active.asks.length > 1) box.querySelector("h2")?.append(el("span", "ask-more", ` (+${active.asks.length - 1} more)`));
	active.el.scrollTop = active.el.scrollHeight;
	// Self-test: answer Pi's questions automatically with the first choice so the round trip is exercised.
	if (info.selftest)
		setTimeout(async () => {
			await crust.selftest.capture("ask");
			(box.querySelector(".options button") || box.querySelector(".modal-actions button:last-child"))?.click();
		}, 1500);
}

function handleUiRequest(r) {
	const chat = view;
	switch (r.method) {
		case "notify":
			toast(r.message, r.notifyType || "info");
			return;
		case "setStatus":
			if (r.statusKey === "permission-mode") {
				// A mode change cancels the extension's open approval prompts (it treats them as denied): drop them here too.
				if (chat.modes && chat.modes !== r.statusText) for (const a of [...(chat.asks || [])]) if (a.spec.method === "select" && (a.spec.options || []).includes("Allow once")) a.dismiss();
				chat.modes = r.statusText;
				if (chat === active) syncModeFromStatus(r.statusText);
			}
			if (r.statusText) state.statuses.set(r.statusKey, r.statusText);
			else state.statuses.delete(r.statusKey);
			// Shown in the header's usage meter (context-panel.js) instead of the status line.
			if (r.statusKey === "crust-context" || r.statusKey === "copilot-usage") {
				if (chat === active) window.renderContextMeter?.();
				return;
			}
			renderStatus();
			return;
		case "setWidget":
			if (r.widgetLines) state.widgets.set(r.widgetKey, r.widgetLines);
			else state.widgets.delete(r.widgetKey);
			renderStatus();
			return;
		case "setTitle":
			if (chat === active) document.title = r.title;
			return;
		case "set_editor_text":
			chat.draft = r.text || "";
			if (chat === active) $("#input").value = chat.draft;
			return;
		case "select":
		case "confirm":
		case "input":
		case "editor":
			askInChat(chat, r);
			return;
	}
}

// --- composer ----------------------------------------------------------------------------
const history = JSON.parse(localStorage.getItem("history") || "[]");
let historyIndex = history.length;

// --- picked elements: pills above the composer, and in sent user messages ---------------
const PICK_RE = /<(browser-element|code-selection|figma-node|storybook-story|figma-component)\b[^>]*>[\s\S]*?<\/\1>/g;
const CODE_ICON =
	'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const FIGMA_ICON =
	'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.1"><path d="M5.5 1.5h2.5v4H5.5a2 2 0 0 1 0-4zM8 1.5h2.5a2 2 0 0 1 0 4H8zM5.5 5.5H8v4H5.5a2 2 0 0 1 0-4zM5.5 9.5H8v2.5a2.5 2.5 0 1 1-2.5-2.5zM8 5.5h2.5a2 2 0 0 1 0 4H8z"/></g></svg>';

// Add picked elements / code selections (string blocks) to the active chat's pills.
function addPicks(blocks) {
	if (!active || !blocks.length) return;
	active.picks.push(...blocks);
	renderPicks();
	$("#input").focus();
}

function splitPicks(text) {
	const blocks = text.match(PICK_RE) || [];
	return { blocks, rest: text.replace(PICK_RE, "").trim() };
}

// A short label ("button “Save”", "Save.tsx:12-20"), a tooltip and an icon from a pill block.
function pickInfo(block) {
	if (block.startsWith("<code-selection")) {
		const attr = (k) => (block.match(new RegExp(`^<code-selection[^>]*\\b${k}="([^"]*)"`)) || [])[1] || "";
		const file = attr("path");
		const lines = attr("lines");
		const label = `${baseName(file) || "code"}${lines ? `:${lines}` : ""}`;
		return { label, title: `${file}${lines ? ` lines ${lines}` : ""}\n${attr("source")}`, icon: CODE_ICON };
	}
	if (block.startsWith("<figma-node")) {
		const attr = (k) => (block.match(new RegExp(`^<figma-node[^>]*\\b${k}="([^"]*)"`)) || [])[1] || "";
		const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
		return { label: `Figma: ${unesc(attr("name"))}`, title: `${unesc(attr("url"))}\nnode ${attr("node-id")}`, icon: FIGMA_ICON };
	}
	if (block.startsWith("<figma-component")) {
		const get = (k) => (block.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1] || "";
		return { label: `Figma component: ${get("name")}`, title: [get("file"), get("link")].filter(Boolean).join("\n"), icon: FIGMA_ICON };
	}
	if (block.startsWith("<storybook-story")) {
		const get = (k) => (block.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1] || "";
		return { label: `Story: ${get("title")} / ${get("name")}`, title: [get("stories file"), get("component file")].filter(Boolean).join("\n") || get("id"), icon: $("#pick-element svg").outerHTML };
	}
	const line = (k) => (block.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1] || "";
	const tag = (line("element").match(/^<([\w-]+)>/) || [])[1] || "element";
	const comp = line("react components \\(inner → outer\\)").split(" < ")[0];
	let txt = (line("text").match(/^"(.*)"$/) || [])[1] || "";
	if (txt.length > 28) txt = txt.slice(0, 27) + "…";
	const label = `${comp || tag}${txt ? ` “${txt}”` : ""}`;
	const title = [line("selector"), line("react components \\(inner → outer\\)"), line("source files")].filter(Boolean).join("\n");
	return { label, title, icon: $("#pick-element svg").outerHTML }; // same icon as the browser toolbar
}

// A pill for a picked element (string block) or an attached image ({ type: "image", data, mimeType, name }).
function pickPill(item, onRemove) {
	const pill = el("span", "pick-pill");
	let label;
	if (typeof item === "string") {
		const info = pickInfo(item);
		label = info.label;
		pill.title = info.title;
		const icon = el("span", "pp-icon");
		icon.innerHTML = info.icon;
		pill.append(icon, el("span", "pp-label", label));
	} else {
		label = item.name || "image";
		const src = `data:${item.mimeType};base64,${item.data}`;
		const img = el("img", "pp-thumb");
		img.src = src;
		img.alt = "";
		pill.classList.add("image");
		pill.title = `${label}\nClick to preview`;
		pill.append(img, el("span", "pp-label", label));
		pill.addEventListener("click", (e) => {
			if (!e.target.closest(".pp-remove")) previewImage(src, label);
		});
	}
	if (onRemove) {
		const x = el("button", "pp-remove", "×");
		x.type = "button";
		x.setAttribute("aria-label", `Remove ${label}`);
		x.addEventListener("click", onRemove);
		pill.append(x);
	}
	return pill;
}

function renderPicks() {
	const host = $("#picks");
	const picks = active?.picks || [];
	host.replaceChildren(
		...picks.map((b, i) =>
			pickPill(b, () => {
				picks.splice(i, 1);
				renderPicks();
				$("#input").focus();
			}),
		),
	);
	host.hidden = !picks.length;
}

// --- attached images: paste, drop or 📎, sent as ImageContent with the prompt ----------------
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
const SVG_DEFAULT_SIDE = 1024; // px; an SVG without width/height/viewBox is drawn at this size
const IMAGE_MAX_SIDE = 2000; // px; larger images are scaled down
const IMAGE_MAX_BYTES = 4 * 1024 * 1024; // base64 payload; above this it is re-encoded as JPEG

const readAsDataURL = (blob) =>
	new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result);
		r.onerror = () => reject(r.error);
		r.readAsDataURL(blob);
	});

const isSvg = (file) => file.type === "image/svg+xml" || /\.svg$/i.test(file.name || "");

// Models only read raster images, so an SVG is drawn onto a canvas and sent as a PNG (transparency kept).
async function svgToImage(file) {
	const text = await file.text();
	const doc = new DOMParser().parseFromString(text, "image/svg+xml");
	const svg = doc.documentElement;
	if (svg.nodeName !== "svg" || doc.querySelector("parsererror")) throw new Error(`${file.name || "file"}: not a valid SVG`);
	const num = (v) => (v && !/%$/.test(v) ? Number.parseFloat(v) : NaN);
	const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
	const ratio = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : 1;
	let w = num(svg.getAttribute("width"));
	let h = num(svg.getAttribute("height"));
	if (!(w > 0) && !(h > 0)) [w, h] = vb.length === 4 && vb[2] > 0 ? [vb[2], vb[3]] : [SVG_DEFAULT_SIDE, SVG_DEFAULT_SIDE];
	else if (!(w > 0)) w = h * ratio;
	else if (!(h > 0)) h = w / ratio;
	// icons are tiny: draw small SVGs larger so the model can see them; big ones are capped like other images
	const scale = Math.min(IMAGE_MAX_SIDE / Math.max(w, h), Math.max(1, 512 / Math.max(w, h)));
	const cw = Math.max(1, Math.round(w * scale));
	const ch = Math.max(1, Math.round(h * scale));
	svg.setAttribute("width", cw);
	svg.setAttribute("height", ch);
	if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	const img = new Image(); // a data: URL, since the CSP doesn't allow blob: images
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
	await img.decode().catch(() => {
		throw new Error(`${file.name || "file"}: couldn't draw this SVG`);
	});
	const canvas = document.createElement("canvas");
	canvas.width = cw;
	canvas.height = ch;
	canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
	let url;
	try {
		url = canvas.toDataURL("image/png");
	} catch {
		throw new Error(`${file.name || "file"}: couldn't convert this SVG to PNG`);
	}
	const [, mimeType, data] = url.match(/^data:([^;]+);base64,(.*)$/);
	return { type: "image", mimeType, data, name: (file.name || "image.svg").replace(/\.svg$/i, "") + ".png" };
}

async function fileToImage(file) {
	if (isSvg(file)) return svgToImage(file);
	if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name || "file"}: not a PNG, JPEG, GIF, WebP or SVG image`);
	let url = await readAsDataURL(file);
	const bmp = await createImageBitmap(file);
	const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
	if (scale < 1 || url.length > IMAGE_MAX_BYTES) {
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(bmp.width * scale);
		canvas.height = Math.round(bmp.height * scale);
		canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
		url = canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
		if (url.length > IMAGE_MAX_BYTES) url = canvas.toDataURL("image/jpeg", 0.85);
	}
	bmp.close();
	const [, mimeType, data] = url.match(/^data:([^;]+);base64,(.*)$/);
	return { type: "image", mimeType, data, name: file.name || `pasted-image.${mimeType.split("/")[1]}` };
}

async function addImages(files) {
	const list = [...files].filter((f) => f.type.startsWith("image/") || isSvg(f));
	if (!list.length || !active) return false;
	const chat = active;
	for (const f of list) {
		try {
			chat.picks.push(await fileToImage(f));
		} catch (e) {
			toast(e.message || String(e), "error");
		}
	}
	if (chat === active) renderPicks();
	const input = state.model?.input;
	if (Array.isArray(input) && !input.includes("image")) toast(`${state.model.name || state.model.id} can't read images; pick another model.`, "warning");
	$("#input").focus();
	return true;
}

selftestSteps.push(async () => {
	const mk = (body, attrs) => new File([`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`], "icon.svg", { type: "image/svg+xml" });
	const dims = async (img) => {
		const i = new Image();
		i.src = `data:${img.mimeType};base64,${img.data}`;
		await i.decode();
		return `${i.naturalWidth}x${i.naturalHeight}`;
	};
	const circle = '<circle cx="12" cy="12" r="10" fill="red"/>';
	const a = await fileToImage(mk(circle, 'viewBox="0 0 24 24"'));
	const b = await fileToImage(mk(circle, 'width="4000" height="1000"'));
	const c = await fileToImage(new File(["<svg"], "bad.svg", { type: "image/svg+xml" })).then(() => "accepted", () => "rejected");
	const got = `${a.mimeType} ${a.name} ${await dims(a)} | ${await dims(b)} | bad ${c}`;
	const want = "image/png icon.png 512x512 | 2000x500 | bad rejected";
	console.error(`SELFTEST svg-attach: ${got} -> ${got === want ? "OK" : `MISMATCH (want ${want})`}`);
}, "svg-attach");

function previewImage(src, name) {
	const back = el("div", "image-preview");
	back.setAttribute("role", "dialog");
	back.setAttribute("aria-label", name);
	const img = el("img");
	img.src = src;
	img.alt = name;
	back.append(img);
	const close = () => {
		back.remove();
		removeEventListener("keydown", onKey, true);
		crust.browser.hide(false, "image-preview");
	};
	const onKey = (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			close();
		}
	};
	back.addEventListener("click", close);
	addEventListener("keydown", onKey, true);
	crust.browser.hide(true, "image-preview"); // the browser view sits above the DOM
	document.body.append(back);
}

$("#input").addEventListener("paste", (e) => {
	const pasted = e.clipboardData?.getData("text") || "";
	if (pasted.includes("figma.com/")) {
		crust.figma.setFileFromText(pasted).then((f) => f && toast(`Figma file set to ${f.name}`));
	}
	const files = [...(e.clipboardData?.files || [])];
	if (files.some((f) => f.type.startsWith("image/"))) {
		e.preventDefault();
		addImages(files);
	}
});
// Dropping a file anywhere must not navigate the window; on the composer it attaches images.
for (const t of ["dragover", "drop"]) document.addEventListener(t, (e) => e.preventDefault());
$("#composer").addEventListener("dragover", (e) => {
	if ([...e.dataTransfer.types].includes("Files")) $("#composer").classList.add("dropping");
});
$("#composer").addEventListener("dragleave", (e) => {
	if (!$("#composer").contains(e.relatedTarget)) $("#composer").classList.remove("dropping");
});
$("#composer").addEventListener("drop", (e) => {
	$("#composer").classList.remove("dropping");
	addImages(e.dataTransfer.files);
});
$("#attach-image").addEventListener("click", () => $("#image-file").click());
$("#image-file").addEventListener("change", async (e) => {
	await addImages(e.target.files);
	e.target.value = "";
});

async function submit({ steer = false } = {}) {
	const input = $("#input");
	const typed = input.value.trim();
	const picks = active ? active.picks : [];
	if (!typed && !picks.length) return;
	if (!state.ready) return notReadyToast();
	const blocks = picks.filter((p) => typeof p === "string");
	const images = picks.filter((p) => typeof p !== "string").map(({ type, data, mimeType }) => ({ type, data, mimeType }));
	const text = blocks.length ? `${blocks.join("\n\n")}\n\n${typed}`.trim() : typed;
	input.value = "";
	const sentPicks = picks.splice(0);
	renderPicks();
	if (typed) {
		history.push(typed);
		if (history.length > 200) history.shift();
		historyIndex = history.length;
		localStorage.setItem("history", JSON.stringify(history));
	}
	const ok = await sendPrompt(text, images, { steer });
	if (!ok) {
		input.value = typed;
		picks.unshift(...sentPicks);
		renderPicks();
	}
}

// Send a prompt (or a /command); queued as steering while Pi works. Returns false when Pi rejected it.
async function sendPrompt(text, images = [], { steer = false } = {}) {
	if (!state.ready && !(!images.length && isAlwaysCommand(text))) {
		notReadyToast();
		return false;
	}
	if (!images.length && text.startsWith("/") && (await handleBuiltinCommand(text))) return true;
	await window.rewindBeforeSend?.(view, text); // checkpoint of the files before Pi sees the message (rewind.js)
	const res = await rpc("prompt", {
		message: text,
		...(images.length ? { images } : {}),
		// While Pi works, a message waits until the run is done (follow-up); it shows in the
		// queue above the composer, where "Steer" moves it forward. ⌥Enter steers right away.
		...(state.streaming ? { streamingBehavior: steer ? "steer" : "followUp" } : {}),
	});
	if (!res.success) {
		toast(res.error || "Pi rejected the prompt", "error");
		return false;
	}
	return true;
}

// --- queued messages: shown above the composer while Pi works ------------------------------
// Pi has two queues: steering (read after the current step, before the next model call) and
// follow-up (read when the run is done). Pi can't move one message, so changing the queue
// takes it all out (clear_queue) and puts it back in the new order.
async function rebuildQueue(change) {
	const c = view;
	const cleared = await rpcTo(c, "clear_queue");
	if (!cleared.success) return toast(cleared.error || "Couldn't change the queue", "error");
	const q = { steering: [...(cleared.data?.steering || [])], followUp: [...(cleared.data?.followUp || [])] };
	change(q);
	// prompt + streamingBehavior queues while Pi works, and starts a run if it just finished.
	for (const [kind, list] of [["steer", q.steering], ["followUp", q.followUp]]) {
		for (const message of list) {
			const res = await rpcTo(c, "prompt", { message, streamingBehavior: kind });
			if (!res.success) toast(res.error || "Couldn't queue a message", "error");
		}
	}
}
const queueSteer = (i) => rebuildQueue((q) => q.steering.push(...q.followUp.splice(i, 1)));
const queueRemove = (kind, i) => rebuildQueue((q) => q[kind].splice(i, 1));
function toComposer(text) {
	const input = $("#input");
	input.value = input.value ? `${text}\n${input.value}` : text;
	input.focus();
}
function queueEdit(kind, i) {
	const text = active.state.queue[kind][i];
	rebuildQueue((q) => q[kind].splice(i, 1)).then(() => toComposer(text));
}
// Held: what was queued when you pressed Stop. Pi's queue is emptied so Stop really stops, but the
// messages stay paused in main (one list for the desktop and the phone) until you send, edit or remove them.
// heldTake removes the item there; it refuses when the item moved or went (e.g. the phone took it first).
async function heldTake(i) {
	const c = active;
	const text = c.state.held[i];
	const r = await crust.pi.heldTake(c.id, i, text);
	if (r?.error) {
		toast(r.error, "warning");
		return null;
	}
	return r.text;
}
async function heldSend(i) {
	const c = active; // the chat it was held in, even if the user switches meanwhile
	const text = await heldTake(i);
	if (text === null) return;
	// Pi didn't take it: don't lose it, put it in the composer (sendPrompt already said why).
	if (c === active) {
		if (!(await sendPrompt(text))) toComposer(text);
		return;
	}
	// The user switched chats: send to the original one, and keep the text in its draft if Pi refuses.
	const r = c.state.ready ? await rpcTo(c, "prompt", { message: text, ...(c.state.streaming ? { streamingBehavior: "followUp" } : {}) }) : { success: false, error: "Pi is still starting…" };
	if (!r.success) {
		toast(r.error || "Pi rejected the prompt", "error");
		c.draft = c.draft ? `${text}\n${c.draft}` : text;
	}
}
async function heldEdit(i) {
	const text = await heldTake(i);
	if (text !== null) toComposer(text);
}
const heldRemove = (i) => heldTake(i);
crust.pi.onHeld(({ chatId, held }) => {
	const c = chats.get(chatId);
	if (!c) return;
	c.state.held = held;
	if (c === active) renderQueue();
});
function renderQueue() {
	const host = $("#queue");
	const q = active?.state.queue || { steering: [], followUp: [] };
	const iconBtn = (label, path, onClick) => {
		const b = el("button", "icon");
		b.type = "button";
		b.title = label;
		b.setAttribute("aria-label", label);
		b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
		b.addEventListener("click", onClick);
		return b;
	};
	const row = (kind, text, i) => {
		const r = el("div", `q-item ${kind}`);
		r.append(el("span", "q-kind", { steering: "Next step", followUp: "After this run", held: "Paused" }[kind]), el("span", "q-text", text));
		r.lastChild.title = text;
		if (kind === "held") {
			const send = el("button", "secondary-btn", "Send");
			send.type = "button";
			send.title = "Send it now (queued after the current run while Pi works)";
			send.addEventListener("click", () => heldSend(i));
			r.append(
				send,
				iconBtn("Edit (back to the composer)", '<path d="M10.5 3.5l2 2L6 12H4v-2z"/>', () => heldEdit(i)),
				iconBtn("Remove", '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', () => heldRemove(i)),
			);
			return r;
		}
		if (kind === "followUp") {
			const steer = el("button", "secondary-btn q-steer", "Steer");
			steer.type = "button";
			steer.title = "Move forward: Pi reads it after the current step instead of when the run is done";
			steer.addEventListener("click", () => queueSteer(i));
			r.append(steer);
		}
		r.append(
			iconBtn("Edit (back to the composer)", '<path d="M10.5 3.5l2 2L6 12H4v-2z"/>', () => queueEdit(kind, i)),
			iconBtn("Remove from the queue", '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', () => queueRemove(kind, i)),
		);
		return r;
	};
	const held = active?.state.held || [];
	host.replaceChildren(...q.steering.map((t, i) => row("steering", t, i)), ...q.followUp.map((t, i) => row("followUp", t, i)), ...held.map((t, i) => row("held", t, i)));
	host.hidden = !host.childElementCount;
}

$("#composer").addEventListener("submit", (e) => {
	e.preventDefault();
	submit();
});
$("#input").addEventListener("keydown", (e) => {
	const input = e.target;
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		submit({ steer: e.altKey }); // ⌥Enter while Pi works: steer instead of queueing
	} else if (e.key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0 && active?.picks.length) {
		active.picks.pop(); // Backspace at the start removes the last pill
		renderPicks();
		e.preventDefault();
	} else if (e.key === "ArrowUp" && input.selectionStart === 0 && history.length) {
		historyIndex = Math.max(0, historyIndex - 1);
		input.value = history[historyIndex];
		e.preventDefault();
	} else if (e.key === "ArrowDown" && input.selectionEnd === input.value.length && historyIndex < history.length) {
		historyIndex++;
		input.value = history[historyIndex] || "";
		e.preventDefault();
	} else if (e.key === "Escape" && state.streaming) stop();
});

// Stop empties Pi's queue (else Pi would run the queued messages right away) and keeps them as held.
async function stop() {
	if (view) await crust.pi.stop(view.id);
}
$("#stop").addEventListener("click", stop);

function clearChat() {
	messages.replaceChildren();
	tools.clear();
	touched.clear();
	current = null;
	working = null;
	emitCrust("chat:cleared", view);
}
$("#new-chat").addEventListener("click", () => newChat());

// --- model picker -----------------------------------------------------------------------------
async function loadModels(c = view) {
	const [st, list] = await Promise.all([rpcTo(c, "get_state"), rpcTo(c, "get_available_models")]);
	if (!chats.has(c.id)) return;
	c.models = list.data?.models || [];
	c.state.model = st.data?.model;
	if (st.data?.sessionFile && st.data.sessionFile !== c.sessionFile) {
		c.sessionFile = st.data.sessionFile;
		crust.pi.sessionFile(c.id, c.sessionFile); // after /fork, /clone: keep the saved tab list current
	}
	if (st.data?.sessionName && !c.name) {
		c.name = st.data.sessionName;
		renderTabs();
	}
	if (c === active) renderModelSelect();
	emitCrust("models:loaded", c, st.data || {});
}
// The model is picked in the header's usage pill (context-panel.js), together with context and usage.
function renderModelSelect() {
	const cur = state.model;
	const m = cur && view.models.find((x) => x.provider === cur.provider && x.id === cur.id);
	const label = m?.name || cur?.name || cur?.id || "Model";
	$("#ctx-meter .pill-model").textContent = label;
	window.renderContextMeter?.();
}
// A phone changed this chat's model or thinking level (remote-main.js): show it here too.
crust.remote?.onChatSettings?.((p) => {
	const c = p && chats.get(p.chatId);
	if (c) loadModels(c);
});
async function switchModel(provider, modelId) {
	const res = await rpc("set_model", { provider, modelId });
	if (!res.success) return toast(res.error || "Couldn't switch model", "error");
	toast(`Model: ${res.data?.name || res.data?.id}`);
	await loadModels();
}

// --- Pi process lifecycle ---------------------------------------------------------------------
crust.pi.onRecord(({ chatId, record }) => {
	const c = chats.get(chatId);
	if (c) withChat(c, () => handleRecord(record));
});
// One-shot waiters for the next ready / exit of a chat's Pi (see waitForPi).
function waitForPi(timeoutMs, c = view) {
	return new Promise((resolve, reject) => {
		const w = {
			ok: () => (clearTimeout(w.timer), resolve()),
			fail: (msg) => (clearTimeout(w.timer), reject(new Error(msg))),
		};
		w.timer = setTimeout(() => {
			c.waiters = c.waiters.filter((x) => x !== w);
			reject(new Error("Pi didn't come back in time"));
		}, timeoutMs);
		c.waiters.push(w);
	});
}
function settlePiWaiters(c, msg) {
	const list = c.waiters;
	c.waiters = [];
	for (const w of list) msg ? w.fail(msg) : w.ok();
}

crust.pi.onStarted(({ chatId, sessionFile, restore, active: wanted, worktree, agent, oldPermissionCopy }) => {
	if (oldPermissionCopy) toast(`Pi Crust brings its own permission modes. Your older "${oldPermissionCopy}" in ~/.pi/agent/extensions loads too and asks as well. Remove or rename it to avoid double prompts.`, "info");
	let c = chats.get(chatId);
	const fresh = !c;
	if (!c) c = makeChat(chatId, { sessionFile, cwd: worktree?.cwd, branch: worktree?.branch, agent });
	c.agent = agent || c.agent;
	if (worktree) {
		c.cwd = worktree.cwd;
		c.branch = worktree.branch || c.branch;
	} else if (c.cwd) {
		// The worktree is gone (or the chat moved to the main checkout): nothing may keep pointing at it.
		c.cwd = null;
		c.branch = null;
		if (c === active) loadChanges();
	}
	c.state.ready = false;
	c.dead = false;
	c.piMissing = false;
	c.modes = undefined; // the new process reports its mode again; until then nothing is shown as enforced
	if (c === active) syncModeFromStatus(undefined);
	if (fresh) {
		// Held messages live in main: pick up what is already there (renderer reload, chat restored).
		crust.pi.held(chatId).then((held) => {
			c.state.held = held;
			if (c === active) renderQueue();
		});
	}
	dropAsks(c);
	failPending(c, "Pi restarted");
	if (fresh && (restore ? wanted : !active)) activate(c); // the first chat of a repo, or the restored active one
	renderTabs();
	renderStatus();
});
crust.pi.onReady(async ({ chatId }) => {
	const c = chats.get(chatId);
	if (!c) return;
	c.state.ready = true;
	renderStatus();
	settlePiWaiters(c);
	await loadModels(c);
	if (c.resume) {
		c.resume = false;
		await showCurrentSession(c);
	}
	if (c === active) $("#input").focus();
});
crust.pi.onStderr(({ chatId, data }) => {
	const c = chats.get(chatId);
	if (c) c.stderrTail = (c.stderrTail + data).slice(-2000);
});
// A question answered on the phone (Remote): close it here without answering it again.
crust.pi.onUiResolved(({ chatId, id, by }) => {
	if (by === "desktop") return;
	const ask = chats.get(chatId)?.asks.find((a) => a.spec.id === id);
	if (ask && ask.dismiss()) toast("Answered from your phone");
});
crust.pi.onExit((e) => {
	const c = chats.get(e.chatId);
	if (!c) return;
	withChat(c, () => {
		state.ready = false;
		c.dead = true;
		settlePiWaiters(c, "Pi stopped");
		dropAsks(c);
		failPending(c, "Pi stopped");
		finishTurn(c);
		c.turn = null;
		setWorking(false);
		renderStatus();
		const why = e.error || `exit code ${e.code ?? e.signal}`;
		const box = el("div", "msg error");
		let btn;
		if (e.missingWorktree) {
			// Never a silent fallback to the main checkout: the user chooses.
			box.append(`${why}. `);
			btn = el("button", "btn", "Open in main checkout");
			btn.onclick = () => crust.pi.openInMain(c.id);
		} else if (e.notInstalled) {
			// The program wasn't found (ENOENT): say what to do instead of showing Node's "spawn pi ENOENT".
			c.piMissing = true;
			box.append("Pi isn't installed yet. Open setup to install it. ");
			btn = el("button", "", "Open setup");
			btn.onclick = () => openSetup("pi-missing", c.id);
		} else {
			box.append(`Pi stopped (${why}). `);
			btn = el("button", "", "Restart Pi");
			btn.onclick = () => crust.pi.restart(c.id);
		}
		box.append(btn);
		if (c.stderrTail.trim()) box.append(el("pre", "", c.stderrTail.trim().split("\n").slice(-8).join("\n")));
		messages.append(box);
		scroll();
	});
	renderTabs();
});

// Chat switching shortcuts: ⌘⇧[ / ⌘⇧] and Ctrl+Tab / Ctrl+Shift+Tab.
window.addEventListener(
	"keydown",
	(e) => {
		if (dialogOpen) return;
		let dir = 0;
		if (hasMod(e) && e.shiftKey && !e.altKey && !(isMac ? e.ctrlKey : e.metaKey)) dir = e.key === "[" || e.key === "{" || e.code === "BracketLeft" ? -1 : e.key === "]" || e.key === "}" || e.code === "BracketRight" ? 1 : 0;
		else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") dir = e.shiftKey ? -1 : 1;
		if (!dir) return;
		e.preventDefault();
		e.stopPropagation();
		cycleChat(dir);
	},
	true,
);

// ===========================================================================
// Boot
// ===========================================================================
// Feature scripts (changes.js, terminal.js, sessions.js, subagents.js, palette.js) load after this file,
// so start once the whole page is parsed.
window.addEventListener("DOMContentLoaded", async () => {
	info = await crust.info();
	$("#url").value = info.devUrl;
	syncBrowserBounds();
	refreshTree();
	crust.selftest.onPrompt((prompt) => {
		$("#input").value = prompt;
		submit();
	});
	// NOPROMPT selftest: no turn will settle, so start the tour (the chosen steps) right away.
	if (info.selftest && info.selftestNoPrompt && !selftestTouring) setTimeout(() => ((selftestTouring = true), runSelftestTour()), 4000);
	initViews();
	initChanges();
	initTerminal();
	initSessions();
	initPalette();
	initGraph();
	initLayout();
	initRepos();
	if (info.selftestNoPrompt) setTimeout(() => { if (!selftestTouring) { selftestTouring = true; runSelftestTour(); } }, 6000); // selftest without a prompt: no turn will settle, so start the tour here
});
