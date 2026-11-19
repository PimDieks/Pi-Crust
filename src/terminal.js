// Terminal tab: xterm.js in the UI, login shells in the repo through node-pty in the main process.
// Several terminals can run at once; each has its own xterm, its own pty (keyed by id in main) and a tab in the bar.
"use strict";

const terms = []; // [{ id, n, term, fit, el, started }]
let termActive = null; // id of the terminal that is shown
let termSeq = 0;
const termProcs = new Map(); // id -> { name, since, command }
const termLastSent = new Map(); // id -> { command, at }

const termById = (id) => terms.find((t) => t.id === id);
const activeTerm = () => termById(termActive);

function termTheme() {
	// level 1 / text primary / fills action / action muted
	return currentTheme() === "light"
		? { background: "#ffffff", foreground: "#2e3f42", cursor: "#2670c7", selectionBackground: "#dbe7f6" }
		: { background: "#111111", foreground: "#d5d9d9", cursor: "#5c94d5", selectionBackground: "#133864" };
}

function initTerminal() {
	$("#term-restart").addEventListener("click", () => restartTerminal());
	$("#term-new").addEventListener("click", () => newTerminal());
	crust.term.onData(({ id, data }) => termById(id)?.term.write(data));
	crust.term.onProc(({ id, name, since }) => {
		if (!name) termProcs.delete(id);
		else {
			const prev = termProcs.get(id), sent = termLastSent.get(id);
			const command = prev?.since === since ? prev.command : sent && since - sent.at < 5000 ? sent.command : "";
			termProcs.set(id, { name, since, command });
		}
		renderTermProc();
	});
	crust.term.onExit(({ id, exitCode }) => {
		termProcs.delete(id);
		renderTermProc();
		const t = termById(id);
		if (!t) return;
		t.started = false;
		t.term.write(`\r\n\x1b[2m[shell exited with code ${exitCode}. Press Enter or ⟳ for a new one]\x1b[0m\r\n`);
	});
	new ResizeObserver(() => fitTerminal()).observe($("#terminal"));
	onThemeChange(() => terms.forEach((t) => (t.term.options.theme = termTheme())));
}

let terminalDocked = false; // true while the terminal sits in the bottom panel (layout.js)
const terminalVisible = () => terminalDocked || activeTab === "terminal";

function fitTerminal() {
	const t = activeTerm();
	if (!t || !terminalVisible()) return;
	try {
		t.fit.fit();
		crust.term.resize(t.id, t.term.cols, t.term.rows);
	} catch {}
}

async function startShell(t = activeTerm()) {
	if (!t) return;
	const r = await crust.term.start(t.id, t.term.cols, t.term.rows);
	if (!r.ok) {
		t.term.write(`\x1b[31m${r.error}\x1b[0m\r\n`);
		return;
	}
	t.started = true;
}

// Make a terminal (xterm + its pane + its tab). The shell starts when it is shown.
function createTerm() {
	const n = ++termSeq;
	const id = n === 1 ? "main" : `t${n}`;
	const term = new Terminal({
		fontFamily: '"SF Mono", ui-monospace, Menlo, "Cascadia Mono", Consolas, monospace',
		fontSize: 12,
		cursorBlink: true,
		allowProposedApi: true,
		scrollback: 10000,
		theme: termTheme(),
	});
	const fit = new FitAddon.FitAddon();
	term.loadAddon(fit);
	const elPane = el("div", "term-pane");
	elPane.hidden = true;
	$("#terminal").append(elPane);
	term.open(elPane);
	const t = { id, n, term, fit, el: elPane, started: false };
	term.onData((data) => {
		if (!t.started) {
			if (data === "\r") restartTerminal(t.id);
			return;
		}
		crust.term.input(t.id, data);
	});
	// Let the app's own shortcuts (⌘K, ⌘1-3, ⌘J, ⌘N) through instead of sending them to the shell.
	// Off macOS the shortcut modifier is Ctrl, so Ctrl+C still interrupts unless text is selected (then it copies)
	// and Ctrl+V pastes through the browser paste event.
	term.attachCustomKeyEventHandler((e) => {
		if (!isMac && e.type === "keydown" && e.ctrlKey && !e.altKey && !e.metaKey) {
			const k = e.key.toLowerCase();
			if (k === "c" && (e.shiftKey || term.hasSelection())) {
				if (term.hasSelection()) crust.clipboard.write(term.getSelection());
				return false;
			}
			if (k === "v") return false;
		}
		return !((hasMod(e) && ["k", "1", "2", "3", "j", "n", "o", "b"].includes(e.key.toLowerCase())) || (e.ctrlKey && e.code === "Backquote"));
	});
	terms.push(t);
	return t;
}

// Show the active terminal (making the first one if needed), fit it and start its shell.
async function showTerminal() {
	if (!activeTerm()) termActive = (terms[0] || createTerm()).id;
	for (const t of terms) t.el.hidden = t.id !== termActive;
	renderTermProc(); // the bar shows the shown terminal's command
	await new Promise((r) => requestAnimationFrame(r));
	fitTerminal();
	const t = activeTerm();
	if (!t.started) await startShell(t);
	t.term.focus();
}

async function selectTerminal(id) {
	if (!termById(id)) return;
	termActive = id;
	if (!terminalDocked && activeTab !== "terminal") switchTab("terminal"); // switchTab calls showTerminal
	else await showTerminal();
}

// Open another terminal next to the others and show it.
async function newTerminal() {
	const t = createTerm();
	termActive = t.id;
	if (!terminalDocked && activeTab !== "terminal") switchTab("terminal");
	await showTerminal();
	return t;
}

async function closeTerminal(id) {
	const t = termById(id);
	if (!t) return;
	if (terms.length === 1) return restartTerminal(id); // always keep one
	const i = terms.indexOf(t);
	terms.splice(i, 1);
	termProcs.delete(id);
	termLastSent.delete(id);
	await crust.term.kill(id);
	t.term.dispose();
	t.el.remove();
	if (termActive === id) termActive = (terms[i] || terms[i - 1]).id;
	renderTermProc();
	if (terminalVisible()) await showTerminal();
}

let restarting = false;
async function restartTerminal(id = termActive) {
	if (restarting) return;
	restarting = true;
	try {
		const t = termById(id);
		await crust.term.kill(id);
		termProcs.delete(id);
		renderTermProc();
		if (!t) return;
		t.started = false;
		t.term.reset();
		if (terminalVisible() && id === termActive) await startShell(t);
	} finally {
		restarting = false;
	}
}

// After a repo switch main has killed every shell: keep one terminal, cleared, and start it again.
function resetTerminals() {
	if (!terms.length) return;
	for (const t of terms.splice(1)) {
		t.term.dispose();
		t.el.remove();
	}
	termProcs.clear();
	termLastSent.clear();
	const t = terms[0];
	termActive = t.id;
	t.started = false;
	t.term.reset();
	renderTermProc();
	if (terminalVisible()) showTerminal();
}

// Run a command in the terminal (used by the command palette and Run buttons).
// When the shown terminal is already busy (a dev server, say), the command gets a new terminal.
async function runInTerminal(command) {
	if (!terminalDocked) switchTab("terminal");
	await showTerminal();
	let t = activeTerm();
	if (termProcs.has(t.id)) t = await newTerminal();
	termLastSent.set(t.id, { command, at: Date.now() });
	crust.term.input(t.id, `${command}\r`);
}

// One tab per terminal: its number, what runs in it (or "shell"), and a close button.
function renderTermTabs() {
	const box = $("#term-tabs");
	box.replaceChildren(
		...terms.map((t) => {
			const p = termProcs.get(t.id), what = p ? p.command || p.name : "shell";
			const tab = el("div", `term-tab${p ? " running" : ""}`);
			tab.setAttribute("role", "tab");
			tab.setAttribute("aria-selected", String(t.id === termActive));
			tab.title = p ? `Terminal ${t.n}: ${what} is running` : `Terminal ${t.n}`;
			tab.append(el("span", "tt-dot"), el("span", "tt-label", `${t.n} · ${what}`));
			const x = el("button", "tt-close", "×");
			x.title = terms.length > 1 ? "Close this terminal" : "Restart this terminal";
			x.setAttribute("aria-label", x.title);
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				closeTerminal(t.id);
			});
			tab.append(x);
			tab.addEventListener("click", () => selectTerminal(t.id));
			tab.addEventListener("auxclick", (e) => e.button === 1 && closeTerminal(t.id));
			return tab;
		}),
	);
}

// The terminal bar shows the shown terminal's command with a live clock; the tab badge shows the
// longest-running command anywhere (plus how many more are running).
function renderTermProc() {
	renderTermTabs();
	const box = $("#term-proc"), badge = $("#term-run"), tab = badge.closest("button");
	stopClock(box);
	stopClock(badge);
	const p = termProcs.get(termActive);
	box.hidden = !p;
	if (p) {
		const what = p.command || p.name;
		box.querySelector(".tp-what").textContent = what;
		startClock(box, p.since, (n, txt) => {
			n.querySelector(".tp-time").textContent = `· ${txt}`;
			n.title = `Running in the terminal: ${what}${p.command ? ` (${p.name})` : ""}, for ${txt}`;
		});
	}
	const running = [...termProcs.values()].sort((a, b) => a.since - b.since);
	if (!running.length) {
		badge.textContent = "";
		tab?.removeAttribute("title");
		return;
	}
	const first = running[0], more = running.length > 1 ? ` +${running.length - 1}` : "";
	startClock(badge, first.since, (n, txt) => {
		n.textContent = txt + more;
		if (tab) tab.title = `Terminal: ${running.map((r) => r.command || r.name).join(", ")} running`;
	});
}

selftestSteps.push(async ({ snap, wait }) => {
	switchTab("terminal");
	await showTerminal();
	await wait(1500);
	const before = terms.length;
	const a = activeTerm();
	crust.term.input(a.id, "sleep 30\r");
	await wait(1500);
	await runInTerminal("echo pi-crust-second-terminal-ok");
	await wait(1500);
	let b = activeTerm();
	// A running command is detected only where the shell's foreground process can be read (main.js term:start polls p.process; on Windows node-pty
	// gives no foreground process, so nothing is ever "busy"). Where it is detected: a command run from the app goes to a NEW terminal and the first
	// stays busy. On Windows: it goes to the same terminal, and the second terminal is opened by hand, so the tabs, select and close checks below
	// still run there.
	if (isWin) {
		const reused = terms.length === before && b.id === a.id && !termProcs.has(a.id);
		console.error(`SELFTEST terminal: windows has no busy detection, run reuses terminal terms=${terms.length} busy-first=${termProcs.has(a.id)} -> ${reused ? "OK" : "MISMATCH"}`);
		b = await newTerminal();
		await wait(1000);
	}
	const ok = terms.length === before + 1 && b.id !== a.id && (isWin || termProcs.has(a.id));
	console.error(`SELFTEST terminal: terms=${terms.length} busy-first=${termProcs.has(a.id)} new=${b.id} -> ${ok ? "OK" : "MISMATCH"}`);
	await snap("terminal-multi");
	console.error(`SELFTEST terminal-bar: proc box ${$("#term-proc").hidden ? "hidden" : "shown"} for idle terminal -> ${$("#term-proc").hidden ? "OK" : "MISMATCH"}`);
	await selectTerminal(a.id);
	await wait(300);
	console.error(`SELFTEST terminal-select: active=${termActive} -> ${termActive === a.id && !a.el.hidden && b.el.hidden ? "OK" : "MISMATCH"}`);
	await closeTerminal(b.id);
	await restartTerminal(a.id);
	await wait(500);
	console.error(`SELFTEST terminal-close: terms=${terms.length} -> ${terms.length === before ? "OK" : "MISMATCH"}`);
});
