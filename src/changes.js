// Middle-pane tabs, the Changes view (changed files + diff) and the git bar.
"use strict";

// Files the active chat edited or wrote (relative paths); renderer.js binds this to the active chat.
let touched = new Set();
let activeTab = "browser";

// Repo-relative path of an absolute one; a chat in a worktree reports paths inside its worktree folder.
function relPath(p) {
	if (!p) return p;
	for (const root of [view?.cwd, info.repo]) {
		if (!root) continue;
		const rel = relUnder(p, root);
		if (rel !== null) return rel;
	}
	return (isWin ? p.replace(/\\/g, "/") : p).replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
	if (name === "terminal" && terminalDocked) return setBottom(false, false) || switchTab("terminal"); // bring it back into the tab
	const prev = activeTab;
	activeTab = name;
	syncTransientTab(name); // a tab outside the current view shows while active
	for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
	for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== name;
	crust.browser.hide(name !== "browser", "tab");
	if (name === "browser") requestAnimationFrame(syncBrowserBounds);
	if (name === "changes") loadChanges();
	if (name === "terminal") showTerminal();
	if (name === "editor") showEditor();
	if (prev !== name) emitCrust("tab:changed", name, prev);
}

// Tab order: drag a tab to move it (or ⌥⇧← / ⌥⇧→ on a focused tab); ⌘1…⌘5 follow the order. Remembered.
const TAB_DEFAULT_ORDER = ["editor", "changes", "browser", "terminal", "design"];
let tabOrder = (() => {
	try {
		const saved = JSON.parse(localStorage.getItem("tabOrder") || "null");
		// Tolerant: keep the saved order, drop unknown tabs, add tabs that are new since it was saved.
		if (Array.isArray(saved)) {
			const kept = saved.filter((t, i) => TAB_DEFAULT_ORDER.includes(t) && saved.indexOf(t) === i);
			return [...kept, ...TAB_DEFAULT_ORDER.filter((t) => !kept.includes(t))];
		}
	} catch {}
	return [...TAB_DEFAULT_ORDER];
})();

const tabButton = (name) => document.querySelector(`.tabs [data-tab="${name}"]`);
const tabShortcut = (name) => (visibleTabs().includes(name) ? keyLabel(`⌘${visibleTabs().indexOf(name) + 1}`) : ""); // numbers the tabs of the current view

function applyTabOrder() {
	const nav = $(".tabs");
	const spacer = nav.querySelector(":scope > .spacer");
	for (const name of tabOrder) nav.insertBefore(tabButton(name), spacer);
	for (const name of tabOrder) {
		const kbd = tabButton(name).querySelector("kbd");
		if (kbd) kbd.textContent = tabShortcut(name);
	}
}

function saveTabOrder() {
	tabOrder = [...document.querySelectorAll(".tabs [data-tab]")].map((b) => b.dataset.tab);
	localStorage.setItem("tabOrder", JSON.stringify(tabOrder));
	applyTabOrder();
}

function initTabDrag() {
	const nav = $(".tabs");
	let dragged = null;
	for (const b of nav.querySelectorAll("[data-tab]")) {
		b.draggable = true;
		b.title = keyLabel("Drag to reorder (or ⌥⇧← / ⌥⇧→)");
		b.addEventListener("dragstart", (e) => {
			dragged = b;
			b.classList.add("dragging");
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", b.dataset.tab);
		});
		b.addEventListener("dragend", () => {
			b.classList.remove("dragging");
			dragged = null;
			saveTabOrder();
		});
		b.addEventListener("keydown", (e) => {
			if (!e.altKey || !e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
			e.preventDefault();
			const i = tabOrder.indexOf(b.dataset.tab);
			const j = i + (e.key === "ArrowLeft" ? -1 : 1);
			if (j < 0 || j >= tabOrder.length) return;
			[tabOrder[i], tabOrder[j]] = [tabOrder[j], tabOrder[i]];
			applyTabOrder();
			saveTabOrder();
			b.focus();
		});
	}
	// Move the dragged tab live, before or after the tab under the pointer (by its midpoint).
	nav.addEventListener("dragover", (e) => {
		if (!dragged) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		const tabs = [...nav.querySelectorAll("[data-tab]")].filter((t) => t !== dragged);
		const before = tabs.find((t) => {
			const r = t.getBoundingClientRect();
			return e.clientX < r.left + r.width / 2;
		});
		const target = before || nav.querySelector(":scope > .spacer");
		if (dragged.nextElementSibling !== target) nav.insertBefore(dragged, target);
	});
	nav.addEventListener("drop", (e) => dragged && e.preventDefault());
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------
let changes = []; // [{ path, code, label }]
let selectedChange = null;
let onlyTouched = false;
let diffShowsCommit = false; // the diff view shows a commit from the graph: don't replace it with the file list state

// code is git's two-letter porcelain status: index (staged) column, then worktree column.
function statusLabel(code) {
	if (code === "??") return "NEW";
	if (code.includes("R")) return "REN";
	if (code.includes("D")) return "DEL";
	if (code[0] === "A") return "ADD";
	if (code[0] === "M" && code[1] === " ") return "STG";
	return "MOD";
}

// The chat whose folder the Changes list and the git bar show. git calls name it explicitly, so a tab switch while a call is
// in flight can never make discard / commit / push act on another checkout.
let changesChat = null;
let changesSeq = 0;
async function loadChanges() {
	const chatId = active?.id || null;
	const seq = ++changesSeq;
	const st = await crust.fs.gitStatus(false, chatId);
	if (seq !== changesSeq) return; // a newer load is under way
	changesChat = chatId;
	if (!st.worktree) git = st; // shared with the file tree (which always shows the main checkout)
	changes = Object.entries(st.files)
		.map(([path, code]) => ({ path, code, label: statusLabel(code) }))
		.sort((a, b) => a.path.localeCompare(b.path));
	$("#changes-count").textContent = changes.length ? String(changes.length) : "";
	emitCrust("changes:loaded", changes.length, chatId, changes.map((c) => c.path)); // the first-task card reads it
	if (activeTab === "changes") renderChanges();
	refreshGitBar();
}

let changesTimer;
let changesDirty = false; // a change came in while the window was hidden: reload once when it shows again
document.addEventListener("visibilitychange", () => {
	if (!document.hidden && changesDirty) refreshChangesSoon();
});
function refreshChangesSoon() {
	if (document.hidden) return void (changesDirty = true);
	changesDirty = false;
	clearTimeout(changesTimer);
	changesTimer = setTimeout(loadChanges, 300);
}

// Shown while the open chat works in a worktree: the list, diffs and git bar are the worktree's; the tree and editor are not.
function worktreeBanner(c) {
	const b = el("div", "changes-banner");
	b.setAttribute("role", "note");
	b.append(el("b", "", `Worktree ${c.branch || ""}`), " The changes, diffs and git bar are this chat's worktree; the file tree and editor show the main checkout.");
	return b;
}

function renderChanges() {
	const list = $("#changes-list");
	const header = el("div", "changes-group");
	const filter = el("label");
	const cb = el("input");
	cb.type = "checkbox";
	cb.checked = onlyTouched;
	cb.onchange = () => {
		onlyTouched = cb.checked;
		renderChanges();
	};
	filter.append(cb, " Only files this chat changed");
	const shown = onlyTouched ? changes.filter((c) => touched.has(c.path)) : changes;
	header.append(`${shown.length} changed file${shown.length === 1 ? "" : "s"}`);
	const rows = shown.map((c) => {
		const row = el("div", "change");
		row.tabIndex = 0;
		row.setAttribute("role", "option");
		if (c.path === selectedChange) row.classList.add("selected");
		const name = c.path.split("/").pop();
		const dir = c.path.slice(0, -name.length);
		const p = el("span", "cpath");
		p.title = c.path;
		p.append(el("span", "cname", name), el("span", "cdir", dir.replace(/\/$/, "")));
		const discard = el("button", "icon discard");
		discard.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6"/><path d="M6 3.5l-3 3 3 3"/></svg>';
		discard.title = "Discard changes";
		discard.onclick = (e) => {
			e.stopPropagation();
			discardChange(c);
		};
		row.append(el("span", `st st-${c.label}`, c.label), p, discard);
		row.onclick = () => showDiff(c);
		row.onkeydown = (e) => {
			if (e.key === "Enter") showDiff(c);
			if (e.key === "ArrowDown") row.nextElementSibling?.focus();
			if (e.key === "ArrowUp") row.previousElementSibling?.focus();
		};
		return row;
	});
	const filterRow = el("div", "changes-group");
	filterRow.style.textTransform = "none";
	filterRow.append(filter);
	const banner = active?.cwd ? worktreeBanner(active) : null;
	list.replaceChildren(...(banner ? [banner] : []), filterRow, header, ...rows);
	chMarkDirtyRows();
	if (diffShowsCommit) return;
	if (!shown.length || !selectedChange || !shown.some((c) => c.path === selectedChange)) chHide();
	if (!shown.length) $("#diff-view").replaceChildren(el("div", "empty", onlyTouched ? "This chat hasn't changed any files yet." : "No changes. The working tree is clean."));
	else if (selectedChange && !shown.some((c) => c.path === selectedChange)) $("#diff-view").replaceChildren(el("div", "empty", "Select a file to see its diff."));
	else if (selectedChange) showDiff(shown.find((c) => c.path === selectedChange), true);
}

// ---------------------------------------------------------------------------
// Syntax highlighting (highlight.js, loaded in index.html)
// ---------------------------------------------------------------------------
const LANG_BY_EXT = {
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
	md: "markdown", mdx: "markdown", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml",
	sh: "bash", bash: "bash", zsh: "bash", css: "css", scss: "scss", less: "less",
	html: "xml", htm: "xml", xml: "xml", svg: "xml", py: "python", rb: "ruby", go: "go", rs: "rust",
	java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php",
	sql: "sql", graphql: "graphql", gql: "graphql", prisma: "graphql", toml: "ini", ini: "ini", env: "bash", lua: "lua",
};

function langFor(file) {
	if (typeof hljs === "undefined" || !file) return null;
	const name = file.split("/").pop().toLowerCase();
	if (name === "makefile") return "makefile";
	if (name === "dockerfile" || name.startsWith(".") && !name.includes(".", 1)) return "bash";
	const lang = LANG_BY_EXT[name.split(".").pop()];
	return lang && hljs.getLanguage(lang) ? lang : null;
}

// Highlight a block of text as a whole (so multi-line strings/comments stay correct),
// then split the HTML per line, closing and reopening spans across line breaks.
function highlightToLines(text, lang) {
	let html;
	try {
		html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
	const lines = [];
	const open = [];
	let cur = "";
	for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
		if (!part) continue;
		if (part === "\n") {
			lines.push(cur + "</span>".repeat(open.length));
			cur = open.join("");
		} else if (part.startsWith("<span")) {
			open.push(part);
			cur += part;
		} else if (part === "</span>") {
			open.pop();
			cur += part;
		} else cur += part;
	}
	lines.push(cur + "</span>".repeat(open.length));
	return lines;
}

// rows: [{ node, side: "old" | "new" | "both", text, file }] -> fills each row's code span with highlighted HTML.
function highlightRows(rows) {
	const byFile = new Map();
	for (const r of rows) {
		if (!byFile.has(r.file)) byFile.set(r.file, []);
		byFile.get(r.file).push(r);
	}
	for (const [file, rs] of byFile) {
		const lang = langFor(file);
		if (!lang) continue;
		for (const side of ["old", "new"]) {
			const sideRows = rs.filter((r) => r.side === side || r.side === "both");
			if (!sideRows.length) continue;
			const html = highlightToLines(sideRows.map((r) => r.text).join("\n"), lang);
			if (!html) continue;
			// context lines are taken from the new side; old side only fills deleted lines
			sideRows.forEach((r, i) => {
				if (side === "old" && r.side === "both") return;
				r.node.innerHTML = html[i] || "";
			});
		}
	}
}

// Unified diff text -> coloured line elements (shared with the commit view in graph.js).
// Each line keeps its file and old/new line numbers (dataset) so a selection can be sent to the chat.
function diffLines(diff, max = 5000) {
	const lines = diff.split("\n");
	let file = "";
	let oldNo = 0;
	let newNo = 0;
	const codeRows = [];
	const out = lines.slice(0, max).map((line) => {
		let cls = "dl";
		const ln = {};
		if (line.startsWith("@@")) {
			cls += " hunk";
			const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
			if (m) [oldNo, newNo] = [Number(m[1]), Number(m[2])];
		} else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
			cls += " meta";
			const m = line.match(/^(?:\+\+\+ b\/|--- a\/)(.+)$/);
			if (m && (line.startsWith("+++") || !file)) file = m[1];
			if (line.startsWith("diff --git")) file = (line.match(/ b\/(.+)$/) || [])[1] || "";
		} else if (line.startsWith("+")) {
			cls += " add";
			ln.new = newNo++;
		} else if (line.startsWith("-")) {
			cls += " del";
			ln.old = oldNo++;
		} else if (line.startsWith(" ")) {
			ln.old = oldNo++;
			ln.new = newNo++;
		}
		const isCode = ln.old !== undefined || ln.new !== undefined;
		let n;
		if (isCode) {
			n = el("div", cls);
			const code = el("span", "code", line.slice(1) || "");
			n.append(el("span", "sign", line[0] || " "), code);
			codeRows.push({ node: code, text: line.slice(1), file, side: ln.old !== undefined && ln.new !== undefined ? "both" : ln.new !== undefined ? "new" : "old" });
		} else n = el("div", cls, line || " ");
		if (file) n.dataset.file = file;
		if (ln.old !== undefined) n.dataset.old = ln.old;
		if (ln.new !== undefined) n.dataset.new = ln.new;
		return n;
	});
	highlightRows(codeRows);
	if (lines.length > max) out.push(el("div", "dl meta", `… ${lines.length - max} more lines`));
	return out;
}

// ---------------------------------------------------------------------------
// Selecting code in the diff: "Add to chat" (or ⌘L) turns it into a pill in the composer.
// ---------------------------------------------------------------------------
// The selected diff lines as a <code-selection> block, or null when nothing in the diff is selected.
function diffSelection() {
	const sel = getSelection();
	const view = $("#diff-view");
	if (!sel || sel.isCollapsed || !view.contains(sel.anchorNode) || !view.contains(sel.focusNode)) return null;
	const lines = [...view.querySelectorAll(".dl")].filter((n) => sel.containsNode(n, true) && !n.classList.contains("meta") && !n.classList.contains("hunk"));
	if (!lines.length) return null;
	const byFile = new Map();
	for (const n of lines) {
		const f = n.dataset.file || "";
		if (!byFile.has(f)) byFile.set(f, []);
		byFile.get(f).push(n);
	}
	const source = view.dataset.source || "working tree";
	return [...byFile].map(([file, ns]) => {
		const nums = ns.map((n) => Number(n.dataset.new ?? n.dataset.old)).filter((x) => !Number.isNaN(x));
		const range = nums.length ? (Math.min(...nums) === Math.max(...nums) ? `${Math.min(...nums)}` : `${Math.min(...nums)}-${Math.max(...nums)}`) : "";
		const body = ns.map((n) => n.textContent).join("\n");
		return `<code-selection path="${file}"${range ? ` lines="${range}"` : ""} source="${source} diff">\n\`\`\`diff\n${body}\n\`\`\`\n</code-selection>`;
	});
}

function addDiffSelectionToChat() {
	const blocks = diffSelection();
	if (!blocks) return false;
	addPicks(blocks);
	getSelection().removeAllRanges();
	$("#diff-add").hidden = true;
	return true;
}

function placeDiffAddButton() {
	const btn = $("#diff-add");
	const sel = getSelection();
	if (!diffSelection()) {
		btn.hidden = true;
		return;
	}
	const rect = sel.getRangeAt(0).getBoundingClientRect();
	const host = $("#diff-view").getBoundingClientRect();
	btn.hidden = false;
	const top = Math.max(host.top + 4, Math.min(rect.top - btn.offsetHeight - 6, host.bottom - btn.offsetHeight - 4));
	const left = Math.max(host.left + 4, Math.min(rect.right - btn.offsetWidth, host.right - btn.offsetWidth - 4));
	btn.style.top = `${top}px`;
	btn.style.left = `${left}px`;
}

async function showDiff(c, keepScroll) {
	if (!c) return;
	diffShowsCommit = false;
	selectedChange = c.path;
	for (const r of document.querySelectorAll(".change")) r.classList.toggle("selected", r.querySelector(".cpath").title === c.path);
	// Editable Monaco diff when possible; the text diff below for deleted, binary or too large files.
	if (await chShow(c)) return;
	if (selectedChange !== c.path || diffShowsCommit) return;
	chHide();
	const view = $("#diff-view");
	const top = view.scrollTop;
	const diff = await crust.git.diff(changesChat, c.path, c.code);
	if (selectedChange !== c.path) return; // another file was selected meanwhile
	view.dataset.source = "working tree";
	const out = diffLines(diff);
	if (!diff.trim()) out.push(el("div", "empty", c.label === "DEL" ? "File deleted." : "No textual changes (binary file or mode change)."));
	view.replaceChildren(...out);
	if (keepScroll) view.scrollTop = top;
}

async function discardChange(c) {
	const res = await showDialog({
		method: "confirm",
		title: `Discard changes to ${c.path}?`,
		message: c.label === "NEW" ? "This deletes the new file. It can't be undone." : "This restores the file to the last commit. Your changes are lost.",
		yesLabel: "Discard",
		noLabel: "Keep",
		danger: true,
	});
	if (!res.confirmed) return;
	const r = await crust.git.discard(changesChat, c.path, c.code);
	if (r && r.ok === false) toast(r.stderr || "Discard failed", "error");
	if (selectedChange === c.path) selectedChange = null;
	if (chPath === c.path) {
		chModels.get(c.path)?.model.dispose();
		chModels.delete(c.path);
		chHide();
	}
	loadChanges();
}

// ---------------------------------------------------------------------------
// Git bar
// ---------------------------------------------------------------------------
let gitInfoCache = null;
let gitBusy = false;

async function refreshGitBar() {
	const chatId = changesChat;
	gitInfoCache = await crust.git.info(chatId);
	if (chatId !== changesChat) return;
	const gi = gitInfoCache;
	const ahead = gi.hasUpstream ? (gi.ahead ? ` ↑${gi.ahead}` : "") : " (not pushed)";
	$("#git-branch").textContent = gi.error ? "worktree missing" : gi.branch ? `⎇ ${gi.branch}${ahead}` : "detached HEAD";
	const hasChanges = changes.length > 0;
	$("#btn-commit").disabled = gitBusy || !hasChanges;
	$("#btn-commit-push").disabled = gitBusy || !hasChanges;
	$("#btn-push").disabled = gitBusy || !gi.branch || (gi.hasUpstream && !gi.ahead);
	const pr = gi.pr && gi.pr.state === "OPEN" ? gi.pr : null;
	$("#btn-pr").textContent = pr ? `Open PR #${pr.number}` : "Create PR with Pi";
	$("#btn-pr").disabled = gitBusy || !gi.branch;
}

async function confirmProtectedBranch(action) {
	const b = gitInfoCache?.branch;
	if (!b || !["main", "master", "develop"].includes(b)) return true;
	const res = await showDialog({
		method: "confirm",
		title: `${action} directly on ${b}?`,
		message: `You're on ${b}. Most workflows expect a feature branch. Continue anyway?`,
		yesLabel: "Continue",
		noLabel: "Cancel",
		danger: true,
	});
	return !!res.confirmed;
}

async function gitAction(label, fn) {
	gitBusy = true;
	refreshGitBar();
	toast(`${label}…`);
	try {
		const r = await fn();
		if (r.ok) toast(`${label}: done`, "info");
		else await showDialog({ method: "info", title: `${label} failed`, pre: (r.stderr || r.stdout || "Unknown error").trim().slice(-6000) });
		return r;
	} finally {
		gitBusy = false;
		loadChanges();
	}
}

async function commit(push) {
	const msg = $("#commit-msg").value.trim();
	if (!msg) {
		toast("Write a commit message first", "warning");
		$("#commit-msg").focus();
		return;
	}
	if (!(await confirmProtectedBranch(push ? "Commit and push" : "Commit"))) return;
	const chatId = changesChat;
	const r = await gitAction(push ? "Commit + Push" : "Commit", () => crust.git.commit(chatId, msg, push));
	if (r.ok) $("#commit-msg").value = "";
}

function initChanges() {
	for (const b of document.querySelectorAll(".tabs [data-tab]")) b.addEventListener("click", () => switchTab(b.dataset.tab));
	applyTabOrder();
	initTabDrag();
	switchTab(viewStartTab()); // start on the view's tab
	$("#git-bar").addEventListener("submit", (e) => {
		e.preventDefault();
		commit(false);
	});
	$("#btn-commit-push").addEventListener("click", () => commit(true));
	$("#btn-push").addEventListener("click", async () => {
		if (!(await confirmProtectedBranch("Push"))) return;
		const chatId = changesChat;
		gitAction("Push", () => crust.git.push(chatId));
	});
	$("#btn-pr").addEventListener("click", () => {
		const pr = gitInfoCache?.pr;
		if (pr && pr.state === "OPEN") return window.open(pr.url, "_blank");
		// PR conventions differ per repo (template, skills, AGENTS.md): let Pi follow them.
		sendPrompt("Open a pull request for the current branch. Follow this repo's PR conventions (PR template, AGENTS.md, any skill about pull requests). Push first if needed.");
	});
	crust.fs.onChanged(refreshChangesSoon);
	$("#diff-view").addEventListener("mouseup", () => setTimeout(placeDiffAddButton));
	$("#diff-view").addEventListener("keyup", (e) => e.shiftKey && placeDiffAddButton());
	$("#diff-view").addEventListener("scroll", () => ($("#diff-add").hidden = true));
	document.addEventListener("selectionchange", () => !diffSelection() && ($("#diff-add").hidden = true));
	$("#diff-add").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
	$("#diff-add").addEventListener("click", addDiffSelectionToChat);
	window.addEventListener(
		"keydown",
		(e) => {
			if (modOnly(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l" && !dialogOpen && addDiffSelectionToChat()) {
				e.preventDefault();
				e.stopPropagation();
			}
		},
		true,
	);
	loadChanges();
}
