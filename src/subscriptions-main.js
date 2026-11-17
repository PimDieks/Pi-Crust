// Subscriptions: which provider account Pi uses. Status comes from `pi auth check` (never prints secrets without
// --credentials), Ollama from its local API plus ~/.pi/agent/models.json. Signing in runs Pi's own login code in a small
// helper process (src/pi-login-helper.mjs, JSONL over stdio) so auth.json is written exactly as `/login` does.
//  - subs:login(provider)       -> runs the login; progress goes to the renderer as "subs:login-state", resolves { ok, error?, cancelled? }
//  - subs:login-answer(id, value) / subs:login-cancel
//  - subs:status                -> { rows: [{ id, label, kind, status, detail, ... }], defaultModel }
//  - subs:logout(provider)      -> signs out via Pi's own ModelRuntime.logout (helper `logout` mode)
//  - subs:ollama-sync / subs:ollama-remove -> add/refresh/remove the `ollama` provider in models.json
"use strict";

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// One row per entry; add a provider by adding a line (kind "oauth" signs in with /login, "local" is Ollama-like).
// apiKey: true means an API key counts as connected too (shown as "API key"); oauthDetail replaces "Signed in" for a login.
const SUBSCRIPTIONS = [
	{ id: "anthropic", label: "Claude", kind: "oauth", apiKey: true, oauthDetail: "Pro/Max subscription" },
	{ id: "github-copilot", label: "GitHub Copilot", kind: "oauth" },
	{ id: "openai-codex", label: "ChatGPT Plus/Pro", kind: "oauth" },
	{ id: "ollama", label: "Ollama (local)", kind: "local" },
];

// --- sign-in helper protocol (pure parts) -------------------------------------------------------------------
// Strict JSONL: split on LF only. Returns the parsed objects of the complete lines and the unfinished rest.
function frameJsonl(rest, chunk) {
	const parts = (rest + chunk).split("\n");
	const tail = parts.pop();
	const messages = [];
	for (const line of parts) {
		if (!line.trim()) continue;
		try {
			messages.push(JSON.parse(line));
		} catch {}
	}
	return { messages, rest: tail };
}

// Prompts we can answer ourselves so the user has nothing to type: the sign-in method (browser flow, which is the
// default of Pi's own dialog) and GitHub Enterprise (blank = github.com). Returns a string or null (ask the user).
function autoAnswer(providerId, prompt) {
	if (!prompt) return null;
	if (prompt.type === "select") {
		const opts = prompt.options || [];
		const browser = opts.find((o) => o.id === "browser");
		if (browser) return browser.id;
		return /login method/i.test(prompt.message || "") && opts.length ? opts[0].id : null;
	}
	if (prompt.type === "text" && providerId === "github-copilot" && /enterprise/i.test(prompt.message || "")) return "";
	return null;
}

const isWebUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

// One helper message -> what the UI shows, or null for nothing. Kinds: opening (browser opened, `url` as a fallback link),
// device (code + uri), progress, info, prompt (text | secret | select | manual_code), cancel-prompt.
function uiState(msg) {
	if (!msg || typeof msg !== "object") return null;
	if (msg.type === "prompt" && msg.prompt) {
		const p = msg.prompt;
		return { kind: "prompt", id: msg.id, type: p.type, message: String(p.message || ""), placeholder: p.placeholder || "", options: (p.options || []).map((o) => ({ id: o.id, label: o.label, description: o.description || "" })) };
	}
	if (msg.type === "cancel-prompt") return { kind: "cancel-prompt", id: msg.id };
	if (msg.type !== "event" || !msg.event) return null;
	const e = msg.event;
	if (e.type === "auth_url") return { kind: "opening", url: isWebUrl(e.url) ? e.url : "", instructions: e.instructions || "" };
	if (e.type === "device_code") return { kind: "device", code: String(e.userCode || ""), uri: isWebUrl(e.verificationUri) ? e.verificationUri : "", expiresInSeconds: e.expiresInSeconds || 0 };
	if (e.type === "info") return { kind: "info", message: String(e.message || ""), links: (e.links || []).filter((l) => isWebUrl(l.url)).map((l) => ({ url: l.url, label: l.label || l.url })) };
	if (e.type === "progress") return { kind: "progress", message: String(e.message || "") };
	return null;
}

// Pi's package folder from the resolved CLI script (<root>/dist/bundle/cli.js): the nearest folder up with a package.json.
// Null for a compiled single binary, which has no JS install to import.
function piPackageRoot(script, fsImpl = fs) {
	if (!script) return null;
	let dir = path.dirname(script);
	for (let i = 0; i < 6; i++) {
		try {
			if (JSON.parse(fsImpl.readFileSync(path.join(dir, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
		} catch {}
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

// Pi's own logout through the helper (ModelRuntime.logout: Pi's file lock + format). Resolves { ok, error? }.
function runLogout(command, root, providerId, env) {
	return new Promise((resolve) => {
		let proc;
		try {
			proc = spawn(command, [path.join(__dirname, "pi-login-helper.mjs"), root, providerId, "logout"], { env, cwd: os.homedir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			proc.stdin.on("error", () => {});
		} catch (e) {
			return resolve({ ok: false, error: `Couldn't start the sign-out: ${e.message}` });
		}
		let rest = "";
		let result = null;
		let stderr = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk) => {
			const framed = frameJsonl(rest, chunk);
			rest = framed.rest;
			for (const msg of framed.messages) {
				if (msg.type === "done") result = { ok: true, changed: true };
				else if (msg.type === "error") result = { ok: false, error: String(msg.message || "Sign-out failed") };
			}
		});
		proc.stderr.on("data", (d) => {
			stderr = (stderr + d).slice(-500);
		});
		proc.on("error", (e) => resolve({ ok: false, error: `Couldn't start the sign-out: ${e.message}` }));
		proc.on("close", (code) => resolve(result || { ok: false, error: `Sign-out stopped unexpectedly${code ? ` (exit ${code})` : ""}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}` }));
	});
}

const OLLAMA_URL = "http://localhost:11434";

// Pi's config folder: PI_CODING_AGENT_DIR (a leading ~ is expanded like Pi does) or ~/.pi/agent.
function agentDir(env = process.env, home = os.homedir()) {
	const d = env.PI_CODING_AGENT_DIR;
	if (!d) return path.join(home, ".pi", "agent");
	if (d === "~") return home;
	return d.startsWith("~/") ? path.join(home, d.slice(2)) : d;
}

// `pi auth check --json` output -> a row's status and detail. `row` is the SUBSCRIPTIONS entry.
// Pi reports only "oauth" or "api_key" (a stored key and an environment variable look the same), so the caller says whether
// auth.json holds an entry for the provider (`stored`, see hasStoredCredential): a stored key can be removed, an environment
// variable can't.
function mapAuthCheck(json, row = {}, stored = true) {
	if (json && json.status === "ready") {
		if (json.authType === "oauth") return { status: "connected", detail: row.oauthDetail || "Signed in", authType: "oauth" };
		// Rows that accept a key treat it as connected; elsewhere an API key is something else (and not ours to sign out).
		if (row.apiKey && json.authType === "api_key") {
			if (stored) return { status: "connected", detail: "API key", authType: "api_key" };
			return { status: "connected", detail: "API key (environment variable)", authType: "env" };
		}
		return { status: "disconnected", detail: "API key (not a subscription)", authType: json.authType || "api_key" };
	}
	if (json && json.status === "not_ready") {
		if (json.reason === "credentials_not_configured") return { status: "disconnected", detail: "Not signed in" };
		if (json.reason === "provider_not_found") return { status: "unavailable", detail: "Unknown to this Pi version" };
	}
	return { status: "unavailable", detail: "Couldn't check" };
}

// Does auth.json have an entry for this provider? Presence only: the credential itself is never looked at.
// A missing or unreadable file counts as no entry.
function hasStoredCredential(file, id) {
	try {
		const auth = readJson(file);
		return !!auth && typeof auth === "object" && Object.prototype.hasOwnProperty.call(auth, id) && auth[id] != null;
	} catch {
		return false;
	}
}

// Installed Ollama models (/api/tags) -> models.json model entries. Embedding-only models can't chat, so they are left out.
function ollamaModels(tags) {
	const out = [];
	for (const m of (tags && tags.models) || []) {
		const id = m.name || m.model;
		if (!id) continue;
		const caps = m.capabilities;
		if (Array.isArray(caps) && !caps.includes("completion")) continue;
		const entry = { id };
		if (Array.isArray(caps) && caps.includes("thinking")) entry.reasoning = true;
		entry.input = Array.isArray(caps) && caps.includes("vision") ? ["text", "image"] : ["text"];
		const ctx = m.details && m.details.context_length;
		if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx;
		out.push(entry);
	}
	return out;
}

// Fields Sync writes itself; an entry with anything else (name, cost, compat, ...) was written by hand.
const AUTO_FIELDS = new Set(["id", "reasoning", "input", "contextWindow"]);
const isHandWritten = (m) => !!m && typeof m === "object" && !!m.id && Object.keys(m).some((k) => !AUTO_FIELDS.has(k));

// Merge the installed models into the `ollama` provider of a models.json object. Everything else is preserved: other
// providers, other top-level keys, and a custom baseUrl / apiKey / per-model fields the user set for the same model id.
function mergeOllama(config, tags) {
	const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
	const providers = base.providers && typeof base.providers === "object" ? base.providers : {};
	const prev = providers.ollama && typeof providers.ollama === "object" ? providers.ollama : {};
	const old = new Map((Array.isArray(prev.models) ? prev.models : []).map((m) => [m && m.id, m]));
	const fresh = ollamaModels(tags);
	const ids = new Set(fresh.map((m) => m.id));
	// Models the user wrote by hand (fields Sync doesn't write) stay even when not installed; plain auto-added ones are dropped.
	const kept = [...old.values()].filter((m) => !ids.has(m && m.id) && isHandWritten(m));
	const models = [...fresh.map((m) => ({ ...m, ...(old.get(m.id) || {}) })), ...kept];
	const ollama = { baseUrl: `${OLLAMA_URL}/v1`, api: "openai-completions", apiKey: "ollama", ...prev, models };
	return { ...base, providers: { ...providers, ollama } };
}

// Sync only talks to the local Ollama: a configured baseUrl pointing elsewhere is the user's own setup. Returns an error or null.
function ollamaLocalError(config) {
	const base = config && config.providers && config.providers.ollama && config.providers.ollama.baseUrl;
	if (!base) return null;
	let host = "";
	try {
		host = new URL(base).hostname;
	} catch {}
	if (host === "localhost" || host === "127.0.0.1") return null;
	return `Ollama in models.json points to ${host || base}, not this computer; Sync only works with local Ollama. Edit models.json by hand.`;
}

const NOT_PLAIN_JSON = "models.json isn't plain JSON; edit it by hand";

// The same object without that provider.
function removeProvider(config, id) {
	if (!config || typeof config !== "object" || !config.providers || !(id in config.providers)) return { next: config, removed: false };
	const { [id]: _gone, ...rest } = config.providers;
	return { next: { ...config, providers: rest }, removed: true };
}

// Readers return null for a missing file and throw for a file that isn't valid JSON (we never overwrite that).
function readJson(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
	if (!text.trim()) return null;
	return JSON.parse(text.replace(/^\uFEFF/, ""));
}

// Write via a temp file in the same folder and rename, keeping the old file's permissions (auth.json is 0600).
function writeJsonAtomic(file, value) {
	try {
		file = fs.realpathSync(file); // a symlinked file (dotfiles repo) stays a symlink
	} catch {}
	let mode = 0o600;
	try {
		mode = fs.statSync(file).mode & 0o777;
	} catch {}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

async function fetchOllamaTags(fetchFn = fetch, timeoutMs = 1500) {
	const res = await fetchFn(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
	return res.json();
}

// /api/tags has no capabilities; /api/show has, per model. Adds capabilities and context_length (best effort, per-model
// timeout; a failing call leaves the model as /api/tags gave it). Results are remembered per model version.
const showCache = new Map();
async function enrichOllamaTags(tags, fetchFn = fetch, timeoutMs = 1500) {
	const models = await Promise.all(
		((tags && tags.models) || []).map(async (m) => {
			const name = m.name || m.model;
			if (!name) return m;
			const key = `${name}@${m.digest || m.modified_at || ""}`;
			let info = showCache.get(key);
			if (!info) {
				try {
					const res = await fetchFn(`${OLLAMA_URL}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(timeoutMs) });
					if (!res.ok) return m;
					const j = await res.json();
					const mi = j.model_info || {};
					const arch = mi["general.architecture"];
					info = { capabilities: Array.isArray(j.capabilities) ? j.capabilities : undefined, contextLength: arch ? mi[`${arch}.context_length`] : undefined };
					showCache.set(key, info);
				} catch {
					return m;
				}
			}
			return { ...m, capabilities: info.capabilities || m.capabilities, details: { ...m.details, ...(Number.isFinite(info.contextLength) ? { context_length: info.contextLength } : {}) } };
		}),
	);
	return { ...tags, models };
}

// What the models.json says about Ollama, compared with what is installed.
function describeOllama({ reachable, installed, configured, handWritten = [] }) {
	const n = installed.length;
	const plural = (k) => `${k} local model${k === 1 ? "" : "s"}`;
	if (!reachable) return { status: "unavailable", detail: "Ollama not running" };
	if (!configured.length) return { status: "disconnected", detail: n ? `${plural(n)}, not added to Pi` : "Running, no models installed" };
	const missing = installed.filter((id) => !configured.includes(id));
	const stale = configured.filter((id) => !installed.includes(id) && !handWritten.includes(id)); // hand-written entries stay on purpose
	if (missing.length || stale.length) return { status: "connected", detail: `${plural(configured.length)}, out of sync`, outOfSync: true };
	return { status: "connected", detail: plural(configured.length) };
}

function register(ctx) {
	const { ipcMain } = ctx;
	const { shell, clipboard } = require("electron");
	const dir = () => agentDir(ctx.env);
	const modelsFile = () => path.join(dir(), "models.json");

	const authCheck = (row) =>
		new Promise((resolve) => {
			const pi = ctx.findPi();
			const [cmd, args] = pi ? [pi.command, [...pi.args]] : ["pi", []];
			execFile(cmd, [...args, "auth", "check", "--provider", row.id, "--json", "--no-refresh"], { env: ctx.env, cwd: os.homedir(), timeout: 15_000, maxBuffer: 1e6, windowsHide: true }, (_err, stdout) => {
				// Exit code 1 means "not ready" and still prints the JSON.
				try {
					const json = JSON.parse(String(stdout || "").trim());
					// Only a key needs the extra look: a stored one can be removed, one from the environment can't.
					const stored = json && json.authType === "api_key" && row.apiKey ? hasStoredCredential(path.join(dir(), "auth.json"), row.id) : true;
					resolve(mapAuthCheck(json, row, stored));
				} catch {
					resolve(mapAuthCheck(null, row));
				}
			});
		});

	async function ollamaRow() {
		let installed = [];
		let reachable = true;
		try {
			installed = ollamaModels(await enrichOllamaTags(await fetchOllamaTags())).map((m) => m.id);
		} catch {
			reachable = false;
		}
		let configured = [];
		let handWritten = [];
		try {
			const p = (readJson(modelsFile()) || {}).providers?.ollama;
			if (p) {
				configured = (p.models || []).map((m) => m && m.id).filter(Boolean);
				handWritten = (p.models || []).filter(isHandWritten).map((m) => m.id);
			}
		} catch {
			return { status: "unavailable", detail: NOT_PLAIN_JSON, reachable, installed: installed.length, configured: 0, badConfig: true };
		}
		return { ...describeOllama({ reachable, installed, configured, handWritten }), reachable, installed: installed.length, configured: configured.length };
	}

	// One status computation at a time, remembered for 10 s; login / logout / sync / remove drop it.
	let statusGen = 0;
	let statusInflight = null;
	let statusCache = null; // { at, value }
	const invalidateStatus = () => {
		statusGen++;
		statusInflight = null;
		statusCache = null;
	};
	function status() {
		if (statusCache && Date.now() - statusCache.at < 10_000) return Promise.resolve(statusCache.value);
		if (statusInflight) return statusInflight;
		const gen = statusGen;
		const p = computeStatus()
			.then((value) => {
				if (gen === statusGen) statusCache = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				if (statusInflight === p) statusInflight = null;
			});
		statusInflight = p;
		return p;
	}
	ipcMain.handle("subs:status", () => status());
	async function computeStatus() {
		const rows = await Promise.all(
			SUBSCRIPTIONS.map(async (s) => ({ ...s, ...(s.kind === "local" ? await ollamaRow() : await authCheck(s)) })),
		);
		let defaultModel = null;
		try {
			const st = readJson(path.join(dir(), "settings.json")) || {};
			if (st.defaultProvider || st.defaultModel) defaultModel = { provider: st.defaultProvider || null, id: st.defaultModel || null };
		} catch {}
		return { rows, defaultModel };
	}

	// --- sign-in: one helper process at a time ---------------------------------------------------------
	let login = null; // { provider, proc, done, cancelled }
	const sendState = (provider, state) => ctx.send("subs:login-state", { provider, state });
	const stopLogin = () => {
		const l = login;
		if (!l || l.cancelled) return;
		l.cancelled = true;
		try {
			l.proc.stdin.write(`${JSON.stringify({ type: "cancel" })}\n`);
		} catch {}
		setTimeout(() => l.proc.kill(), 1500).unref?.();
	};
	const killLogin = () => login?.proc.kill();

	ipcMain.handle("subs:login", (_e, provider) => {
		const sub = SUBSCRIPTIONS.find((s) => s.id === provider && s.kind === "oauth");
		if (!sub) return { ok: false, error: "Unknown subscription" };
		if (login) return { ok: false, error: "Another sign-in is in progress" };
		const pi = ctx.findPi();
		const script = pi && pi.args[0];
		const root = piPackageRoot(script);
		if (!root) return { ok: false, error: "Couldn't find Pi's install folder to sign in with (set PI_CRUST_PI to the pi script)" };
		return new Promise((resolve) => {
			const proc = spawn(pi.command, [path.join(__dirname, "pi-login-helper.mjs"), root, sub.id], { env: ctx.env, cwd: os.homedir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			proc.stdin.on("error", () => {});
			const l = (login = { provider: sub.id, proc, cancelled: false });
			let rest = "";
			let result = null; // { ok, error }
			let stderr = "";
			const answer = (id, value) => proc.stdin.writable && proc.stdin.write(`${JSON.stringify({ type: "answer", id, value })}\n`);
			l.answer = answer;
			proc.stdout.setEncoding("utf8");
			proc.stdout.on("data", (chunk) => {
				const framed = frameJsonl(rest, chunk);
				rest = framed.rest;
				for (const msg of framed.messages) {
					if (msg.type === "done") result = { ok: true, warning: msg.warning ? String(msg.warning) : undefined };
					else if (msg.type === "error") result = { ok: false, error: String(msg.message || "Sign-in failed") };
					else if (msg.type === "prompt") {
						const auto = autoAnswer(sub.id, msg.prompt);
						if (auto !== null) {
							answer(msg.id, auto);
							continue;
						}
					} else if (msg.type === "event" && msg.event) {
						const e = msg.event;
						if (e.type === "auth_url" && isWebUrl(e.url)) shell.openExternal(e.url).catch(() => {});
						if (e.type === "device_code") {
							if (e.userCode) clipboard.writeText(String(e.userCode));
							if (isWebUrl(e.verificationUri)) shell.openExternal(e.verificationUri).catch(() => {});
						}
					}
					const state = uiState(msg);
					if (state) {
						// Closing the window only hides it: bring it back when the user has to act.
						if (state.kind === "prompt" || state.kind === "device") {
							const w = ctx.win;
							if (w && !w.isDestroyed() && (!w.isVisible() || w.isMinimized())) ctx.showWindow?.();
						}
						sendState(sub.id, state);
					}
				}
			});
			proc.stderr.on("data", (d) => {
				stderr = (stderr + d).slice(-500);
			});
			let detach = () => {};
			const finish = (r) => {
				detach();
				if (login === l) login = null;
				invalidateStatus();
				// A finished sign-in counts even when cancel came in at the last moment.
				resolve(r.ok ? { ...r, ok: true } : l.cancelled ? { ok: false, cancelled: true, error: "Sign-in cancelled" } : r);
			};
			proc.on("error", (e) => finish({ ok: false, error: `Couldn't start the sign-in: ${e.message}` }));
			proc.on("close", (code) => finish(result || { ok: false, error: `Sign-in stopped unexpectedly${code ? ` (exit ${code})` : ""}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}` }));
			// The window closing or reloading ends the UI that would answer prompts.
			const win = ctx.win;
			if (win && !win.isDestroyed()) {
				const wc = win.webContents;
				const onNav = (d) => d?.isMainFrame && stopLogin();
				win.once("closed", stopLogin);
				wc.on("did-start-navigation", onNav);
				detach = () => {
					win.removeListener("closed", stopLogin);
					if (!wc.isDestroyed()) wc.removeListener("did-start-navigation", onNav);
				};
			}
		});
	});
	ipcMain.handle("subs:login-answer", (_e, id, value) => {
		if (!login || login.cancelled) return { ok: false };
		login.answer(String(id), String(value ?? ""));
		return { ok: true };
	});
	ipcMain.handle("subs:login-cancel", () => {
		stopLogin();
		return { ok: true };
	});
	ctx.app.on("before-quit", killLogin);

	ipcMain.handle("subs:logout", (_e, provider) => {
		const sub = SUBSCRIPTIONS.find((s) => s.id === provider && s.kind === "oauth");
		if (!sub) return { ok: false, error: "Unknown subscription" };
		const pi = ctx.findPi();
		const root = piPackageRoot(pi && pi.args[0]);
		if (!root) return { ok: false, error: "Couldn't find Pi's install folder to sign out with (set PI_CRUST_PI to the pi script)" };
		return runLogout(pi.command, root, sub.id, ctx.env).finally(invalidateStatus);
	});

	ipcMain.handle("subs:ollama-sync", async () => {
		let config;
		try {
			config = readJson(modelsFile());
		} catch {
			return { ok: false, error: NOT_PLAIN_JSON };
		}
		const remote = ollamaLocalError(config);
		if (remote) return { ok: false, error: remote };
		let tags;
		try {
			tags = await enrichOllamaTags(await fetchOllamaTags());
		} catch {
			return { ok: false, error: "Ollama isn't running on localhost:11434" };
		}
		if (!ollamaModels(tags).length) return { ok: false, error: "No Ollama models installed (ollama pull <model>)" };
		try {
			invalidateStatus();
			const next = mergeOllama(config, tags);
			writeJsonAtomic(modelsFile(), next);
			invalidateStatus();
			return { ok: true, changed: true, models: next.providers.ollama.models.length };
		} catch (e) {
			return { ok: false, error: `Couldn't update models.json: ${e.message}` };
		}
	});

	ipcMain.handle("subs:ollama-remove", () => {
		try {
			let config;
			try {
				config = readJson(modelsFile());
			} catch {
				return { ok: false, error: NOT_PLAIN_JSON };
			}
			const { next, removed } = removeProvider(config, "ollama");
			if (removed) writeJsonAtomic(modelsFile(), next);
			invalidateStatus();
			return { ok: true, changed: removed };
		} catch (e) {
			return { ok: false, error: `Couldn't update models.json: ${e.message}` };
		}
	});
}

module.exports = { register, frameJsonl, autoAnswer, uiState, piPackageRoot, SUBSCRIPTIONS, agentDir, mapAuthCheck, hasStoredCredential, ollamaModels, mergeOllama, removeProvider, ollamaLocalError, enrichOllamaTags, runLogout, describeOllama, readJson, writeJsonAtomic };
