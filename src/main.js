// Pi Crust main process: window layout, the Pi RPC subprocess, the file tree and the embedded dev browser.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, globalShortcut, nativeTheme, clipboard } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { killTree } = require("./kill-tree");
const { watchTree } = require("./watch-tree");
const { createPrLookup } = require("./pr-lookup");
const { NOISE_DIRS, isNoise, createIgnoreCheck, debounceMax } = require("./watch-filter");
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
const START_HIDDEN = process.env.PI_CRUST_HIDDEN === "1"; // set by the login item: start in the background
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IGNORED = new Set([".git", "node_modules", "dist", ".turbo", ".next", "coverage", ".DS_Store", "__generated__"]);

let win;
let browserView;
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
let lastRealBounds = { x: 0, y: 0, width: 0, height: 0 }; // last non-empty bounds
let browserHidden = new Set(); // reasons: "tab", "modal"
const chats = new Map(); // chatId -> { id, proc }
let chatSeq = 0;

// ---------------------------------------------------------------------------
// Environment: Electron started from the Dock has a minimal PATH, so add nvm's node and Homebrew.
// ---------------------------------------------------------------------------
// The PATH key as the environment spells it ("Path" on Windows); setting another spelling would leave two.
const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
// Windows: nvm-windows keeps each version in %NVM_HOME%\vX.Y.Z (node.exe right in it).
const nvmWinHome = () => process.env.NVM_HOME || (process.env.APPDATA ? path.join(process.env.APPDATA, "nvm") : null);
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
	const pi = findPi();
	if (pi) extra.push(pi.binDir);
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
	const pi = findPi();
	if (pi) extra.push(pi.binDir);
	const env = { ...process.env, PATH: [...extra, process.env.PATH || ""].join(":") };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

// Where Pi is installed, independent of the opened repo: PI_CRUST_PI, nvm's default version, any other nvm
// version (newest first), then Homebrew / ~/.local. Returns the resolved CLI script and the Node next to it, so Pi
// always runs on the Node it was installed with, whatever the repo's .nvmrc says.
let piCache;
function findPi() {
	if (piCache !== undefined) return piCache;
	if (IS_WIN) return (piCache = findPiWin());
	const home = os.homedir();
	const nvmDir = path.join(home, ".nvm", "versions", "node");
	const candidates = [];
	if (process.env.PI_CRUST_PI) candidates.push(process.env.PI_CRUST_PI);
	try {
		const def = fs.readFileSync(path.join(home, ".nvm", "alias", "default"), "utf8").trim().replace(/^v/, "");
		candidates.push(path.join(nvmDir, `v${def}`, "bin", "pi"));
	} catch {}
	try {
		const versions = fs.readdirSync(nvmDir).filter((v) => /^v\d/.test(v));
		const num = (v) => v.slice(1).split(".").map(Number);
		versions.sort((a, b) => {
			const [x, y] = [num(a), num(b)];
			for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
			return 0;
		});
		for (const v of versions) candidates.push(path.join(nvmDir, v, "bin", "pi"));
	} catch {}
	candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi", path.join(home, ".local", "bin", "pi"));
	for (const bin of candidates) {
		if (!fs.existsSync(bin)) continue;
		const binDir = path.dirname(bin);
		const nodeHere = path.join(binDir, "node");
		let script = null;
		try {
			script = fs.realpathSync(bin);
		} catch {}
		// A JS entry point next to a Node binary: run it with that Node. Otherwise run the binary as is.
		if (script && fs.existsSync(nodeHere) && /\.(c|m)?js$/.test(script)) {
			piCache = { binDir, command: nodeHere, args: [script] };
		} else {
			piCache = { binDir, command: bin, args: [] };
		}
		return piCache;
	}
	piCache = null;
	return piCache;
}

// Windows: PI_CRUST_PI (cli.js, pi.cmd or pi.exe), npm's global folder (%APPDATA%\npm), nvm-windows (the active
// %NVM_SYMLINK%, then %NVM_HOME%\vX newest first), then PATH. Never through the pi.cmd shim (a .cmd only runs in a
// shell, which breaks stdio and arguments): its CLI script runs with the node.exe next to it, else the one on PATH.
const PI_PACKAGES = [path.join("@earendil-works", "pi-coding-agent"), path.join("@mariozechner", "pi-coding-agent")];
function onPath(name, env = process.env) {
	for (const dir of String(env[pathKey(env)] || "").split(path.delimiter)) {
		if (!dir) continue;
		const p = path.join(dir.replace(/^"|"$/g, ""), name);
		if (fs.existsSync(p)) return p;
	}
	return null;
}
// pi.cmd (npm's cmd-shim) -> the script it runs: "%dp0%\node_modules\...\cli.js".
function scriptOfShim(cmd) {
	try {
		const m = /"%dp0%\\([^"]+?\.[cm]?js)"/i.exec(fs.readFileSync(cmd, "utf8"));
		return m ? path.join(path.dirname(cmd), m[1]) : null;
	} catch {
		return null;
	}
}
// <prefix>\node_modules\<pkg>\package.json "bin" -> the CLI script.
function scriptOfPrefix(prefix) {
	for (const pkg of PI_PACKAGES) {
		const dir = path.join(prefix, "node_modules", pkg);
		try {
			const bin = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).bin;
			const rel = typeof bin === "string" ? bin : bin && bin.pi;
			if (rel && fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
		} catch {}
	}
	return null;
}
function findPiWin() {
	const nodeFor = (binDir) => (fs.existsSync(path.join(binDir, "node.exe")) ? path.join(binDir, "node.exe") : onPath("node.exe"));
	const viaScript = (binDir, script) => {
		const node = script && nodeFor(binDir);
		return node ? { binDir, command: node, args: [script] } : null;
	};
	const given = process.env.PI_CRUST_PI;
	if (given && fs.existsSync(given)) {
		if (/\.exe$/i.test(given)) return { binDir: path.dirname(given), command: given, args: [] };
		const script = /\.(cmd|bat)$/i.test(given) ? scriptOfShim(given) : given;
		const r = viaScript(path.dirname(given), script);
		if (r) return r;
	}
	const prefixes = [];
	if (process.env.APPDATA) prefixes.push(path.join(process.env.APPDATA, "npm"));
	if (process.env.NVM_SYMLINK) prefixes.push(process.env.NVM_SYMLINK);
	try {
		const home = nvmWinHome();
		const versions = fs.readdirSync(home).filter((v) => /^v\d/.test(v));
		const num = (v) => v.slice(1).split(".").map(Number);
		versions.sort((a, b) => {
			const [x, y] = [num(a), num(b)];
			for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
			return 0;
		});
		for (const v of versions) prefixes.push(path.join(home, v));
	} catch {}
	for (const prefix of prefixes) {
		const r = viaScript(prefix, scriptOfPrefix(prefix));
		if (r) return r;
	}
	const shim = onPath("pi.cmd");
	if (shim) {
		const r = viaScript(path.dirname(shim), scriptOfShim(shim) || scriptOfPrefix(path.dirname(shim)));
		if (r) return r;
	}
	const exe = onPath("pi.exe");
	return exe ? { binDir: path.dirname(exe), command: exe, args: [] } : null;
}


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
// Pi answers nothing until asked, and runs extension session_start hooks before reading stdin, so readiness is the
// correlated reply to a repeated cheap probe (get_state), not the first byte of output.
const PROBE_ID = "__ready_probe__";
const PROBE_INTERVAL_MS = 750;
const READY_TIMEOUT_MS = 120_000;

function killPi(proc) {
	if (!proc || proc.exitCode !== null) return;
	try {
		proc.stdin.end(); // orderly shutdown request
	} catch {}
	const group = () => {
		try {
			killTree(proc); // the whole group: subagents and running commands too
		} catch {}
	};
	setTimeout(() => proc.exitCode === null && group(), 1500);
	setTimeout(() => {
		if (proc.exitCode === null) {
			try {
				killTree(proc, true);
			} catch {}
		}
	}, 4500);
}

// One Pi RPC process per chat, keyed by chatId. Every event sent to the UI carries the chatId.
// `wt` (from resolveWt) is null for the repo itself, { cwd, branch } for a chat in its own worktree (see worktree-main.js), or
// { cwd, missing: true }: the worktree is gone. Then nothing is spawned (never a silent fallback to the main checkout).
function startPi(chatId, sessionFile, hint = {}, wt = null) {
	if (wt && wt.missing) {
		if (!openList.some((e) => e.id === chatId)) {
			openList.push({ id: chatId, file: sessionFile || null, cwd: wt.cwd });
			saveOpenChats();
		}
		const error = `Worktree ${wt.cwd} no longer exists`;
		send("pi:started", { chatId, cwd: REPO, worktree: null, missingWorktree: wt.cwd, sessionFile: sessionFile || null, ...hint });
		send("pi:exit", { chatId, error, missingWorktree: wt.cwd });
		return null;
	}
	const cwd = wt ? wt.cwd : null;
	// crust-context.ts reports the context breakdown and models used (see context-panel.js).
	// crust-guard.ts asks to continue after every N tool calls (settings.json toolCallCheckIn, default 40, 0 = off).
	// advisor.ts adds Anthropic's advisor tool (pairs in ~/.pi/agent/advisor.json, /advisor command).
	const args = ["--mode", "rpc", ...["crust-context.ts", "crust-guard.ts", "advisor.ts"].flatMap((f) => ["-e", path.join(__dirname, "pi-extension", f)])];
	if (sessionFile) args.push("--session", sessionFile);
	const pi = findPi();
	const [cmd, cmdArgs] = pi ? [pi.command, [...pi.args, ...args]] : ["pi", args];
	// Windows: no process groups, and detached would open a console window.
	const proc = spawn(cmd, cmdArgs, { cwd: cwd || REPO, env: { ...ENV, PI_CRUST_TOOL_CHECKIN: String(toolCheckIn()) }, stdio: ["pipe", "pipe", "pipe"], detached: !IS_WIN, windowsHide: true });
	const chat = { id: chatId, proc, cwd };
	chats.set(chatId, chat);
	if (!openList.some((e) => e.id === chatId)) {
		openList.push({ id: chatId, file: sessionFile || null, cwd });
		saveOpenChats();
	} else if (sessionFile) setChatFile(chatId, sessionFile);
	if (cwd) watchWorktree(cwd);
	answeredUi.delete(chatId); // a new process means new request ids
	const current = () => chats.get(chatId)?.proc === proc; // false once replaced, closed or the repo changed
	let ready = false;
	const started = Date.now();
	const probe = setInterval(() => {
		if (ready || !current()) return clearInterval(probe);
		if (Date.now() - started > READY_TIMEOUT_MS) {
			clearInterval(probe);
			failMainRequests(proc, "Pi stopped");
			send("pi:exit", { chatId, error: `Pi did not answer within ${READY_TIMEOUT_MS / 1000}s` });
			chats.delete(chatId);
			killPi(proc);
			return;
		}
		if (proc.stdin.writable) proc.stdin.write(JSON.stringify({ id: PROBE_ID, type: "get_state" }) + "\n");
	}, PROBE_INTERVAL_MS);
	let buf = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		if (!current()) return; // a replaced process
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			let line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line);
				if (record.id === PROBE_ID) {
					if (!ready) {
						ready = true;
						clearInterval(probe);
						setChatFile(chatId, record.data?.sessionFile);
						send("pi:ready", { chatId, ...(record.data || {}) });
					}
					continue;
				}
				if (record.type === "agent_end") prLookup.invalidatePrefix(); // the agent may have pushed or opened a PR
				if (record.type === "response" && settleMainRequest(record)) continue; // answers to requests main itself sent
				send("pi:record", { chatId, record });
			} catch (e) {
				send("pi:stderr", { chatId, data: `Unparseable record: ${line.slice(0, 200)}` });
			}
		}
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d) => {
		if (!current()) return; // a replaced process
		send("pi:stderr", { chatId, data: d });
	});
	proc.on("error", (e) => {
		clearInterval(probe);
		failMainRequests(proc, "Pi stopped"); // before current(): killed processes are not current any more
		if (current()) send("pi:exit", { chatId, error: e.message });
	});
	proc.on("exit", (code, signal) => {
		clearInterval(probe);
		failMainRequests(proc, "Pi stopped");
		if (!current()) return; // a replaced process
		send("pi:exit", { chatId, code, signal });
		chats.delete(chatId); // the UI keeps the tab and offers a restart
	});
	send("pi:started", { chatId, cwd: cwd || REPO, worktree: cwd ? { cwd, branch: wt.branch || null } : null, sessionFile: sessionFile || null, ...hint });
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
	const files = [...new Set(openList.map((e) => e.file).filter(Boolean))];
	const cwds = {};
	for (const e of openList) if (e.file && e.cwd) cwds[e.file] = e.cwd; // chats in a worktree reopen there
	all[REPO] = { files, active: openList.find((e) => e.id === activeChatId)?.file || null, cwds };
	try {
		fs.mkdirSync(path.dirname(OPEN_CHATS_FILE()), { recursive: true });
		fs.writeFileSync(OPEN_CHATS_FILE(), JSON.stringify(all, null, 2));
	} catch {}
}
function setChatFile(chatId, file) {
	const e = openList.find((x) => x.id === chatId);
	if (!e || typeof file !== "string" || !file || e.file === file) return;
	e.file = file;
	saveOpenChats();
}

function newChatId() {
	return `chat-${++chatSeq}`;
}

function killAllChats() {
	const old = [...chats.values()];
	chats.clear();
	for (const c of old) {
		held.clear(c.id);
		killPi(c.proc);
	}
}

function piSend(chatId, record) {
	const proc = chats.get(chatId)?.proc;
	if (!proc || !proc.stdin.writable) return false;
	proc.stdin.write(JSON.stringify(record) + "\n");
	return true;
}

// Requests main itself sends to Pi (Remote): their responses never go to the renderer.
const MAIN_ID = "crust-main-";
const mainPending = new Map(); // id -> { id, proc, settle }
let mainSeq = 0;
// Resolves { success, data | error }, never rejects. id and type can't be overridden by `extra`.
// atSettle() runs synchronously when the answer is read from Pi's stdout, before any later line is handled; its value
// comes back as `mark`: the exact cut between what the answer covers and the events that follow it.
function piRequest(chatId, type, extra = {}, timeoutMs = 60_000, atSettle = null) {
	return new Promise((resolve) => {
		const proc = chats.get(chatId)?.proc;
		if (!proc || !proc.stdin.writable) return resolve({ success: false, error: "Pi is not running" });
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
		timer = setTimeout(() => settle({ success: false, error: "Pi did not answer in time" }), timeoutMs);
		mainPending.set(id, { id, proc, settle });
		proc.stdin.write(JSON.stringify({ ...extra, id, type }) + "\n");
	});
}
// True when the response is the answer to one of ours (and has been delivered).
function settleMainRequest(record) {
	const p = typeof record.id === "string" ? mainPending.get(record.id) : null;
	if (!p) return false;
	p.settle(record.success === false ? { success: false, error: record.error || "Pi refused the request" } : { success: true, data: record.data });
	return true;
}
function failMainRequests(proc, error) {
	for (const p of [...mainPending.values()]) if (p.proc === proc) p.settle({ success: false, error });
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
	if (!piSend(chatId, response)) return false;
	done.add(response.id);
	if (done.size > 200) done.delete(done.values().next().value);
	send("pi:uiResolved", { chatId, id: response.id, by });
	return true;
}

const sessionArg = (f) => (typeof f === "string" && f ? f : undefined);

ipcMain.handle("pi:send", (_e, chatId, record) => (record?.type === "extension_ui_response" ? answerUi(chatId, record, "desktop") : piSend(chatId, record)));
// Returns the new chat's id, or null. Also used by Remote.
async function newChat(sessionFile, opts) {
	if (!REPO) return null;
	let wt = null;
	if (opts && opts.cwd) {
		wt = typeof opts.cwd === "string" ? await resolveWt(opts.cwd) : null;
		if (!wt || wt.missing) return null; // not a worktree of this repo: don't fall back to the main checkout silently
	}
	const id = newChatId();
	startPi(id, sessionArg(sessionFile), {}, wt);
	return id;
}
ipcMain.handle("pi:newChat", (_e, f, o) => newChat(f, o));
// "Open in main checkout" for a chat whose worktree is gone: the user's explicit choice.
ipcMain.handle("pi:openInMain", (_e, chatId) => {
	const entry = openList.find((e) => e.id === chatId);
	if (!entry || chats.has(chatId)) return false;
	entry.cwd = null;
	saveOpenChats();
	startPi(chatId, entry.file || undefined, {}, null);
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
	const c = chats.get(chatId);
	chats.delete(chatId);
	killPi(c?.proc);
	// A worktree chat's folder may be removed next: wait for its Pi to be gone, then kill what is left of its tree
	// (POSIX: SIGKILL to the process group; Windows: taskkill /T /F, only while Pi itself still runs, see kill-tree.js).
	if (entry?.cwd && c?.proc) {
		const exited = () => c.proc.exitCode !== null || c.proc.signalCode !== null;
		if (!exited()) await new Promise((r) => (c.proc.once("exit", r), setTimeout(r, 6000)));
		try {
			killTree(c.proc, true); // stragglers (subagents, commands) too; ESRCH when nothing is left
		} catch {}
		if (!exited()) await new Promise((r) => (c.proc.once("exit", r), setTimeout(r, 2000)));
	}
	if (entry?.cwd) unwatchWorktreeIfUnused(entry.cwd);
	return true;
});
async function restartChat(chatId, sessionFile) {
	const old = chats.get(chatId)?.proc;
	const cwd = openList.find((e) => e.id === chatId)?.cwd || null;
	chats.delete(chatId);
	killPi(old);
	const file = sessionArg(sessionFile);
	// Resuming a session file: let the old process release it first.
	if (file) await new Promise((r) => (!old || old.exitCode !== null ? r() : (old.once("exit", r), setTimeout(r, 5000))));
	const wt = await resolveWt(cwd);
	// Closed while we waited: don't bring a Pi back for a chat that is gone.
	if (!openList.some((e) => e.id === chatId)) return false;
	startPi(chatId, file, {}, wt);
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
		execFile("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 20e6, windowsHide: true }, (err, out) => {
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
			execFile("git", ["branch", "--show-current"], { cwd: root, env: ENV, windowsHide: true }, (_e2, b) => resolve({ branch: (b || "").trim() || null, files, worktree, root }));
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
function toolCheckIn() {
	const n = Number(readSettings().toolCallCheckIn);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 40;
}
let zoomLevel = 0;
function setZoom(level) {
	zoomLevel = Math.max(-3, Math.min(5, level));
	win?.webContents.setZoomLevel(zoomLevel);
	browserView?.webContents.setZoomLevel(zoomLevel);
	applyBrowserBounds();
	writeSettings({ zoomLevel });
}
const zoomFactor = () => (win ? win.webContents.getZoomFactor() : 1);

// The native view keeps its real bounds while hidden (setVisible(false)) instead of collapsing to 0x0, so
// capturePage(..., {stayHidden:true}) still has a real size to render at (before/after screenshots).
function applyBrowserBounds() {
	if (!browserView) return;
	const z = zoomFactor();
	// While hidden, a zero-size slot (its tab is not shown) must not shrink the view: keep the last real size.
	const css = browserHidden.size && !(browserBounds.width > 0 && browserBounds.height > 0) ? lastRealBounds : browserBounds;
	browserView.setBounds({
		x: Math.round(css.x * z),
		y: Math.round(css.y * z),
		width: Math.max(0, Math.round(css.width * z)),
		height: Math.max(0, Math.round(css.height * z)),
	});
	const visible = browserHidden.size === 0;
	// A view that gets hidden while it has keyboard focus would swallow keystrokes meant for the app: hand focus back.
	const hiding = !visible && browserView.getVisible();
	const hadFocus = hiding && browserView.webContents.isFocused();
	browserView.setVisible(visible);
	if (hadFocus) win?.webContents.focus();
}

function createBrowserView() {
	browserView = new WebContentsView({
		webPreferences: { partition: "persist:devbrowser", contextIsolation: true, sandbox: true },
	});
	// Until a page paints (and for pages without their own background) show the app
	// background, not white. The renderer sends the exact colour on theme changes.
	browserView.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1b1b1b" : "#eef0f0");
	win.contentView.addChildView(browserView);
	const wc = browserView.webContents;
	// Dev browser: no permission is granted by default; only clipboard writes and fullscreen for local pages.
	const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
	const devSession = wc.session;
	devSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed.has(permission) && isLocal(details?.requestingUrl || _wc.getURL())));
	devSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && isLocal(origin));
	const report = () =>
		send("browser:state", { url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), loading: wc.isLoading() });
	wc.on("did-start-loading", report);
	wc.on("did-stop-loading", report);
	wc.on("did-navigate", () => {
		wc.setZoomLevel(zoomLevel); // Chromium keeps zoom per site; keep the app-wide level
		report();
	});
	wc.on("did-navigate-in-page", report);
	wc.on("page-title-updated", report);
	// A failed page shows Chromium's own (white) error page on top of the UI. Hide the view
	// instead so the themed message in #browser-error shows; show it again on the next load.
	wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
		if (!isMain || code === -3) return;
		browserHidden.add("error");
		applyBrowserBounds();
		send("browser:error", { code, desc, url });
	});
	wc.on("did-start-navigation", (details) => {
		if (!details.isMainFrame || details.isSameDocument || !browserHidden.delete("error")) return;
		applyBrowserBounds();
	});
	// App shortcuts keep working while the embedded page has focus.
	wc.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown") return;
		const k = input.key.toLowerCase();
		// The CmdOrCtrl modifier: ⌘ on macOS, Ctrl on Windows (sent on as ctrl: true, which the UI replays).
		const mod = IS_WIN ? input.control && !input.meta : input.meta && !input.control;
		const appKey =
			(mod && (["k", "1", "2", "3", "4", "5", "j", "n", "o", "[", "]", "{", "}", "c"].includes(k) ? !input.alt : k === "b" || (k === "f" && input.shift && !input.alt))) ||
			(input.control && !input.meta && (input.code === "Backquote" || input.code === "Tab")) ||
			(["1", "2", "3"].includes(k) && input.control && (IS_WIN ? input.alt && !input.meta : input.meta && !input.alt)); // view switch
		if (appKey) {
			event.preventDefault();
			send("app:shortcut", { key: input.key, code: input.code, meta: input.meta, alt: input.alt, ctrl: input.control, shift: input.shift });
		}
	});
	// Popups (e.g. a login window) open as real windows sharing the same session.
	wc.setWindowOpenHandler(({ url }) =>
		/^https?:/i.test(url) ? { action: "allow", overrideBrowserWindowOptions: { width: 900, height: 750, parent: win } } : { action: "deny" },
	);
	require("./browser-tools-main").attach?.(wc);
	wc.loadURL(DEV_URL).catch(() => {});
}

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
		browserView?.setBackgroundColor(bg);
		win?.setBackgroundColor(bg);
	}
});
ipcMain.handle("browser:navigate", (_e, url) => {
	let u = String(url || "").trim();
	if (!u || !browserView) return;
	if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
	if (!/^https?:\/\//i.test(u)) return; // no file:// or other schemes in the dev browser
	browserView.webContents.loadURL(u).catch(() => {});
});
ipcMain.handle("browser:action", (_e, action) => {
	if (!browserView) return;
	const wc = browserView.webContents;
	if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
	if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
	if (action === "reload") wc.reload();
	if (action === "devtools") wc.toggleDevTools();
	if (action === "external") {
		const url = wc.getURL();
		if (/^https?:\/\//i.test(url)) shell.openExternal(url);
	}
});

ipcMain.handle("browser:pick", async (_e, opts) => {
	if (!browserView) return { cancelled: true };
	try {
		const r = await require("./picker").togglePick(browserView, REPO, opts || {});
		require("./browser-tools-main").notePick?.(r)?.catch(() => {}); // last picked element = target for forced states
		return r;
	} catch (e) {
		return { error: String((e && e.message) || e) };
	}
});

// Figma desktop picker: current selection via the Figma desktop MCP server.
const figmaFile = () => {
	const s = readSettings();
	return {
		key: s.figmaFileKey || process.env.PI_CRUST_FIGMA_FILE_KEY || null,
		name: s.figmaFileName || (process.env.PI_CRUST_FIGMA_FILE_KEY && !s.figmaFileKey ? process.env.PI_CRUST_FIGMA_FILE_NAME || "file" : ""),
	};
};
function figmaError(e) {
	const msg = String((e && e.message) || e);
	const code = e && ((e.cause && e.cause.code) || e.code);
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || /fetch failed|timed out|ECONNREFUSED/i.test(msg))
		return "Figma desktop isn't reachable. Open Figma desktop and enable the desktop MCP server: Dev Mode → Inspect.";
	if (/only available if your active tab/i.test(msg)) return "The active Figma tab is not a design file. Switch to a design (or FigJam) file in Figma desktop.";
	if (/nothing is selected/i.test(msg)) return "Nothing is selected in Figma. Select a layer in Figma desktop first.";
	return msg;
}
ipcMain.handle("figma:pickSelection", async () => {
	try {
		if (!figmaFile().key) return { error: "No Figma file set. Paste a Figma link into the prompt once to set the file." };
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
ipcMain.handle("figma:setFileFromText", (_e, text) => {
	const f = require("./figma-selection").parseFigmaUrl(String(text || ""));
	if (!f) return null;
	writeSettings({ figmaFileKey: f.key, figmaFileName: f.name });
	return { key: f.key, name: f.name };
});
ipcMain.handle("figma:file", () => figmaFile());

// The embedded browser is a separate WebContentsView; once it held focus, clicking the UI focuses the
// DOM element but not the UI's webContents, so Chromium draws no caret. Hand focus back explicitly.
ipcMain.on("ui:focus", () => {
	if (win && !win.isDestroyed() && !win.webContents.isFocused()) win.webContents.focus();
});
// PI_CRUST_SELFTEST_ONLY=timeline,annotate: run only those tour steps (by feature script name; "core" = the built-in tour).
const SELFTEST_ONLY = SELFTEST ? (process.env.PI_CRUST_SELFTEST_ONLY || "").split(",").map((s) => s.trim().toLowerCase().replace(/\.js$/, "")).filter(Boolean) : [];
ipcMain.handle("app:info", () => ({ repo: REPO, devUrl: DEV_URL, selftest: SELFTEST, selftestOnly: SELFTEST_ONLY, selftestNoPrompt: SELFTEST && process.env.PI_CRUST_SELFTEST_NOPROMPT === "1" }));

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
	const files = [...new Set(saved.files || [])].filter((f) => typeof f === "string" && fs.existsSync(f));
	openList = files.map((file) => ({ id: newChatId(), file, cwd: typeof saved.cwds?.[file] === "string" ? saved.cwds[file] : null }));
	activeChatId = (openList.find((e) => e.file === saved.active) || openList[0])?.id || null;
	const list = [...openList];
	if (!openList.length) startPi(newChatId());
	// A worktree chat is checked (async, cached) before its Pi starts; a vanished worktree is reported, not replaced by the repo.
	const mine = REPO;
	const active = activeChatId;
	(async () => {
		for (const e of list) {
			const wt = await resolveWt(e.cwd);
			if (REPO !== mine || !openList.includes(e)) return;
			startPi(e.id, e.file, { restore: true, active: e.id === active }, wt);
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

ipcMain.handle("git:diff", async (_e, chatId, rel, status) => {
	const root = await rootFor(chatId);
	insideRepo(rel, root);
	rel = gitRel(rel);
	if (status === "??") {
		// Untracked: compare against nothing (exit code 1 means "differences", not an error).
		const r = await run("git", ["diff", "--no-color", "--no-index", "--", "/dev/null", rel], { cwd: root });
		return r.stdout || r.stderr;
	}
	const r = await run("git", ["diff", "--no-color", "HEAD", "--", rel], { cwd: root });
	return r.ok ? r.stdout : r.stderr;
});

// The file's text at HEAD (the left side of the editable diff). Untracked or newly added files have none.
ipcMain.handle("git:original", async (_e, chatId, rel, status) => {
	const root = await rootFor(chatId);
	insideRepo(rel, root);
	rel = gitRel(rel);
	if (status === "??" || (status && status[0] === "A")) return { content: "" };
	const r = await run("git", ["show", `HEAD:./${rel}`], { cwd: root });
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
		run("git", ["branch", "--show-current"], { cwd: root }),
		run("git", ["rev-list", "--count", "@{upstream}..HEAD"], { cwd: root }),
		run("git", ["remote", "get-url", "origin"], { cwd: root }),
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
	const r = await run("git", args, { cwd: REPO });
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
	const [head, refs] = await Promise.all([run("git", ["rev-parse", "HEAD"], { cwd: REPO }), run("git", ["for-each-ref", "--format=%(objectname)%(refname)"], { cwd: REPO })]);
	const own = refs.stdout.split("\n").filter((l) => !l.includes("refs/pi-crust/")).join("\n"); // not the checkpoints
	return head.stdout.trim() + own.length + own.slice(0, 4000);
});

ipcMain.handle("git:show", async (_e, hash) => {
	if (!REPO || !/^[0-9a-f]{7,40}$/.test(String(hash))) return "";
	const r = await run("git", ["show", "--no-color", "--stat", "--patch", "--format=fuller", hash], { cwd: REPO });
	return r.ok ? r.stdout : r.stderr;
});

// Every tracked and untracked (not ignored) file, for the command palette.
ipcMain.handle("fs:index", async () => {
	if (!REPO) return [];
	const r = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO });
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
const sessionsDirFor = (cwd) => path.join(os.homedir(), ".pi", "agent", "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`); // as Pi names it (also C:\ paths)
const sessionsDir = () => sessionsDirFor(REPO);

async function sessionSummary(file) {
	// Read until the first user message; system messages can be huge, so stream and stop early.
	const info = { path: file, name: null, firstPrompt: null, messages: 0 };
	await new Promise((resolve) => {
		const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 256 * 1024 });
		let buf = "";
		let read = 0;
		stream.on("data", (chunk) => {
			read += chunk.length;
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.startsWith('{"type":"session_info"')) {
					try {
						info.name = JSON.parse(line).name || info.name;
					} catch {}
				} else if (line.startsWith('{"type":"message"') && line.includes('"role":"user"') && !info.firstPrompt) {
					try {
						const c = JSON.parse(line).message.content;
						info.firstPrompt = (typeof c === "string" ? c : (c || []).filter((x) => x.type === "text").map((x) => x.text).join(" ")).slice(0, 200);
					} catch {}
				}
			}
			if (info.firstPrompt || read > 4e6) stream.destroy();
		});
		stream.on("close", resolve);
		stream.on("error", resolve);
	});
	return info;
}

ipcMain.handle("sessions:list", async () => {
	if (!REPO) return [];
	// The repo's own sessions, plus those of its existing worktrees (chats started with "New chat in worktree").
	const sources = [{ dir: sessionsDir(), cwd: null }];
	try {
		for (const wt of await require("./worktree-main").listWorktrees(REPO, ENV)) if (realOf(wt.path) !== REPO_REAL && fs.existsSync(wt.path)) sources.push({ dir: sessionsDirFor(wt.path), cwd: wt.path, branch: wt.branch });
	} catch {}
	const withTime = [];
	for (const src of sources) {
		let files;
		try {
			files = (await fs.promises.readdir(src.dir)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const p = path.join(src.dir, f);
			try {
				const st = await fs.promises.stat(p);
				withTime.push({ p, mtime: st.mtimeMs, size: st.size, cwd: src.cwd, branch: src.branch || null });
			} catch {}
		}
	}
	withTime.sort((a, b) => b.mtime - a.mtime);
	const recent = withTime.slice(0, 60);
	const summaries = await Promise.all(recent.map((s) => sessionSummary(s.p)));
	return summaries.map((s, i) => ({ ...s, mtime: recent[i].mtime, size: recent[i].size, cwd: recent[i].cwd, branch: recent[i].branch })).filter((s) => s.firstPrompt);
});

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
		webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
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
		if (isLocal(url)) browserView?.webContents.loadURL(url).catch(() => {});
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
	createBrowserView();
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

async function capture(name) {
	try {
		if (typeof name !== "string" || !/^[\w-]+$/.test(name)) throw new Error("invalid capture name");
		const file = path.join(SELFTEST_DIR, `${SELFTEST_RUN}-${name}.png`);
		fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
		console.log(`SELFTEST screenshot: ${file}`);
		return file;
	} catch (e) {
		console.error("capture failed", e);
	}
}
if (SELFTEST) {
	ipcMain.handle("selftest:capture", (_e, name) => capture(name));
	ipcMain.handle("selftest:zoom", (_e, level) => setZoom(level));
	ipcMain.handle("selftest:bounds", () => ({ view: browserView.getBounds(), z: zoomFactor(), visible: browserView.getVisible(), hidden: [...browserHidden] }));
}

// A menu without the default ⌘R (it would reload the UI and lose the chat view).
function buildMenu() {
	const template = [
		IS_DARWIN ? { role: "appMenu" } : { role: "fileMenu" }, // fileMenu: Exit / Quit elsewhere
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				{ label: "Reload Page in Viewer Tab", accelerator: "CmdOrCtrl+R", click: () => browserView?.webContents.reload() },
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
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Quick start: one instance, a global hotkey, Dock click brings the window back.
// ---------------------------------------------------------------------------
const HOTKEY = process.env.PI_CRUST_HOTKEY || (IS_WIN ? "Alt+Ctrl+P" : "Alt+Command+P");
let quitting = false;

function showWindow() {
	if (!win) return createWindow();
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}
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
	try {
		if (!fs.existsSync(userData) && fs.existsSync(legacy)) fs.renameSync(legacy, userData);
	} catch {}
	app.setPath("userData", userData);
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
ipcMain.handle("app:isFocused", () => !!win && !win.isDestroyed() && win.isFocused());
ipcMain.handle("app:badge", (_e, n) => {
	const count = Math.max(0, Math.floor(Number(n)) || 0);
	if (IS_DARWIN) app.dock?.setBadge(count ? String(count) : "");
	else if (IS_WIN) win?.setOverlayIcon(count ? badgeIcon(count) : null, count ? `${count} unread` : "");
	else app.setBadgeCount?.(count);
});
ipcMain.handle("app:show", () => showWindow());
ipcMain.handle("app:bounce", () => {
	if (IS_DARWIN && !(win && win.isFocused())) app.dock?.bounce("informational");
	if (IS_WIN && win && !win.isFocused()) win.flashFrame(true); // stops by itself once the window comes to the front
});

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
		return browserView;
	},
	// The dev browser's last load failed (Chromium's error page, hidden behind #browser-error): nothing to screenshot.
	browserFailed: () => browserHidden.has("error"),
	get selftest() {
		return SELFTEST;
	},
	send,
	// Remote (remote-main.js): talk to Pi and own chats from outside the renderer.
	piSend,
	piRequest,
	answerUi,
	stopChat: (chatId) => held.stop(chatId),
	heldTake: (chatId, i, text) => held.take(chatId, i, text),
	newChat,
	restartChat,
	addSendTap: (fn) => (sendTaps.add(fn), () => sendTaps.delete(fn)),
	openChats: () => openList.map((e) => ({ id: e.id, file: e.file || null, cwd: e.cwd || null, running: chats.has(e.id) })),
	get activeChatId() {
		return activeChatId;
	},
	run,
	findPi,
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
		return c ? { cwd: openList.find((e) => e.id === id)?.cwd || null, pid: c.proc.pid } : null;
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
require("./remote-main").register(ctx);
require("./update-main").register(ctx);
require("./mendix-main").register(ctx);
require("./advisor-main").register(ctx);
require("./local-main").register(ctx);

app.whenReady().then(() => {
	if (!isPrimary) return;
	if (!SELFTEST) {
		if (!globalShortcut.register(HOTKEY, toggleWindow)) console.error(`Hotkey ${HOTKEY} is taken by another app`);
	}
	app.setName("Pi Crust");
	buildMenu();
	createWindow();
});

app.on("window-all-closed", () => {
	if (quitting || SELFTEST || IS_WIN) app.quit();
});
app.on("before-quit", () => killAllChats());
process.on("exit", () => {
	for (const { proc } of chats.values()) {
		if (proc.exitCode !== null) continue;
		try {
			killTree(proc, IS_WIN, { sync: true }); // Windows: only /F ends a windowless console process
		} catch {}
	}
});

process.on("uncaughtException", (e) => {
	console.error(e);
	if (!SELFTEST) dialog.showErrorBox("Pi Crust error", String(e && e.stack ? e.stack : e));
});
