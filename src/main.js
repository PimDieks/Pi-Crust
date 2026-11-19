// Pi Crust main process: window layout, the Pi RPC subprocess, the file tree and the embedded dev browser.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, globalShortcut, nativeTheme, clipboard } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { makeFindPi } = require("./pi-cache");
const { watchTree } = require("./watch-tree");
const { createPrLookup } = require("./pr-lookup");
const { NOISE_DIRS, isNoise, createIgnoreCheck, debounceMax } = require("./watch-filter");
const { hardenGitArgs } = require("./git-harden"); // automatic read-only git calls: no fsmonitor, hooks, ext diff, textconv, pager
const IS_WIN = process.platform === "win32";
const IS_DARWIN = process.platform === "darwin";

// The repo Pi works in. Chosen in the repo picker at startup, or given with `pi-crust <path>` (--repo=<path>)
// or PI_CRUST_CWD. Everything below reads these at call time, so switching repos only means updating them.
let REPO = null;
let REPO_REAL = null;
let ENV = { ...process.env };

function repoFromArgs(argv) {
	const arg = argv.find((a) => a.startsWith("--repo="));
	const p = arg ? arg.slice("--repo=".length) : null;
	return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.resolve(p) : null;
}
const DEV_URL = process.env.PI_CRUST_URL || "http://localhost:3000/";
const SELFTEST = !app.isPackaged && process.env.PI_CRUST_SELFTEST === "1"; // never in a packaged app: a stray variable must not switch off updates or the crash dialog
if (SELFTEST) process.on("uncaughtException", (e) => { console.error("SELFTEST crash", e); app.exit(1); }); // selftest only: a crash logs and exits, no dialog
const { protocol: electronProtocol, session: electronSession } = require("electron");
const projectProtocol = require("./project-protocol");
projectProtocol.registerScheme(electronProtocol); // pi-project:// (Viewer project files); must run before the app is ready
let projectRootOverride = null; // selftest only (viewer-files): a throwaway project stands in for the open one
const START_HIDDEN = process.env.PI_CRUST_HIDDEN === "1"; // set by the login item: start in the background
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IGNORED = new Set([".git", "node_modules", "dist", ".turbo", ".next", "coverage", ".DS_Store", "__generated__"]);

let win;
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
let lastRealBounds = { x: 0, y: 0, width: 0, height: 0 }; // last non-empty bounds
let browserHidden = new Set(); // reasons: "tab", "modal"
const chats = new Map(); // chatId -> { id, agent, handle, cwd }: the agent adapter and its (opaque) process handle
let chatSeq = 0;

// ---------------------------------------------------------------------------
// Environment: Electron started from the Dock has a minimal PATH, so add nvm's node and Homebrew.
// ---------------------------------------------------------------------------
const { pathKey, nvmWinHome, onPath } = require("./env-path");
const piLocator = require("./agents/pi/locate");
function buildEnvWin() {
	const extra = [];
	const home = nvmWinHome();
	try {
		const nvmrc = fs.readFileSync(path.join(REPO, ".nvmrc"), "utf8").trim().replace(/^v/, "");
		if (home && /^v?\d+(\.\d+){0,2}$/.test(nvmrc)) {
			const preferred = path.join(home, `v${nvmrc}`);
			if (fs.existsSync(path.join(preferred, "node.exe"))) extra.push(preferred);
		}
	} catch {}
	extra.push(...piLocator.pathExtras(findPi()));
	const key = pathKey(process.env);
	const env = { ...process.env, [key]: [...extra, process.env[key] || ""].join(path.delimiter) };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
function buildEnv() {
	if (!REPO) return { ...process.env };
	if (IS_WIN) return buildEnvWin();
	const extra = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
	try {
		const nvmrc = fs.readFileSync(path.join(REPO, ".nvmrc"), "utf8").trim().replace(/^v/, "");
		if (/^v?\d+(\.\d+){0,2}$/.test(nvmrc)) {
			const preferred = path.join(nvmDir, `v${nvmrc}`, "bin");
			if (path.resolve(preferred).startsWith(nvmDir + path.sep) && fs.existsSync(preferred)) extra.unshift(preferred);
		}
	} catch {}
	// Pi's own bin last, so `pi` is on PATH (terminal, scripts) without overriding the repo's Node.
	extra.push(...piLocator.pathExtras(findPi()));
	const env = { ...process.env, PATH: [...extra, process.env.PATH || ""].join(":") };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

// Where Pi is installed lives in agents/pi/locate.js. The selftest switch stays here, next to SELFTEST.
function locatePi() {
	if (SELFTEST && process.env.PI_CRUST_SELFTEST_NO_PI === "1") return null; // selftest only: act as if Pi isn't installed
	return piLocator.locate();
}
// Remembered until `findPi({ fresh: true })` (see pi-cache.js): installing Pi while the app runs must work without a restart.
const findPi = makeFindPi(locatePi);



// Feature modules that follow the UI's events even without a window (remote-main.js).
const sendTaps = new Set();
function send(channel, payload) {
	// Taps run before the window check on purpose: the window may be hidden or gone while a phone is watching.
	for (const tap of sendTaps) {
		try {
			tap(channel, payload);
		} catch (e) {
			console.error("send tap failed", e);
		}
	}
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Pi over RPC (strict JSONL: split on LF only, never readline).
// ---------------------------------------------------------------------------
// The process itself (spawn, framing, readiness probe, kill) lives in agents/pi/process.js.
const { createRegistry, DEFAULT_ID: DEFAULT_AGENT_ID } = require("./agents/registry");
const chatAgents = require("./chat-agents");
const agents = createRegistry();
const piAgent = agents.register(require("./agents/pi")); // the only agent in phase 6
agents.register(require("./agents/claude")); // phase 7: inert until the UI offers it; Pi stays the default
let claudeSetup = null; // first-use setup of the Claude Agent (claude-setup-main.js): its key and its engine
// The approval prompt of Claude Agent chats (claude-approval-main.js): the same records and prompt as a Pi chat's permission extension.
const claudeApprovals = require("./claude-approval-main").createApprovals({
	send: (channel, payload) => send(channel, payload),
	hasWindow: () => !!win && !win.isDestroyed(),
	isCurrent: (chatId, handle) => chats.get(chatId)?.handle === handle,
});
const setupWaiting = new Set(); // chats of an agent that is not set up yet: they start by themselves once both steps are done
const agentInfo = (a) => ({ id: a.id, label: a.label, capabilities: structuredClone(a.capabilities) }); // a copy: the renderer's message never aliases the adapter's object // what the renderer is told about a chat's agent

// One Pi RPC process per chat, keyed by chatId. Every event sent to the UI carries the chatId.
// `wt` (from resolveWt) is null for the repo itself, { cwd, branch } for a chat in its own worktree (see worktree-main.js), or
// { cwd, missing: true }: the worktree is gone. Then nothing is spawned (never a silent fallback to the main checkout).
// An older permission-modes extension in the user's Pi extensions folder: { name, dir, file, first } or null. `first` is true only the
// first time this name is seen (the one-time toast); the selector names the old copy every time, from `name` and `dir`. The folder is only read.
const piAgentDir = () => ENV.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
function permissionOldCopy(announce = true) {
	try {
		const found = require("./permission-logic").describeOldCopy(piAgentDir(), os.homedir());
		if (!found) return null;
		const first = announce && readSettings().permissionOldCopyTold !== found.name;
		if (first && !SELFTEST) writeSettings({ permissionOldCopyTold: found.name });
		return { ...found, first };
	} catch {
		return null;
	}
}
// "Show the file" next to the selector: reveals the old copy in Finder or Explorer. The path is looked up here, never taken from the page;
// nothing is changed, renamed or deleted. A selftest only reports the path (nothing opens on screen).
ipcMain.handle("pi:oldCopy", () => {
	const found = permissionOldCopy(false);
	return found ? { name: found.name, dir: found.dir } : null;
});
ipcMain.handle("pi:revealOldCopy", () => {
	const found = permissionOldCopy(false);
	if (!found) return { ok: false };
	if (!SELFTEST) shell.showItemInFolder(found.file);
	return { ok: true, file: found.file };
});
// Selftest only: put an old copy into the (temporary) agent folder.
ipcMain.handle("pi:selftestOldCopy", () => {
	if (!SELFTEST) return false;
	const dir = path.join(piAgentDir(), "extensions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "permission-modes.ts"), "// selftest stand-in");
	return true;
});
// startOpts: more start options for an agent that is not Pi (the Claude Agent's fork of another chat: see forkChat below).
function startAgent(chatId, sessionFile, hint = {}, wt = null, agentId = undefined, startOpts = null) {
	const agent = agents.get(agentId); // undefined = the default agent (Pi)
	if (!agent) throw new Error(`unknown agent "${agentId}"`);
	if (wt && wt.missing) {
		if (!openList.some((e) => e.id === chatId)) {
			openList.push({ id: chatId, file: sessionFile || null, cwd: wt.cwd, agent: agent.id });
			saveOpenChats();
		}
		const error = `Worktree ${wt.cwd} no longer exists`;
		send("pi:started", { chatId, cwd: REPO, worktree: null, missingWorktree: wt.cwd, sessionFile: sessionFile || null, agent: agentInfo(agent), ...hint });
		send("pi:exit", { chatId, error, missingWorktree: wt.cwd });
		return null;
	}
	const cwd = wt ? wt.cwd : null;
	const isDefaultAgent = agent.id === DEFAULT_AGENT_ID; // Pi's own steps (locating it, the old-copy hint) stay Pi's; another agent starts through its adapter
	const pi = isDefaultAgent ? findPi() : null;
	if (isDefaultAgent && !pi) {
		// Pi isn't installed: report it without starting anything. (Never a bare `pi` with the project as the working folder: on
		// Windows a pi.exe lying in the project would be the one that runs.)
		if (!openList.some((e) => e.id === chatId)) {
			openList.push({ id: chatId, file: sessionFile || null, cwd, agent: agent.id });
			saveOpenChats();
		}
		send("pi:started", { chatId, cwd: cwd || REPO, worktree: cwd ? { cwd, branch: wt.branch || null } : null, sessionFile: sessionFile || null, agent: agentInfo(agent), ...hint });
		send("pi:exit", { chatId, error: agent.strings.notInstalled, errorCode: "ENOENT", notInstalled: true });
		return null;
	}
	if (!isDefaultAgent && agent.id === "claude" && claudeSetup) {
		claudeSetup.markStarted(); // the Setup panel lists the Claude Agent's key and engine from now on
		if (!claudeSetup.isReady()) {
			// No key or no engine yet: nothing starts. The chat shows its setup card (needsSetup); both steps done starts it (setupWaiting).
			if (!openList.some((e) => e.id === chatId)) {
				openList.push({ id: chatId, file: sessionFile || null, cwd, agent: agent.id });
				saveOpenChats();
			}
			setupWaiting.add(chatId);
			send("pi:started", { chatId, cwd: cwd || REPO, worktree: cwd ? { cwd, branch: wt.branch || null } : null, sessionFile: sessionFile || null, agent: agentInfo(agent), needsSetup: true, ...hint });
			return null;
		}
		setupWaiting.delete(chatId);
	}
	// An old user copy of permission-modes in ~/.pi/agent/extensions would also load: two prompt layers. The app talks to
	// OUR extension through /crust-mode (no clash with a second /mode), and the user is told once. The folder is only read.
	const oldCopy = isDefaultAgent ? permissionOldCopy() : null;
	if (oldCopy && oldCopy.first) hint = { ...hint, oldPermissionCopy: oldCopy.name }; // the one-time toast; the selector asks for the details itself (pi:oldCopy)
	// What the Pi driver reports (agents/pi/process.js); each call carries the handle, and a replaced one is dropped there.
	const sink = {
		isCurrent: (p) => chats.get(chatId)?.handle === p, // false once replaced, closed or the repo changed
		ready: (p, data) => {
			setChatFile(chatId, data.sessionFile);
			send("pi:ready", { chatId, ...data });
		},
		record: (p, record) => {
			if (record.type === "agent_end") prLookup.invalidatePrefix(); // the agent may have pushed or opened a PR
			if (record.type === "claude_pending") return chatPendingRecord(chatId, record.pending); // a fork or rewound chat before its next message: kept so a restart restores it
			if (record.type === "claude_session" && typeof record.sessionId === "string") chatSessionRecord(chatId, record.sessionId); // the session of a Claude Agent chat is only known once it runs (a fork, a rewound chat: its new one)
			if (record.type === "response" && settleMainRequest(record)) return; // answers to requests main itself sent
			send("pi:record", { chatId, record });
		},
		stderr: (p, data) => send("pi:stderr", { chatId, data }),
		ask: (p, prompt, meta) => claudeApprovals.ask(chatId, p, prompt, meta), // Claude Agent's gate asks here; no answer is a deny
		exit: (p, info) => {
			failMainRequests(p, agent.strings.stopped); // before the current check: killed processes are not current any more
			if (info.kind === "timeout") {
				send("pi:exit", { chatId, error: info.error });
				chats.delete(chatId);
			} else if (info.kind === "error") {
				// notInstalled: the program wasn't found (not a vanished folder, which gives the same ENOENT): the UI says "Pi isn't installed yet" and offers setup.
				if (sink.isCurrent(p)) send("pi:exit", { chatId, error: info.error, errorCode: info.errorCode, notInstalled: info.errorCode === "ENOENT" && fs.existsSync(cwd || REPO) });
			} else {
				if (!sink.isCurrent(p)) return; // a replaced process
				send("pi:exit", { chatId, code: info.code, signal: info.signal });
				chats.delete(chatId); // the UI keeps the tab and offers a restart
			}
		},
	};
	// The driver injects crust-context.ts (context breakdown and models used, see context-panel.js), crust-guard.ts (asks to continue after
	// every N tool calls: settings.json toolCallCheckIn, default 40, 0 = off) and advisor.ts (Anthropic's advisor tool, /advisor command).
	// Pi's start arguments are unchanged; another agent gets no `pi` (it brings its own engine).
	const handle = agent.start(isDefaultAgent ? { pi, cwd: cwd || REPO, env: ENV, settings: readSettings(), sessionRef: sessionFile } : { cwd: cwd || REPO, env: ENV, settings: readSettings(), sessionRef: sessionFile, chatId, ...(startOpts || {}) }, sink);
	const chat = { id: chatId, agent, handle, cwd };
	chats.set(chatId, chat);
	if (!openList.some((e) => e.id === chatId)) {
		openList.push({ id: chatId, file: sessionFile || null, cwd, agent: agent.id });
		saveOpenChats();
	} else if (sessionFile) setChatFile(chatId, sessionFile);
	if (cwd) watchWorktree(cwd);
	answeredUi.delete(chatId); // a new process means new request ids
	send("pi:started", { chatId, cwd: cwd || REPO, worktree: cwd ? { cwd, branch: wt.branch || null } : null, sessionFile: sessionFile || null, agent: agentInfo(agent), ...hint });
	return chat;
}

// Open chats of the current repo, in tab order. Survives Pi exits, quit and repo switches (only an explicit close removes an entry).
let openList = []; // [{ id, file }]
let activeChatId = null;
const OPEN_CHATS_FILE = () => path.join(app.getPath("userData"), "open-chats.json");
function readOpenChats() {
	try {
		return JSON.parse(fs.readFileSync(OPEN_CHATS_FILE(), "utf8")) || {};
	} catch {
		return {};
	}
}
function saveOpenChats() {
	if (SELFTEST || !REPO) return;
	const all = readOpenChats();
	all[REPO] = chatAgents.serializeOpenChats(openList, activeChatId); // `agents` (non-Pi chats only) is ignored by older apps
	try {
		fs.mkdirSync(path.dirname(OPEN_CHATS_FILE()), { recursive: true });
		fs.writeFileSync(OPEN_CHATS_FILE(), JSON.stringify(all, null, 2));
	} catch {}
}
// Changes to one entry of the tab list (session file, pending record): src/open-chat-entry.js. A change that touches both is ONE write.
const chatEntries = require("./open-chat-entry").createEntryWriter({ find: (id) => openList.find((x) => x.id === id), save: () => saveOpenChats(), cleanPending: (p) => chatAgents.cleanPending(p) });
const { setChatFile, setChatPending, chatPendingRecord, chatSessionRecord } = chatEntries;

function newChatId() {
	return `chat-${++chatSeq}`;
}

function killAllChats() {
	const old = [...chats.values()];
	chats.clear();
	claudeApprovals.closeAll();
	for (const c of old) {
		held.clear(c.id);
		c.agent.stop(c.handle);
	}
}

function piSend(chatId, record) {
	const c = chats.get(chatId);
	return c ? c.agent.send(c.handle, record) : false;
}

// Requests main itself sends to Pi (Remote): their responses never go to the renderer.
const MAIN_ID = "crust-main-";
const mainPending = new Map(); // id -> { id, handle, agent, settle }
let mainSeq = 0;
// Resolves { success, data | error }, never rejects. id and type can't be overridden by `extra`.
// atSettle() runs synchronously when the answer is read from Pi's stdout, before any later line is handled; its value
// comes back as `mark`: the exact cut between what the answer covers and the events that follow it.
function piRequest(chatId, type, extra = {}, timeoutMs = 60_000, atSettle = null) {
	return new Promise((resolve) => {
		const c = chats.get(chatId);
		const handle = c?.handle;
		if (!c || !c.agent.canSend(handle)) return resolve({ success: false, error: (c ? c.agent : piAgent).strings.notRunning });
		const id = `${MAIN_ID}${++mainSeq}`;
		let timer = null;
		const settle = (result) => {
			clearTimeout(timer);
			mainPending.delete(id);
			if (atSettle) {
				try {
					result = { ...result, mark: atSettle() };
				} catch {}
			}
			resolve(result);
		};
		timer = setTimeout(() => settle({ success: false, error: c.agent.strings.noAnswer }), timeoutMs);
		mainPending.set(id, { id, handle, agent: c.agent, settle });
		c.agent.send(handle, { ...extra, id, type });
	});
}
// True when the response is the answer to one of ours (and has been delivered).
function settleMainRequest(record) {
	const p = typeof record.id === "string" ? mainPending.get(record.id) : null;
	if (!p) return false;
	p.settle(record.success === false ? { success: false, error: record.error || p.agent.strings.refused } : { success: true, data: record.data });
	return true;
}
function failMainRequests(handle, error) {
	for (const p of [...mainPending.values()]) if (p.handle === handle) p.settle({ success: false, error });
}

// Messages paused by Stop, shared by the desktop and the phone (held-queue.js).
const held = require("./held-queue").createHeldQueue({
	request: (chatId, type, extra, timeout) => piRequest(chatId, type, extra, timeout),
	emit: (chatId, list) => send("pi:held", { chatId, held: list }),
});
ipcMain.handle("pi:stop", (_e, chatId) => held.stop(chatId));
ipcMain.handle("pi:heldTake", (_e, chatId, i, text) => held.take(chatId, i, text));
ipcMain.handle("pi:held", (_e, chatId) => held.list(chatId));

// One answer per Pi question, from the desktop or the phone; the other side closes its panel on pi:uiResolved.
const answeredUi = new Map(); // chatId -> Set<requestId> (capped at 200)
function answerUi(chatId, response, by) {
	if (!response || response.type !== "extension_ui_response" || typeof response.id !== "string") return false;
	let done = answeredUi.get(chatId);
	if (!done) answeredUi.set(chatId, (done = new Set()));
	if (done.has(response.id)) return false;
	if (!(claudeApprovals.owns(response) ? claudeApprovals.answer(chatId, response) : piSend(chatId, response))) return false;
	done.add(response.id);
	if (done.size > 200) done.delete(done.values().next().value);
	send("pi:uiResolved", { chatId, id: response.id, by });
	return true;
}

const sessionArg = (f) => (typeof f === "string" && f ? f : undefined);

ipcMain.handle("pi:send", (_e, chatId, record) => (record?.type === "extension_ui_response" ? answerUi(chatId, record, "desktop") : piSend(chatId, record)));
// Returns the new chat's id, or null. Also used by Remote.
// `agentId` is the chat's agent for good (undefined = Pi); an id the registry does not know is refused.
async function newChat(sessionFile, opts, agentId) {
	if (!REPO) return null;
	const wanted = chatAgents.resolveNewChatAgent(agentId, agents);
	if (wanted === null) return null;
	let wt = null;
	if (opts && opts.cwd) {
		wt = typeof opts.cwd === "string" ? await resolveWt(opts.cwd) : null;
		if (!wt || wt.missing) return null; // not a worktree of this repo: don't fall back to the main checkout silently
	}
	const id = newChatId();
	startAgent(id, sessionArg(sessionFile), {}, wt, wanted);
	return id;
}
ipcMain.handle("pi:newChat", (_e, f, o, agentId) => newChat(f, o, agentId));
// A fork of a Claude Agent chat in a NEW tab (the chat's own tab keeps its conversation): from the end (entryId null) or from before the user
// message entryId. The adapter says what to continue (agents/claude forkSpec); the new chat starts like any other and is named "Fork of <title>".
// Returns { ok, chatId, text, title } or { ok:false, error }.
ipcMain.handle("pi:forkChat", async (_e, chatId, o) => {
	const c = chats.get(chatId);
	if (!c || typeof c.agent.forkSpec !== "function" || !c.agent.canSend(c.handle)) return { ok: false, error: "This chat cannot be forked." };
	const entryId = typeof o?.entryId === "string" && o.entryId ? o.entryId : null;
	const title = typeof o?.title === "string" ? o.title.slice(0, 200) : "";
	const spec = await c.agent.forkSpec(c.handle, { entryId, title });
	if (!spec.ok) return { ok: false, error: spec.error || "Fork failed" };
	const entry = openList.find((e) => e.id === chatId);
	const wt = await resolveWt(entry?.cwd || null);
	if (wt && wt.missing) return { ok: false, error: `Worktree ${wt.cwd} no longer exists` };
	const id = newChatId();
	startAgent(id, undefined, { fork: { title: spec.start.title, text: spec.text } }, wt, c.agent.id, { fork: spec.start });
	setChatPending(id, spec.start); // saved at once: closing the app before its first message must not lose the tab
	return { ok: true, chatId: id, text: spec.text, title: spec.start.title };
});
// "Open in main checkout" for a chat whose worktree is gone: the user's explicit choice.
ipcMain.handle("pi:openInMain", (_e, chatId) => {
	const entry = openList.find((e) => e.id === chatId);
	if (!entry || chats.has(chatId)) return false;
	entry.cwd = null;
	saveOpenChats();
	startAgent(chatId, entry.pending ? undefined : entry.file || undefined, entry.pending ? { fork: { title: entry.pending.title } } : {}, null, entry.agent, entry.pending ? { fork: entry.pending } : null);
	return true;
});
ipcMain.handle("pi:sessionFile", (_e, chatId, file) => setChatFile(chatId, file));
ipcMain.handle("pi:activeChat", (_e, chatId) => {
	if (chatId === activeChatId) return;
	activeChatId = chatId;
	saveOpenChats();
});
ipcMain.handle("pi:closeChat", async (_e, chatId) => {
	const entry = openList.find((e) => e.id === chatId);
	openList = openList.filter((e) => e.id !== chatId);
	saveOpenChats();
	held.clear(chatId);
	setupWaiting.delete(chatId);
	claudeApprovals.closeChat(chatId);
	const c = chats.get(chatId);
	chats.delete(chatId);
	c?.agent.stop(c.handle);
	// A worktree chat's folder may be removed next: wait for its Pi to be gone, then kill what is left of its tree
	// (POSIX: SIGKILL to the process group; Windows: taskkill /T /F, only while Pi itself still runs, see kill-tree.js).
	if (entry?.cwd && c?.handle) {
		const exited = () => {
			const st = c.agent.state(c.handle);
			return st.exitCode !== null || st.signalCode !== null;
		};
		if (!exited()) await new Promise((r) => (c.agent.onceExit(c.handle, r), setTimeout(r, 6000)));
		try {
			c.agent.killRemains(c.handle); // stragglers (subagents, commands) too; ESRCH when nothing is left
		} catch {}
		if (!exited()) await new Promise((r) => (c.agent.onceExit(c.handle, r), setTimeout(r, 2000)));
	}
	if (entry?.cwd) unwatchWorktreeIfUnused(entry.cwd);
	return true;
});
// Look for Pi again and rebuild the environment (its folder on PATH): Pi may have been installed while the app was running.
function refreshPi() {
	findPi({ fresh: true });
	ENV = buildEnv();
}
async function restartChat(chatId, sessionFile) {
	refreshPi();
	const oldChat = chats.get(chatId);
	const old = oldChat?.handle;
	const entry = openList.find((e) => e.id === chatId);
	const cwd = entry?.cwd || null;
	const agentId = oldChat?.agent.id || entry?.agent; // a restarted chat keeps its own agent
	chats.delete(chatId);
	claudeApprovals.closeChat(chatId);
	oldChat?.agent.stop(old);
	const file = sessionArg(sessionFile);
	// Resuming a session file: let the old process release it first.
	if (file) await new Promise((r) => (!old || oldChat.agent.state(old).exitCode !== null ? r() : (oldChat.agent.onceExit(old, r), setTimeout(r, 5000))));
	const wt = await resolveWt(cwd);
	// Closed while we waited: don't bring a Pi back for a chat that is gone.
	if (!openList.some((e) => e.id === chatId)) return false;
	const pend = entry && entry.pending ? entry.pending : null; // a fork or rewound chat that has no session of its own yet restarts as itself
	startAgent(chatId, pend ? undefined : file, pend ? { fork: { title: pend.title } } : {}, wt, agentId, pend ? { fork: pend } : null);
	return true;
}
ipcMain.handle("pi:restart", (_e, chatId, sessionFile) => restartChat(chatId, sessionFile));

// ---------------------------------------------------------------------------
// File tree: lazy directory listing plus git status, refreshed on changes.
// ---------------------------------------------------------------------------
// Resolves a repo-relative path and refuses anything outside the repo, also through symlinks: the deepest
// existing ancestor is resolved with realpath before the prefix check.
// `root` is the repo, or a chat's worktree for the git handlers.
function insideRepo(rel, root = REPO) {
	if (!REPO) throw new Error("no repo open");
	let rootReal = REPO_REAL;
	if (root !== REPO) {
		try {
			rootReal = fs.realpathSync.native(root);
		} catch {
			throw new Error("outside repo");
		}
	}
	const abs = path.resolve(root, rel || ".");
	if (IS_WIN ? !withinWin(root, abs) : abs !== root && !abs.startsWith(root + path.sep)) throw new Error("outside repo");
	let probe = abs;
	let rest = "";
	while (!fs.existsSync(probe) && probe !== root) {
		rest = path.join(path.basename(probe), rest);
		probe = path.dirname(probe);
	}
	let real;
	try {
		real = path.join(fs.realpathSync.native(probe), rest);
	} catch {
		throw new Error("outside repo");
	}
	if (IS_WIN ? !withinWin(rootReal, real) : real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error("outside repo (symlink)");
	return abs;
}
// Windows paths compare case-insensitively, which path.relative does (drive letters too): ".." or absolute = outside.
function withinWin(base, p) {
	const r = path.relative(base, p);
	return !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r));
}

// Repo-relative paths go to the UI with "/" on every platform (like git prints them) and may come back with either separator.
const toPosix = (p) => (IS_WIN ? String(p).split(path.sep).join("/") : p);
const gitRel = (rel) => (IS_WIN && typeof rel === "string" ? rel.replace(/\\/g, "/") : rel);

// Worktrees (git worktree, see worktree-main.js): a chat can work in its own checkout of the repo.
const worktreeInfo = (cwd) => require("./worktree-main").findWorktree(REPO, ENV, cwd);
// null = the repo itself, { cwd, branch } = a live worktree, { cwd, missing: true } = asked for but gone.
async function resolveWt(cwd) {
	if (!cwd) return null;
	const w = await worktreeInfo(cwd);
	return w ? { cwd, branch: w.branch || null } : { cwd, missing: true };
}
// The folder the git and checkpoint handlers work in: the folder of the chat the renderer names (not "the active chat" at the
// time main happens to look: tabs can switch in between). Resolved once per call. Throws when the chat's worktree is gone.
// The file tree, editor, commit graph and file index always stay on the main checkout.
async function rootFor(chatId) {
	if (!REPO) throw new Error("no repo open");
	const entry = typeof chatId === "string" ? openList.find((e) => e.id === chatId) : null;
	if (!entry || !entry.cwd) return REPO;
	const wt = await worktreeInfo(entry.cwd);
	if (!wt) throw new Error(`Worktree ${entry.cwd} no longer exists`);
	return entry.cwd;
}

ipcMain.handle("fs:list", async (_e, rel) => {
	const abs = insideRepo(rel);
	const entries = await fs.promises.readdir(abs, { withFileTypes: true });
	return entries
		.filter((d) => !IGNORED.has(d.name))
		.map((d) => ({ name: d.name, dir: d.isDirectory(), path: toPosix(path.relative(REPO, path.join(abs, d.name))) }))
		.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});

// `main`: the file tree always asks for the main checkout; Changes asks for the active chat's root.
ipcMain.handle("git:status", async (_e, main, chatId) => {
	let root = REPO;
	if (REPO && !main) {
		try {
			root = await rootFor(chatId);
		} catch (e) {
			return { branch: null, files: {}, worktree: true, error: e.message };
		}
	}
	return new Promise((resolve) => {
		if (!REPO) return resolve({ branch: null, files: {} });
		const worktree = root !== REPO;
		execFile("git", hardenGitArgs(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root }), { cwd: root, env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 20e6, windowsHide: true }, (err, out) => {
			if (err) return resolve({ branch: null, files: {}, worktree });
			const files = {};
			const parts = out.split("\0");
			for (let i = 0; i < parts.length; i++) {
				const rec = parts[i];
				if (rec.length < 4) continue;
				const code = rec.slice(0, 2);
				files[rec.slice(3)] = code; // keep both columns: index (staged) and worktree
				if (code[0] === "R" || code[0] === "C") i++; // skip the original path of a rename
			}
			execFile("git", hardenGitArgs(["branch", "--show-current"], { cwd: root }), { cwd: root, env: ENV, windowsHide: true }, (_e2, b) => resolve({ branch: (b || "").trim() || null, files, worktree, root }));
		});
	});
});

// Built-in editor: read and write files inside the repo. `mtime` lets the UI spot changes made on disk meanwhile.
const EDITOR_MAX_BYTES = 5 * 1024 * 1024;
ipcMain.handle("fs:read", async (_e, rel) => {
	const abs = insideRepo(rel);
	const st = await fs.promises.stat(abs);
	if (!st.isFile()) return { error: "Not a file." };
	if (st.size > EDITOR_MAX_BYTES) return { error: `Too large to edit here (${(st.size / 1048576).toFixed(1)} MB).`, mtime: st.mtimeMs };
	const buf = await fs.promises.readFile(abs);
	if (buf.subarray(0, 8000).includes(0)) return { error: "Binary file.", binary: true, mtime: st.mtimeMs };
	return { content: buf.toString("utf8"), mtime: st.mtimeMs };
});
ipcMain.handle("fs:stat", async (_e, rel) => {
	try {
		const st = await fs.promises.stat(insideRepo(rel));
		return { mtime: st.mtimeMs, exists: true };
	} catch {
		return { exists: false };
	}
});
ipcMain.handle("fs:write", async (_e, rel, content) => {
	const abs = insideRepo(rel);
	if (abs === REPO) throw new Error("refusing to write the repo root");
	if (typeof content !== "string") throw new Error("content must be a string");
	// Write in place (not via rename) so file modes, hard links and watchers on the file stay intact.
	await fs.promises.writeFile(abs, content, "utf8");
	const st = await fs.promises.stat(abs);
	return { mtime: st.mtimeMs };
});

// The system clipboard via Electron: navigator.clipboard in the renderer can fail silently (focus, permissions).
ipcMain.handle("clipboard:write", (_e, text) => {
	clipboard.writeText(String(text ?? ""));
	return true;
});

ipcMain.handle("fs:openInEditor", (_e, rel) => {
	const abs = insideRepo(rel);
	const fallback = (err) => {
		if (err) shell.showItemInFolder(abs);
	};
	// Windows: `code` is code.cmd, which only runs through cmd.exe. Quoted, so & | < > in names stay literal; % would expand.
	if (IS_WIN) {
		if (abs.includes("%")) fallback(true);
		else execFile(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"code -g "${abs}""`], { env: ENV, windowsHide: true, windowsVerbatimArguments: true }, fallback);
	} else execFile("code", ["-g", abs], { env: ENV }, fallback);
	return true;
});

let watcher;
const extraWatchers = new Map(); // worktree folder -> watcher
// Inside .git only the files a commit, stage, checkout or reset touches count; the rest (objects, logs, locks) is noise.
const GIT_STATE = /^\.git\/(?:worktrees\/[^/]+\/)?(?:index|HEAD|refs\/heads\/.+|packed-refs)$/;
// At most one fs:changed per ~1.5s after quiet, and at least one every 6s under continuous writes (dev servers, builds).
const fireChanged = debounceMax(() => send("fs:changed", {}), 1500, 6000);
// Commits, checkouts and fetches can change what `gh pr view` says (branch, upstream): forget the PR lookups.
const PR_STATE = /^\.git\/(?:worktrees\/[^/]+\/)?(?:HEAD|refs\/(?:heads|remotes)\/.+|packed-refs)$/;
// One filter per watched folder: build folders (dist, out, build) are noise only where that folder's git ignores them.
function changeFilter(root) {
	const ignored = createIgnoreCheck(root, { spawnSync: require("node:child_process").spawnSync });
	return {
		skip: (rel) => isNoise(rel, ignored),
		onChange(file) {
			if (!file) return;
			const rel = file.split(path.sep).join("/");
			if (PR_STATE.test(rel)) prLookup.invalidatePrefix();
			if (!GIT_STATE.test(rel) && isNoise(rel, ignored)) return;
			fireChanged();
		},
	};
}
function watchWorktree(cwd) {
	if (extraWatchers.has(cwd)) return;
	try {
		const f = changeFilter(cwd);
		extraWatchers.set(cwd, watchTree(cwd, { ignored: NOISE_DIRS, skip: f.skip, onChange: f.onChange }));
	} catch (e) {
		console.error("watch failed", e);
	}
}
function unwatchWorktreeIfUnused(cwd) {
	if (openList.some((e) => e.cwd === cwd)) return;
	extraWatchers.get(cwd)?.close();
	extraWatchers.delete(cwd);
}

function watchRepo() {
	watcher?.close();
	watcher = undefined;
	for (const w of extraWatchers.values()) w.close();
	extraWatchers.clear();
	if (!REPO) return;
	try {
		const f = changeFilter(REPO);
		watcher = watchTree(REPO, { ignored: NOISE_DIRS, skip: f.skip, onChange: f.onChange });
	} catch (e) {
		console.error("watch failed", e);
	}
}

// ---------------------------------------------------------------------------
// Embedded browser (a real Chromium view, not an iframe, so OAuth logins work).
// ---------------------------------------------------------------------------
function isLocal(url) {
	try {
		return LOCAL_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

// The dev server uses a self-signed certificate (@vitejs/plugin-basic-ssl): accept it for localhost only.
app.on("certificate-error", (event, _wc, url, _error, _cert, callback) => {
	if (isLocal(url)) {
		event.preventDefault();
		callback(true);
	} else {
		callback(false);
	}
});

// ---------------------------------------------------------------------------
// Zoom: ⌘+ / ⌘- / ⌘0 scale the whole window, the embedded browser included. The UI reports the browser
// slot in CSS pixels; the native view needs window pixels, so its bounds are multiplied by the zoom factor.
// ---------------------------------------------------------------------------
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
function readSettings() {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
	} catch {
		return {};
	}
}
function writeSettings(patch) {
	const next = { ...readSettings(), ...patch };
	fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
}
let zoomLevel = 0;
function setZoom(level) {
	zoomLevel = Math.max(-3, Math.min(5, level));
	win?.webContents.setZoomLevel(zoomLevel);
	viewerTabs.setZoom(zoomLevel);
	applyBrowserBounds();
	writeSettings({ zoomLevel });
}
const zoomFactor = () => (win ? win.webContents.getZoomFactor() : 1);

// The native views keep their real bounds while hidden (setVisible(false)) instead of collapsing to 0x0, so
// capturePage(..., {stayHidden:true}) still has a real size to render at (before/after screenshots). Every tab gets the same bounds;
// only the active one is shown (viewer-tabs-main.js).
function applyBrowserBounds() {
	if (!win) return;
	const z = zoomFactor();
	// While hidden, a zero-size slot (its tab is not shown) must not shrink the view: keep the last real size.
	const css = browserHidden.size && !(browserBounds.width > 0 && browserBounds.height > 0) ? lastRealBounds : browserBounds;
	viewerTabs.layout(
		{ x: Math.round(css.x * z), y: Math.round(css.y * z), width: Math.max(0, Math.round(css.width * z)), height: Math.max(0, Math.round(css.height * z)) },
		browserHidden.size === 0,
	);
}

// The Viewer's tabs (spec: Viewer tabs and project files). The first tab loads the dev address, as the one view always did.
const viewerTabs = require("./viewer-tabs-main").create({
	WebContentsView,
	nativeTheme,
	shell,
	getWin: () => win,
	send: (ch, p) => send(ch, p),
	isLocal,
	isWin: IS_WIN,
	devUrl: DEV_URL,
	getRoot: () => (SELFTEST && projectRootOverride) || REPO,
	getZoomLevel: () => zoomLevel,
	relayout: () => applyBrowserBounds(),
	// The active tab's load failed: hide the view so the themed message in #browser-error shows (same as before, per tab now).
	setErrorHidden: (on) => {
		if (on === browserHidden.has("error")) return;
		if (on) browserHidden.add("error");
		else browserHidden.delete("error");
		applyBrowserBounds();
	},
	breakMode: SELFTEST ? process.env.PI_CRUST_SELFTEST_VIEWER_BREAK || "" : "",
});
viewerTabs.register(ipcMain);

ipcMain.handle("browser:bounds", (_e, b) => {
	browserBounds = b;
	if (b.width > 0 && b.height > 0) lastRealBounds = b;
	applyBrowserBounds();
});
ipcMain.handle("browser:hide", (_e, hidden, reason = "modal") => {
	if (hidden) browserHidden.add(reason);
	else browserHidden.delete(reason);
	applyBrowserBounds();
});
// The app theme (system / light / dark) also drives prefers-color-scheme in the dev
// browser, so pages and Chromium's own pages follow the app instead of the OS.
ipcMain.handle("browser:theme", (_e, setting, bg) => {
	nativeTheme.themeSource = ["light", "dark"].includes(setting) ? setting : "system";
	if (typeof bg === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\))$/i.test(bg)) {
		viewerTabs.setBackground(bg);
		win?.setBackgroundColor(bg);
	}
});
ipcMain.handle("browser:navigate", (_e, url) => viewerTabs.navigate(url));
ipcMain.handle("browser:action", (_e, action) => viewerTabs.action(action));

ipcMain.handle("browser:pick", async (_e, opts) => {
	try {
		const r = await viewerTabs.pick(REPO, opts);
		require("./browser-tools-main").notePick?.(r)?.catch(() => {}); // last picked element = target for forced states
		return r;
	} catch (e) {
		return { error: String((e && e.message) || e) };
	}
});

// Figma desktop picker: current selection via the Figma desktop MCP server.
// File link and status IPC live in figma-main.js (per-project link, falls back to the old app-wide value and the env var).
const figmaMain = require("./figma-main").register({ ipcMain, readSettings, writeSettings, selftest: SELFTEST, get repo() { return REPO; } });
const figmaFile = () => require("./figma-main").legacyFile(figmaMain.file());
const figmaError = (e) => require("./figma-status").figmaError(e);
ipcMain.handle("figma:pickSelection", async () => {
	try {
		if (!figmaFile().key) return { error: "The Figma picker needs the file link. Paste it in Design › Figma status.", needsFileLink: true };
		const { callTool } = require("./figma-mcp");
		const { buildBlock } = require("./figma-selection");
		const defsText = await callTool("get_variable_defs", {});
		const context = await callTool("get_design_context", { clientLanguages: "typescript", clientFrameworks: "react" });
		const f = figmaFile();
		const block = buildBlock({ context, defsText, fileKey: f.key, fileName: f.name });
		if (!block) return { error: "Couldn't read the selection from Figma." };
		return { block };
	} catch (e) {
		return { error: figmaError(e) };
	}
});

// The embedded browser is a separate WebContentsView; once it held focus, clicking the UI focuses the
// DOM element but not the UI's webContents, so Chromium draws no caret. Hand focus back explicitly.
ipcMain.on("ui:focus", () => {
	if (win && !win.isDestroyed() && !win.webContents.isFocused()) win.webContents.focus();
});
// PI_CRUST_SELFTEST_ONLY=timeline,annotate: run only those tour steps (by feature script name; "core" = the built-in tour).
const SELFTEST_ONLY = SELFTEST ? (process.env.PI_CRUST_SELFTEST_ONLY || "").split(",").map((s) => s.trim().toLowerCase().replace(/\.js$/, "")).filter(Boolean) : [];
ipcMain.handle("app:info", () => ({ repo: REPO, devUrl: DEV_URL, selftest: SELFTEST, selftestOnly: SELFTEST_ONLY, selftestNoPrompt: SELFTEST && process.env.PI_CRUST_SELFTEST_NOPROMPT === "1", selftestNoPi: SELFTEST && process.env.PI_CRUST_SELFTEST_NO_PI === "1", selftestClaudeFake: !!(claudeSetup && claudeSetup.fake), selftestClaudeBreak: SELFTEST && process.env.PI_CRUST_SELFTEST_CLAUDE_BREAK === "1" }));

// ---------------------------------------------------------------------------
// Repos: recent list, discovery, switching.
// ---------------------------------------------------------------------------
const RECENT_FILE = () => path.join(app.getPath("userData"), "recent-repos.json");
function readRecent() {
	try {
		return JSON.parse(fs.readFileSync(RECENT_FILE(), "utf8")).filter((r) => fs.existsSync(r.path));
	} catch {
		return [];
	}
}
function rememberRepo(p) {
	const list = [{ path: p, openedAt: Date.now() }, ...readRecent().filter((r) => r.path !== p)].slice(0, 15);
	fs.mkdirSync(path.dirname(RECENT_FILE()), { recursive: true });
	fs.writeFileSync(RECENT_FILE(), JSON.stringify(list, null, 2));
}

// Git repos in the usual places: ~/Documents, ~/Projects, ~/code, ... (their direct children).
async function discoverRepos() {
	const home = os.homedir();
	const roots = ["Documents", "Projects", "projects", "code", "Code", "dev", "src", "repos", "git", "Developer", "workspace"].map((d) => path.join(home, d));
	const found = [];
	for (const root of roots) {
		let entries;
		try {
			entries = await fs.promises.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			const p = path.join(root, e.name);
			if (fs.existsSync(path.join(p, ".git"))) found.push(p);
		}
	}
	return found;
}

ipcMain.handle("repos:list", async () => {
	const recent = readRecent();
	const recentPaths = new Set(recent.map((r) => r.path));
	const discovered = (await discoverRepos()).filter((p) => !recentPaths.has(p)).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
	return { current: REPO, recent, discovered, home: os.homedir() };
});

ipcMain.handle("repos:browse", async () => {
	const r = await dialog.showOpenDialog(win, { title: "Open a repository", properties: ["openDirectory"], defaultPath: path.join(os.homedir(), "Documents") });
	return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("repos:open", (_e, p) => openRepo(p));

// The UI asks once it is listening: open the repo given on the command line, if any; otherwise it shows the picker (the chosen repo reopens its saved chats).
ipcMain.handle("ui:ready", () => {
	if (REPO) return { repo: REPO };
	const given =
		repoFromArgs(process.argv) ||
		(process.env.PI_CRUST_CWD && path.resolve(process.env.PI_CRUST_CWD)) ||
		(SELFTEST ? path.join(__dirname, "..") : null);
	if (!given) return { repo: null };
	const r = openRepo(given);
	return { repo: r.ok ? REPO : null };
});

// Switch Pi, the file watcher and the terminals to another repo.
function openRepo(p) {
	const target = p && path.resolve(p);
	if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, error: `Not a folder: ${p}` };
	if (target === REPO && chats.size) return { ok: true, repo: REPO };
	REPO = target;
	try {
		REPO_REAL = fs.realpathSync.native(REPO);
	} catch {
		REPO_REAL = REPO;
	}
	ENV = buildEnv();
	rememberRepo(REPO);
	for (const [id, t] of terms) {
		clearInterval(t._procPoll);
		send("term:proc", { id, name: null, since: null });
		try {
			t.kill();
		} catch {}
	}
	terms.clear();
	killAllChats();
	openList = [];
	activeChatId = null;
	watchRepo();
	win?.setTitle(`Pi Crust — ${path.basename(REPO)}`);
	send("repo:changed", { repo: REPO });
	// Bring back the chats that were open for this repo, each resuming its session.
	const saved = SELFTEST ? {} : readOpenChats()[REPO] || {};
	openList = chatAgents.restoreEntries(saved, (f) => fs.existsSync(f)).map((e) => ({ id: newChatId(), ...e })); // each keeps its agent; a missing one is Pi
	activeChatId = (chatAgents.activeOf(saved, openList) || openList[0])?.id || null;
	for (const e of openList) delete e.wasActive;
	const list = [...openList];
	if (!openList.length) startAgent(newChatId());
	// A worktree chat is checked (async, cached) before its Pi starts; a vanished worktree is reported, not replaced by the repo.
	const mine = REPO;
	const active = activeChatId;
	(async () => {
		for (const e of list) {
			const wt = await resolveWt(e.cwd);
			if (REPO !== mine || !openList.includes(e)) return;
			if (!agents.has(e.agent)) {
				// An agent this build does not have: the tab stays with the reason, it is not dropped and not turned into a Pi chat.
				const stub = { id: e.agent, label: e.agent, capabilities: {} };
				send("pi:started", { chatId: e.id, cwd: e.cwd || REPO, worktree: null, sessionFile: e.file || null, agent: stub, restore: true, active: e.id === active });
				send("pi:exit", { chatId: e.id, error: `This chat belongs to the agent "${e.agent}", which this version does not have.` });
				continue;
			}
			// A fork tab or rewound chat that never got its next message: the same chat again (title, the part of the old chat it shows).
			if (e.pending) startAgent(e.id, undefined, { restore: true, active: e.id === active, fork: { title: e.pending.title } }, wt, e.agent, { fork: e.pending });
			else startAgent(e.id, e.file, { restore: true, active: e.id === active }, wt, e.agent);
		}
	})();
	return { ok: true, repo: REPO };
}

// ---------------------------------------------------------------------------
// Git: diffs, discard, commit, push.
// ---------------------------------------------------------------------------
// `opts.cwd` is the folder to work in (default: the repo). A folder that no longer exists is reported, never replaced by another one.
// `root\0branch\0host` -> PR info or null. Only a found PR and a definite "no PR" are kept for a minute; a gh or network failure is not.
const prLookup = createPrLookup(async (key) => {
	const [root, branch, host] = key.split("\0");
	const r = await run("gh", ["pr", "view", branch, "--json", "number,url,state"], { cwd: root, env: { ...ENV, GH_HOST: host }, timeout: 15_000 });
	if (r.ok) {
		try {
			return { value: JSON.parse(r.stdout), cacheable: true };
		} catch {
			return { value: null, cacheable: false };
		}
	}
	return { value: null, cacheable: /no pull requests? found/i.test(r.stderr) };
}, 60_000);
function run(cmd, args, opts = {}) {
	return new Promise((resolve) => {
		const cwd = opts.cwd || REPO;
		if (cwd && !fs.existsSync(cwd)) return resolve({ ok: false, code: 1, stdout: "", stderr: `Folder no longer exists: ${cwd}` });
		execFile(cmd, args, { env: ENV, maxBuffer: 50e6, windowsHide: true, ...opts, cwd }, (err, stdout, stderr) =>
			resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") || (err && err.message) || "" }),
		);
	});
}

// Read-only git for the Changes tab, graph and palette: hardened, so the repository can't make it run code (git-harden.js).
// User actions (commit, push, discard) use run("git", ...) and keep the user's hooks.
const gitRead = (args, opts) => run("git", hardenGitArgs(args, { cwd: opts && opts.cwd }), opts);

ipcMain.handle("git:diff", async (_e, chatId, rel, status) => {
	const root = await rootFor(chatId);
	insideRepo(rel, root);
	rel = gitRel(rel);
	if (status === "??") {
		// Untracked: compare against nothing (exit code 1 means "differences", not an error).
		const r = await gitRead(["diff", "--no-color", "--no-index", "--", "/dev/null", rel], { cwd: root });
		return r.stdout || r.stderr;
	}
	const r = await gitRead(["diff", "--no-color", "HEAD", "--", rel], { cwd: root });
	return r.ok ? r.stdout : r.stderr;
});

// The file's text at HEAD (the left side of the editable diff). Untracked or newly added files have none.
ipcMain.handle("git:original", async (_e, chatId, rel, status) => {
	const root = await rootFor(chatId);
	insideRepo(rel, root);
	rel = gitRel(rel);
	if (status === "??" || (status && status[0] === "A")) return { content: "" };
	const r = await gitRead(["show", `HEAD:./${rel}`], { cwd: root });
	if (!r.ok) return { content: "" };
	if (r.stdout.slice(0, 8000).includes("\0")) return { error: "Binary file.", binary: true };
	return { content: r.stdout };
});

ipcMain.handle("git:discard", async (_e, chatId, rel, status) => {
	const root = await rootFor(chatId);
	const abs = insideRepo(rel, root);
	rel = gitRel(rel);
	if (abs === root) throw new Error("refusing to discard the repo root");
	if (status === "??") {
		await fs.promises.rm(abs, { recursive: true, force: true });
		return { ok: true };
	}
	if (status && status.includes("A")) {
		// Newly added file: unstage and remove.
		await run("git", ["rm", "--cached", "--quiet", "--", rel], { cwd: root });
		await fs.promises.rm(abs, { force: true });
		return { ok: true };
	}
	return run("git", ["restore", "--staged", "--worktree", "--source=HEAD", "--", rel], { cwd: root });
});

ipcMain.handle("git:commit", async (_e, chatId, message, push) => {
	if (!String(message || "").trim()) return { ok: false, stderr: "Empty commit message" };
	let root;
	try {
		root = await rootFor(chatId);
	} catch (e) {
		return { ok: false, stderr: e.message };
	}
	// The message goes through a temp file, never inline (repo rule).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-commit-"));
	const file = path.join(dir, "message.txt");
	fs.writeFileSync(file, message.trim() + "\n", { mode: 0o600 });
	try {
		const add = await run("git", ["add", "-A"], { cwd: root });
		if (!add.ok) return add;
		const commit = await run("git", ["commit", "-F", file], { cwd: root, timeout: 600_000 }); // hooks (lefthook) may run
		if (!commit.ok || !push) return commit;
		const pushed = await gitPush(root);
		return { ...pushed, stdout: `${commit.stdout}\n${pushed.stdout}` };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function gitPush(root) {
	const branch = (await run("git", ["branch", "--show-current"], { cwd: root })).stdout.trim();
	if (!branch) return { ok: false, stderr: "Detached HEAD: nothing to push" };
	const pushed = await run("git", ["push", "-u", "origin", branch], { cwd: root, timeout: 600_000 });
	if (pushed.ok) prLookup.invalidatePrefix(`${root}\0${branch}\0`);
	return pushed;
}
ipcMain.handle("git:push", async (_e, chatId) => {
	try {
		return await gitPush(await rootFor(chatId));
	} catch (e) {
		return { ok: false, stderr: e.message };
	}
});

ipcMain.handle("git:info", async (_e, chatId) => {
	let root;
	try {
		root = await rootFor(chatId);
	} catch (e) {
		return { branch: null, ahead: null, hasUpstream: false, pr: null, error: e.message };
	}
	const [branch, ahead, remote] = await Promise.all([
		gitRead(["branch", "--show-current"], { cwd: root }),
		gitRead(["rev-list", "--count", "@{upstream}..HEAD"], { cwd: root }),
		gitRead(["remote", "get-url", "origin"], { cwd: root }),
	]);
	const b = branch.stdout.trim();
	let pr = null;
	const host = (remote.stdout.match(/^(?:https?:\/\/|git@)([^/:]+)/) || [])[1];
	if (b && host) {
		pr = await prLookup.get(`${root}\0${b}\0${host}`);
	}
	return { branch: b || null, ahead: ahead.ok ? Number(ahead.stdout.trim()) : null, hasUpstream: ahead.ok, pr };
});

// Commit graph: the newest commits of all branches (or only HEAD), with parents and ref names.
ipcMain.handle("git:log", async (_e, opts = {}) => {
	if (!REPO) return { commits: [] };
	const limit = Math.min(Number(opts.limit) || 400, 2000);
	const fmt = ["%H", "%P", "%an", "%at", "%D", "%s"].join("%x1f") + "%x1e";
	const args = ["log", `--max-count=${limit}`, "--date-order", `--format=${fmt}`];
	if (opts.all !== false) args.push("--exclude=refs/pi-crust/*", "--all"); // checkpoints live under refs/pi-crust/
	const r = await gitRead(args, { cwd: REPO });
	if (!r.ok) return { commits: [], error: r.stderr.trim() };
	const commits = r.stdout
		.split("\x1e")
		.map((rec) => rec.replace(/^\n/, ""))
		.filter(Boolean)
		.map((rec) => {
			const [hash, parents, author, at, refs, subject] = rec.split("\x1f");
			return { hash, parents: parents ? parents.split(" ") : [], author, at: Number(at) * 1000, refs: refs ? refs.split(", ") : [], subject };
		});
	return { commits };
});

// A cheap fingerprint of HEAD and all refs, so the UI can redraw the graph only when something changed.
ipcMain.handle("git:refsStamp", async () => {
	if (!REPO) return "";
	const [head, refs] = await Promise.all([gitRead(["rev-parse", "HEAD"], { cwd: REPO }), gitRead(["for-each-ref", "--format=%(objectname)%(refname)"], { cwd: REPO })]);
	const own = refs.stdout.split("\n").filter((l) => !l.includes("refs/pi-crust/")).join("\n"); // not the checkpoints
	return head.stdout.trim() + own.length + own.slice(0, 4000);
});

ipcMain.handle("git:show", async (_e, hash) => {
	if (!REPO || !/^[0-9a-f]{7,40}$/.test(String(hash))) return "";
	const r = await gitRead(["show", "--no-color", "--stat", "--patch", "--format=fuller", hash], { cwd: REPO });
	return r.ok ? r.stdout : r.stderr;
});

// Every tracked and untracked (not ignored) file, for the command palette.
ipcMain.handle("fs:index", async () => {
	if (!REPO) return [];
	const r = await gitRead(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO });
	return r.ok ? [...new Set(r.stdout.split("\0").filter(Boolean))] : [];
});

// ---------------------------------------------------------------------------
// Sessions: Pi stores them per working folder in ~/.pi/agent/sessions/--<cwd with dashes>--/
// ---------------------------------------------------------------------------
const realOf = (p) => {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return p;
	}
};
ipcMain.handle("sessions:list", async () => {
	if (!REPO) return [];
	// The repo's own sessions, plus those of its existing worktrees (chats started with "New chat in worktree").
	const worktrees = [];
	try {
		for (const wt of await require("./worktree-main").listWorktrees(REPO, ENV)) if (realOf(wt.path) !== REPO_REAL && fs.existsSync(wt.path)) worktrees.push({ cwd: wt.path, branch: wt.branch });
	} catch {}
	const { sessions, status } = await chatAgents.listAllSessions({ adapters: agents.list(), repo: REPO, worktrees });
	sessionsStatus = status;
	return sessions;
});
// Per agent: did its last history list work, and why not. For the history picker of a later UI task.
let sessionsStatus = {};
ipcMain.handle("sessions:status", () => sessionsStatus);

// ---------------------------------------------------------------------------
// Terminal: a login shell in the repo through node-pty.
// ---------------------------------------------------------------------------
let ptyMod;
const terms = new Map();
// Windows shell: PowerShell 7 (pwsh.exe) when on PATH, else Windows PowerShell, else %ComSpec%. No login flag there.
function winShell() {
	const pwsh = onPath("pwsh.exe", ENV);
	if (pwsh) return [pwsh, ["-NoLogo"]];
	const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (fs.existsSync(ps)) return [ps, ["-NoLogo"]];
	return [process.env.ComSpec || "cmd.exe", []];
}
ipcMain.handle("term:start", (_e, id, cols, rows) => {
	if (!REPO) return { ok: false, error: "Open a repo first" };
	if (terms.has(id)) return { ok: true, existing: true };
	try {
		ptyMod = ptyMod || require("node-pty");
	} catch (e) {
		return { ok: false, error: `node-pty failed to load: ${e.message}` };
	}
	const [shellPath, shellArgs] = IS_WIN ? winShell() : [process.env.SHELL || "/bin/zsh", ["-l"]];
	const p = ptyMod.spawn(shellPath, shellArgs, { name: "xterm-256color", cols: cols || 100, rows: rows || 30, cwd: REPO, env: { ...ENV, TERM: "xterm-256color", COLORTERM: "truecolor" } });
	terms.set(id, p);
	// Foreground process of the shell, polled once a second: tells the UI what runs and since when.
	// Not on Windows: there node-pty's p.process is always the terminal name, never the foreground process.
	const shellName = path.basename(shellPath);
	const idle = new Set([shellName, `-${shellName}`, "login", ""]);
	let fg = null; // { name, since }
	p._procPoll = IS_WIN ? null : setInterval(() => {
		let name;
		try {
			name = String(p.process || "");
		} catch {
			return;
		}
		const busy = !idle.has(name);
		if (busy && !fg) fg = { name, since: Date.now() };
		else if (!busy && fg) fg = null;
		else if (busy && fg.name !== name) fg.name = name; // npm -> node: same run, keep `since`
		else return;
		send("term:proc", { id, name: fg?.name || null, since: fg?.since || null });
	}, 1000);
	p.onData((d) => send("term:data", { id, data: d }));
	p.onExit(({ exitCode }) => {
		clearInterval(p._procPoll);
		if (terms.get(id) !== p) return; // replaced by a newer shell
		terms.delete(id);
		send("term:proc", { id, name: null, since: null });
		send("term:exit", { id, exitCode });
	});
	return { ok: true };
});
ipcMain.handle("term:input", (_e, id, data) => terms.get(id)?.write(data));
ipcMain.handle("term:resize", (_e, id, cols, rows) => {
	try {
		terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows));
	} catch {}
});
ipcMain.handle("term:kill", (_e, id) => {
	const p = terms.get(id);
	terms.delete(id);
	if (p) clearInterval(p._procPoll);
	try {
		p?.kill();
	} catch {}
});
app.on("before-quit", () => {
	for (const p of terms.values()) {
		clearInterval(p._procPoll);
		try {
			p.kill();
		} catch {}
	}
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
// Right-click menu: spelling suggestions for misspelled words, plus cut/copy/paste.
// Monaco and xterm cancel the DOM contextmenu event, so they keep their own menus.
function attachContextMenu(wc) {
	wc.on("context-menu", (_e, params) => {
		const items = [];
		if (params.misspelledWord) {
			for (const s of params.dictionarySuggestions.slice(0, 6)) {
				items.push({ label: s, click: () => wc.replaceMisspelling(s) });
			}
			if (!params.dictionarySuggestions.length) items.push({ label: "No suggestions", enabled: false });
			items.push(
				{ type: "separator" },
				{ label: "Add to Dictionary", click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
				{ type: "separator" },
			);
		}
		const f = params.editFlags;
		if (params.isEditable) {
			items.push(
				{ role: "undo", enabled: f.canUndo },
				{ role: "redo", enabled: f.canRedo },
				{ type: "separator" },
				{ role: "cut", enabled: f.canCut },
				{ role: "copy", enabled: f.canCopy },
				{ role: "paste", enabled: f.canPaste },
				{ role: "selectAll", enabled: f.canSelectAll },
			);
		} else if (params.selectionText.trim()) {
			items.push({ role: "copy", enabled: f.canCopy });
		}
		if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) });
	});
}

function createWindow() {
	win = new BrowserWindow({
		width: 1680,
		height: 1000,
		minWidth: 1000,
		minHeight: 600,
		title: "Pi Crust",
		show: !START_HIDDEN,
		...(SELFTEST && process.env.PI_CRUST_SELFTEST_OFFSCREEN === "1" ? { x: -4000, y: -4000, focusable: false, skipTaskbar: true } : {}), // selftest only: no window on the user's screen
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1b" : "#eef0f0",
		webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: !(SELFTEST && process.env.PI_CRUST_SELFTEST_OFFSCREEN === "1") }, // offscreen selftest: keep painting so captures are current
	});
	win.loadFile(path.join(__dirname, "index.html"));
	for (const ev of ["focus", "blur"]) win.on(ev, () => send("app:focus", ev === "focus"));
	attachContextMenu(win.webContents);
	zoomLevel = Number(readSettings().zoomLevel) || 0;
	win.webContents.on("did-finish-load", () => setZoom(zoomLevel));
	// Pinch or ctrl+scroll zoom in the UI: keep the browser view in step.
	win.webContents.on("zoom-changed", (_e, dir) => setZoom(zoomLevel + (dir === "in" ? 0.5 : -0.5)));
	// Links in chat: localhost goes to the embedded browser, everything else to the system browser.
	const openLink = (url) => {
		try {
			const proto = new URL(url).protocol;
			if (proto !== "http:" && proto !== "https:") return;
		} catch {
			return;
		}
		if (isLocal(url)) viewerTabs.navigate(url).catch(() => {});
		else shell.openExternal(url);
	};
	win.webContents.setWindowOpenHandler(({ url }) => {
		openLink(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (e, url) => {
		if (url !== win.webContents.getURL()) {
			e.preventDefault();
			openLink(url);
		}
	});
	viewerTabs.init();
	win.webContents.once("did-finish-load", () => {
		if (SELFTEST) runSelftest();
	});
	// Closing hides the window and keeps Pi running, so reopening is instant; ⌘Q quits for real.
	// Windows: closing quits (no Dock to bring a hidden window back, and running Pis would keep their folders locked).
	win.on("close", (e) => {
		if (!quitting && !SELFTEST && !IS_WIN) {
			e.preventDefault();
			win.hide();
		}
	});
	win.on("closed", () => {
		claudeApprovals.closeAll(); // nobody can answer any more: every open prompt is a deny
		win = undefined;
	});
}

const SELFTEST_DIR = path.join(__dirname, "..", "out");
const SELFTEST_RUN = Date.now();

async function runSelftest() {
	fs.mkdirSync(SELFTEST_DIR, { recursive: true });
	win.webContents.on("console-message", (e) => {
		const level = e.level ?? e.params?.level;
		if (level === "error" || level === "warning" || level >= 2) console.log(`[ui ${level}] ${e.message ?? e.params?.message}`);
	});
	const prompt = process.env.PI_CRUST_SELFTEST_PROMPT || "Reply with one short sentence: which folder are you working in?";
	await new Promise((r) => setTimeout(r, 4000));
	if (process.env.PI_CRUST_SELFTEST_NOPROMPT !== "1") win.webContents.send("selftest:prompt", prompt); // NOPROMPT=1: no message to Pi
	ipcMain.once("selftest:done", async () => {
		await new Promise((r) => setTimeout(r, 1000));
		await capture("final");
		app.quit();
	});
	setTimeout(async () => {
		console.log("SELFTEST timeout");
		await capture("timeout");
		app.quit();
	}, Number(process.env.PI_CRUST_SELFTEST_TIMEOUT || 240000));
}

// crop: { x, y, width, height, scale } in CSS pixels: a part of the window, enlarged (selftest screenshots of small details)
async function capture(name, crop) {
	try {
		if (typeof name !== "string" || !/^[\w-]+$/.test(name)) throw new Error("invalid capture name");
		const file = path.join(SELFTEST_DIR, `${SELFTEST_RUN}-${name}.png`);
		let img = crop ? await win.webContents.capturePage({ x: Math.round(crop.x), y: Math.round(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) }) : await win.webContents.capturePage();
		if (crop && crop.scale > 1) {
			const s = img.getSize();
			img = img.resize({ width: Math.round(s.width * crop.scale), height: Math.round(s.height * crop.scale), quality: "best" });
		}
		fs.writeFileSync(file, img.toPNG());
		console.log(`SELFTEST screenshot: ${file}`);
		return file;
	} catch (e) {
		console.error("capture failed", e);
	}
}
if (SELFTEST) {
	ipcMain.handle("selftest:capture", (_e, name, crop) => capture(name, crop));
	ipcMain.handle("selftest:zoom", (_e, level) => setZoom(level));
	ipcMain.handle("selftest:resize", (_e, w, h) => (win.setSize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))), win.getSize()));
	ipcMain.handle("selftest:bounds", () => ({ view: viewerTabs.activeView().getBounds(), z: zoomFactor(), visible: viewerTabs.activeView().getVisible(), hidden: [...browserHidden] }));
	// The offscreen selftest window is never focused: let the page behave as if it were (so :focus-visible rings show).
	ipcMain.handle("selftest:focusEmulation", async (_e, on) => {
		const d = win.webContents.debugger;
		if (!d.isAttached()) d.attach("1.3");
		await d.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: !!on });
	});
}

// A menu without the default ⌘R (it would reload the UI and lose the chat view).
function buildMenu() {
	const template = [
		IS_DARWIN ? { role: "appMenu" } : { role: "fileMenu" }, // fileMenu: Exit / Quit elsewhere
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				{ label: "Reload Page in Viewer Tab", accelerator: "CmdOrCtrl+R", click: () => viewerTabs.reloadActive() },
				{ label: "Toggle Crust DevTools", accelerator: "Alt+CmdOrCtrl+I", click: () => win?.webContents.toggleDevTools() },
				{ type: "separator" },
				{ label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => setZoom(0) },
				{ label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => setZoom(zoomLevel + 0.5) },
				{ label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => setZoom(zoomLevel + 0.5), visible: false, acceleratorWorksWhenHidden: true },
				{ label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => setZoom(zoomLevel - 0.5) },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		// Windows: no Close (Ctrl+W) here, closing the window quits the app and every chat; File > Exit stays.
		IS_WIN ? { label: "Window", submenu: [{ role: "minimize" }] } : { role: "windowMenu" },
		require("./help-menu").helpMenu({ send, openExternal: (url) => shell.openExternal(url) }),
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Quick start: one instance, a global hotkey, Dock click brings the window back.
// ---------------------------------------------------------------------------
const HOTKEY = process.env.PI_CRUST_HOTKEY || (IS_WIN ? "Alt+Ctrl+P" : "Alt+Command+P");
let quitting = false;

// badge, bounce and showWindow: one module, nothing happens in a selftest run (src/attention-main.js).
const attention = require("./attention-main").createAttention({ selftest: SELFTEST, getWin: () => win, app, isDarwin: IS_DARWIN, isWin: IS_WIN, badgeIcon: (n) => badgeIcon(n), createWindow: () => createWindow() });
const showWindow = () => attention.showWindow();
function toggleWindow() {
	if (win && win.isVisible() && win.isFocused()) win.hide();
	else showWindow();
}

// Settings, layout and recent repos live in ~/Library/Application Support/pi-crust (Windows: %APPDATA%\pi-crust). Set before the single-instance
// lock (which lives there too); carry over the folder from when the app was called Pi Studio.
{
	const appData = app.getPath("appData");
	const userData = path.join(appData, "pi-crust");
	const legacy = path.join(appData, "pi-studio");
	// A person's trial (PI_CRUST_USERDATA, unpackaged only, src/trial.js) gets its own folder and leaves the real one, and the old Pi Studio folder, alone.
	const trialData = require("./trial").userDataOverride({ isPackaged: app.isPackaged });
	try {
		if (!trialData && !fs.existsSync(userData) && fs.existsSync(legacy)) fs.renameSync(legacy, userData);
	} catch {}
	app.setPath("userData", (SELFTEST && process.env.PI_CRUST_SELFTEST_USERDATA) || trialData || userData); // the self-test's folder keeps test runs out of the user's real settings and recent projects
}
const isPrimary = SELFTEST || app.requestSingleInstanceLock();
if (!isPrimary) {
	app.quit(); // already running: the first instance gets "second-instance" and shows itself
} else {
	// `pi-crust <path>` while running: switch to that repo and come to the front.
	app.on("second-instance", (_e, argv) => {
		showWindow();
		const p = repoFromArgs(argv);
		if (p) openRepo(p);
	});
}
app.on("activate", showWindow); // Dock icon click
app.on("before-quit", () => {
	quitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());

// App-level IPC for notifications (src/notify.js).
ipcMain.on("app:isSelftestRun", (e) => (e.returnValue = SELFTEST)); // read once by the preload: the renderer cannot change it (src/native-notify.js)
ipcMain.handle("app:isFocused", () => !!win && !win.isDestroyed() && win.isFocused());
ipcMain.handle("app:badge", (_e, n) => attention.badge(n));
ipcMain.handle("app:show", () => showWindow());
ipcMain.handle("app:bounce", () => attention.bounce());

// Windows taskbar overlay: a red dot with the count ("9+" above 9), drawn as a 32x32 BGRA bitmap (shown at 16 px).
const GLYPHS = { 0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001001001001", 8: "111101111101111", 9: "111101111001111", "+": "000010111010000" };
function badgeIcon(count) {
	const { nativeImage } = require("electron");
	const S = 32;
	const buf = Buffer.alloc(S * S * 4);
	const put = (x, y, b, g, r, a) => {
		const i = (y * S + x) * 4;
		buf[i] = b;
		buf[i + 1] = g;
		buf[i + 2] = r;
		buf[i + 3] = a;
	};
	for (let y = 0; y < S; y++)
		for (let x = 0; x < S; x++) {
			const a = Math.max(0, Math.min(1, 15.5 - Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2)));
			if (a) put(x, y, Math.round(0x3b * a), Math.round(0x3b * a), Math.round(0xe5 * a), Math.round(255 * a)); // premultiplied
		}
	const text = count > 9 ? "9+" : String(count);
	const scale = text.length > 1 ? 3 : 4;
	const gap = scale;
	const w = text.length * 3 * scale + (text.length - 1) * gap;
	const x0 = Math.floor((S - w) / 2);
	const y0 = Math.floor((S - 5 * scale) / 2);
	[...text].forEach((ch, n) => {
		const bits = GLYPHS[ch];
		for (let row = 0; row < 5; row++)
			for (let col = 0; col < 3; col++) {
				if (bits[row * 3 + col] !== "1") continue;
				for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x0 + n * (3 * scale + gap) + col * scale + dx, y0 + row * scale + dy, 255, 255, 255, 255);
			}
	});
	return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
}

// What feature modules (src/<feature>-main.js, each exporting register(ctx)) get to work with.
// Getters, because repo, window and browser view change over the app's life.
const ctx = {
	agents: agents.readOnly(), // lookups only: a local plugin cannot register an agent
	get repo() {
		return REPO;
	},
	get env() {
		return ENV;
	},
	get win() {
		return win;
	},
	get browserView() {
		return viewerTabs.activeView(); // the active tab's view
	},
	// The dev browser's last load failed (Chromium's error page, hidden behind #browser-error): nothing to screenshot.
	browserFailed: () => browserHidden.has("error"),
	get selftest() {
		return SELFTEST;
	},
	send,
	windowIdOfChat: (chatId) => (win && !win.isDestroyed() && openList.some((e) => e.id === chatId) ? win.webContents.id : null), // the one window shows every open chat
	setupWaitingChats: () => [...setupWaiting], // chats that wait for their agent's setup (the engine download is only accepted for one of them)
	// Remote (remote-main.js): talk to Pi and own chats from outside the renderer.
	piSend,
	piRequest,
	answerUi,
	stopChat: (chatId) => held.stop(chatId),
	heldTake: (chatId, i, text) => held.take(chatId, i, text),
	newChat,
	restartChat,
	addSendTap: (fn) => (sendTaps.add(fn), () => sendTaps.delete(fn)),
	openChats: () => openList.map((e) => ({ id: e.id, file: e.file || null, cwd: e.cwd || null, agent: e.agent || "pi", running: chats.has(e.id) })),
	get activeChatId() {
		return activeChatId;
	},
	run,
	findPi,
	refreshPi,
	devUrl: DEV_URL,
	figmaStatus: () => figmaMain.status(),
	insideRepo,
	readSettings,
	writeSettings,
	showWindow,
	app,
	ipcMain,
	getBrowserBounds: () => browserBounds,
	// The folder of a chat's worktree, or the repo itself (checkpoints work there). Throws when the worktree is gone.
	rootFor,
	// { cwd, pid } of a running chat (self-test).
	chatInfo: (id) => {
		const c = chats.get(id);
		return c ? { cwd: openList.find((e) => e.id === id)?.cwd || null, pid: c.agent.state(c.handle).pid } : null;
	},
};
// Feature modules register here, one line each: require("./x-main").register(ctx);
require("./checkpoints-main").register(ctx);
require("./snap-main").register(ctx);
require("./design-main").register(ctx);
require("./storybook-main").register(ctx);
require("./figma-bridge-main").register(ctx);
require("./worktree-main").register(ctx);
require("./voice-main").register(ctx);
require("./browser-tools-main").register(ctx);
require("./subscriptions-main").register(ctx);
require("./health-main").register(ctx);
require("./health-install").register(ctx);
require("./init-git-main").register(ctx);
require("./remote-main").register(ctx);
require("./update-main").register(ctx);
require("./mendix-main").register(ctx);
piAgent.onAppStart(ctx);
require("./local-main").register(ctx);
claudeSetup = require("./claude-setup-main").register(ctx);
claudeSetup.onReady(() => {
	for (const id of [...setupWaiting]) restartChat(id, openList.find((e) => e.id === id)?.file).catch(() => {}); // both steps are done: the chats that waited start now
});

app.whenReady().then(() => {
	if (!isPrimary) return;
	if (!SELFTEST) {
		if (!globalShortcut.register(HOTKEY, toggleWindow)) console.error(`Hotkey ${HOTKEY} is taken by another app`);
	}
	app.setName("Pi Crust");
	// pi-project:// on its own session only (never persist:devbrowser): the handler, the request guard, no permissions, no downloads, no popups.
	projectProtocol.register({ session: electronSession, app, getRoot: () => (SELFTEST && projectRootOverride) || REPO, selftest: SELFTEST, breakMode: process.env.PI_CRUST_SELFTEST_VIEWER_BREAK || "" });
	if (SELFTEST) require("./viewer-tabs-selftest-main").register({ ipcMain, viewerTabs, session: electronSession, setRoot: (r) => (projectRootOverride = r), ctxView: () => ctx.browserView, devUrl: DEV_URL });
	if (SELFTEST) require("./viewer-files-selftest-main").register({ ipcMain, BrowserWindow, session: electronSession, setRoot: (r) => (projectRootOverride = r) });
	buildMenu();
	createWindow();
});

app.on("window-all-closed", () => {
	if (quitting || SELFTEST || IS_WIN) app.quit();
});
app.on("before-quit", () => killAllChats());
process.on("exit", () => require("./exit-backstop").killAllSync(chats.values())); // a crash must not leave a Pi behind

process.on("uncaughtException", (e) => {
	console.error(e);
	if (!SELFTEST) dialog.showErrorBox("Pi Crust error", String(e && e.stack ? e.stack : e));
});
