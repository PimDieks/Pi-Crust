// The master components of the Figma file in which the figma-console "Desktop Bridge" plugin runs (main process).
// Spawns the figma-console MCP server as a stdio child (configured like pi's: ~/.pi/agent/mcp.json › mcpServers["figma-console"],
// or settings `figmaConsoleMcp` { command, args, env }; env values "!cmd" are replaced by the output of the shell command),
// talks newline-delimited JSON-RPC to it, and keeps it alive until the app quits. The plugin connects to the server by itself
// (it scans ports 9223-9232 with backoff), so the first call waits for it. register(ctx) wires `figmaBridge:components`.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { killTree } = require("./kill-tree");

const CONNECT_WAIT_MS = 20_000;
const CALL_MS = 30_000;
const MCP_JSON = () => path.join(os.homedir(), ".pi", "agent", "mcp.json");

const IS_WIN = process.platform === "win32";
const comspec = () => process.env.ComSpec || "cmd.exe";
// The shell for "!cmd": /bin/sh, on Windows cmd.exe (/s strips the outer quotes, so the command's own quotes survive).
const shellRun = (cmd) =>
	IS_WIN
		? execFileSync(comspec(), ["/d", "/s", "/c", `"${cmd}"`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: true })
		: execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

// "!cmd" env values -> the output of `cmd` (run by /bin/sh or cmd.exe, trailing whitespace trimmed); other values as they are.
function resolveEnv(env, run = shellRun) {
	const out = {};
	for (const [k, v] of Object.entries(env || {})) {
		if (typeof v !== "string") continue;
		if (v.startsWith("!")) {
			try {
				out[k] = String(run(v.slice(1))).replace(/\s+$/, "");
			} catch {
				out[k] = "";
			}
		} else out[k] = v;
	}
	return out;
}

// -> { command, args, env } or { error }
function loadConfig(settings, mcpJsonPath = MCP_JSON()) {
	let cfg = settings && settings.figmaConsoleMcp;
	let from = "settings figmaConsoleMcp";
	if (!cfg || typeof cfg !== "object") {
		from = mcpJsonPath;
		try {
			cfg = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")).mcpServers["figma-console"];
		} catch {
			cfg = null;
		}
	}
	if (!cfg || typeof cfg.command !== "string" || !cfg.command) {
		return { error: `No figma-console MCP server is configured. Add mcpServers["figma-console"] (command, args, env) to ${mcpJsonPath}, or set figmaConsoleMcp in Pi Crust's settings.json.` };
	}
	return { command: cfg.command, args: Array.isArray(cfg.args) ? cfg.args.map(String) : [], env: cfg.env, from };
}

// Windows: a bare command (npx, pnpm) is often a .cmd shim, which only runs through cmd.exe. -> [file, args, extra opts]
function winCommand(cmd, args, env = process.env) {
	let file = cmd;
	if (!path.extname(cmd) && !path.isAbsolute(cmd)) {
		const pathVar = env[Object.keys(env).find((k) => k.toUpperCase() === "PATH")] || "";
		const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
		search: for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
			for (const ext of exts) {
				const p = path.join(dir, cmd + ext.toLowerCase());
				if (fs.existsSync(p)) {
					file = p;
					break search;
				}
			}
		}
	}
	if (!/\.(cmd|bat)$/i.test(file)) return [file, args, {}];
	// A trailing backslash would escape the closing quote (C:\dir\ -> "C:\dir\"): double it.
	const q = (s) => `"${String(s).replace(/"/g, '""').replace(/(\\+)$/, "$1$1")}"`;
	return [comspec(), ["/d", "/s", "/c", `"${[file, ...args].map(q).join(" ")}"`], { windowsVerbatimArguments: true }];
}

// Minimal MCP stdio client.
class Client {
	constructor(cfg) {
		this.nextId = 1;
		this.pending = new Map();
		this.buf = "";
		this.stderr = "";
		this.dead = null;
		const home = os.homedir();
		const cmd = cfg.command.replace(/^~(?=[\\/]|$)/, home);
		const env = { ...process.env, ...resolveEnv(cfg.env) };
		if (IS_WIN) {
			// No process groups on Windows (detached would open a console); killTree walks the tree instead.
			const [file, args, extra] = winCommand(cmd, cfg.args, env);
			this.proc = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...extra });
		} else this.proc = spawn(cmd, cfg.args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		this.proc.stdout.on("data", (d) => this.onData(String(d)));
		this.proc.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-2000)));
		this.proc.stdin.on("error", () => {});
		this.proc.on("error", (e) => this.fail(`Couldn't start the figma-console MCP (${cfg.command}): ${e.message}`));
		this.proc.on("exit", (code) => this.fail(`The figma-console MCP stopped (exit ${code}). ${this.stderr.trim().split("\n").pop() || ""}`.trim()));
	}
	fail(msg) {
		if (this.dead) return;
		this.dead = msg;
		for (const p of this.pending.values()) p.reject(new Error(msg));
		this.pending.clear();
	}
	onData(s) {
		this.buf += s;
		let i;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).trim();
			this.buf = this.buf.slice(i + 1);
			if (!line.startsWith("{")) continue;
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			const p = m && this.pending.get(m.id);
			if (!p) continue;
			this.pending.delete(m.id);
			clearTimeout(p.timer);
			if (m.error) p.reject(new Error(m.error.message || "MCP error"));
			else p.resolve(m.result);
		}
	}
	write(obj) {
		this.proc.stdin.write(JSON.stringify(obj) + "\n");
	}
	request(method, params, ms = CALL_MS) {
		if (this.dead) return Promise.reject(new Error(this.dead));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The figma-console MCP didn't answer ${method} in time`));
			}, ms);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}
	async init() {
		await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-crust", version: "0.1.0" } }, 20_000);
		this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
	}
	// tools/call -> the parsed JSON of the text content ({} when it isn't JSON); throws on isError with its message.
	async tool(name, args = {}, ms = CALL_MS) {
		const r = await this.request("tools/call", { name, arguments: args }, ms);
		const text = ((r && r.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		let json = {};
		try {
			json = JSON.parse(text);
		} catch {}
		if (r && r.isError) throw new Error(json.error || text.slice(0, 300) || `${name} failed`);
		return json;
	}
	// `sync`: wait for taskkill on Windows (quit and process "exit", where an async one may not get to run).
	kill(sync = false) {
		if (this.proc.exitCode !== null || this.proc.killed) return;
		try {
			killTree(this.proc, IS_WIN, { sync }); // Windows: only /F ends a windowless console process
		} catch {
			try {
				this.proc.kill("SIGTERM");
			} catch {}
		}
	}
}

// figma_get_status JSON -> { name, key } of the file the plugin is connected from, or null.
function fileOfStatus(st) {
	if (!st || !st.transport || st.transport.active === "none") return null;
	const name = st.currentFileName;
	if (!name || /^\(unable/.test(name)) return null;
	return { name: String(name), key: String(st.currentFileKey || "") };
}

// figma_search_components result items -> [{ name, setName, nodeId, key, description, type }]
function toComponents(items) {
	return (items || []).filter((r) => r && r.name).map((r) => ({ name: String(r.name), setName: r.type === "componentSet" ? String(r.name) : "", nodeId: String(r.nodeId || ""), key: String(r.key || ""), description: r.description ? String(r.description) : "", type: r.type === "componentSet" ? "componentSet" : "component" }));
}

// Read-only plugin code, run with figma_execute (max 30 s per call, so one page per call).
const PAGES_JS = "return figma.root.children.map((p) => ({ id: p.id, name: p.name }))";
const PAGE_JS = (id) =>
	`const p = await figma.getNodeByIdAsync(${JSON.stringify(id)}); if (!p || p.type !== "PAGE") return []; await p.loadAsync();` +
	`return p.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }).filter((n) => !n.remote && !(n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET"))` +
	`.map((n) => ({ name: n.name, nodeId: n.id, key: n.key, description: n.description || "", type: n.type === "COMPONENT_SET" ? "componentSet" : "component" }));`;
const MAX_PER_PAGE = 300; // more than this on one page = an icon / asset page, not master components
const MASTER_PAGE = /^\s*❖/; // design-system convention: one "❖ Button" page per master component

// Which pages to read: the ❖ pages when the file uses them, otherwise all except separators ("----").
function pagesToRead(pages) {
	const real = (pages || []).filter((p) => p && p.id && !/^[\s\-–—_.*=]*$/.test(p.name || ""));
	const masters = real.filter((p) => MASTER_PAGE.test(p.name));
	return masters.length ? masters : real;
}

// Page results -> components (private ".x" / "_x" ones and icon pages dropped), with the page name.
function collectComponents(perPage) {
	const out = [];
	for (const { page, items } of perPage) {
		if (!Array.isArray(items) || items.length > MAX_PER_PAGE) continue;
		for (const r of items) if (r && r.name && !/^[._]/.test(r.name)) out.push({ ...toComponents([r])[0], page: page.name });
	}
	return out;
}

async function readComponents(c) {
	const exec = async (code) => {
		const r = await c.tool("figma_execute", { code, timeout: 30000 }, 40000);
		if (r && r.success === false) throw new Error(r.error || "figma_execute failed");
		return r ? r.result : null;
	};
	const pages = pagesToRead(await exec(PAGES_JS));
	const perPage = [];
	for (const page of pages) perPage.push({ page, items: await exec(PAGE_JS(page.id)) });
	return collectComponents(perPage);
}

function createBridge({ readSettings, makeClient = (cfg) => new Client(cfg), connectWaitMs = CONNECT_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mcpJson } = {}) {
	let client = null;
	let ready = null;
	const cache = new Map(); // file key (or name) -> components
	let inflight = null;

	async function ensure() {
		if (client && !client.dead && ready) {
			await ready;
			return client;
		}
		client?.kill();
		const cfg = loadConfig(readSettings(), mcpJson);
		if (cfg.error) throw new Error(cfg.error);
		const c = (client = makeClient(cfg));
		ready = c.init();
		try {
			await ready;
		} catch (e) {
			c.kill();
			if (client === c) client = null;
			throw e;
		}
		return c;
	}

	async function waitForFile(c) {
		const t0 = Date.now();
		for (;;) {
			const f = fileOfStatus(await c.tool("figma_get_status"));
			if (f) return f;
			if (Date.now() - t0 >= connectWaitMs) throw new Error("The Figma Desktop Bridge plugin isn't connected to Pi Crust. In Figma, open the file and run the \"Desktop Bridge\" plugin (Plugins › Development); then press refresh. If it was already open and still doesn't connect, your figma-console-mcp is older than 1.46: that plugin only looks for servers when it starts, so update figma-console-mcp (server and plugin) or close and reopen the plugin.");
			await sleep(1500);
		}
	}

	async function run(refresh) {
		const c = await ensure();
		const file = await waitForFile(c);
		const id = file.key || file.name;
		if (!refresh && cache.has(id)) return { ok: true, file, components: cache.get(id), cached: true };
		const components = await readComponents(c);
		cache.set(id, components);
		return { ok: true, file, components };
	}

	return {
		// Start the server early, so the plugin finds it whenever it is (re)opened.
		warm() {
			ensure().catch(() => {});
		},
		components(refresh = false) {
			if (!inflight) {
				inflight = run(!!refresh)
					.catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
					.finally(() => (inflight = null));
			}
			return inflight;
		},
		kill(sync = false) {
			client?.kill(sync);
			client = null;
			ready = null;
		},
	};
}

function register(ctx) {
	const bridge = createBridge({ readSettings: () => ctx.readSettings() });
	ctx.ipcMain.handle("figmaBridge:components", (_e, o) => bridge.components(!!(o && o.refresh)));
	ctx.app.on("before-quit", () => bridge.kill(true));
	// Only when a figma-console server is configured; a few seconds after launch to keep startup light.
	if (!loadConfig(ctx.readSettings()).error) setTimeout(() => bridge.warm(), 3000).unref?.();
	process.on("exit", () => bridge.kill(true));
}

module.exports = { register, Client, pagesToRead, collectComponents, PAGE_JS, createBridge, resolveEnv, loadConfig, fileOfStatus, toComponents, winCommand };
