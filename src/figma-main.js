// Main-process side of the Figma setup: connection status, Test connection and the per-project file link.
// IPC: figma:status, figma:test, figma:setFile, figma:file, figma:setFileFromText (old name, kept).
// No timer and no probe at startup: the renderer asks (Design tab opened, panel opened, Test connection, after a failed Figma action).
"use strict";

const fs = require("fs");

// Per-project key: the real path where the folder exists, lower-cased on Windows, so C:\X and c:\x share one link.
function repoKey(repo, platform = process.platform) {
	if (!repo) return repo;
	let k = String(repo);
	try {
		k = fs.realpathSync(k);
	} catch {}
	return platform === "win32" ? k.toLowerCase() : k;
}

// File link for a repo: this project's entry first (normalised key, then the old raw key), then the old app-wide value, then the env var.
// Returns { key, name, scope: "project" | "app" | "env" | null }.
function fileFor(settings, repo, env = process.env) {
	const s = settings || {};
	const p = repo && s.figmaFiles && (s.figmaFiles[repoKey(repo)] || s.figmaFiles[repo]);
	if (p && p.key) return { key: p.key, name: p.name || "", scope: "project" };
	if (s.figmaFileKey) return { key: s.figmaFileKey, name: s.figmaFileName || "", scope: "app" };
	if (env.PI_CRUST_FIGMA_FILE_KEY) return { key: env.PI_CRUST_FIGMA_FILE_KEY, name: env.PI_CRUST_FIGMA_FILE_NAME || "file", scope: "env" };
	return { key: null, name: "", scope: null };
}

// Same shape the old figmaFile() returned ({ key, name }), for the picker.
const legacyFile = (f) => ({ key: f.key, name: f.name });

function makeApi({ readSettings, writeSettings, getRepo, probe, checkProcess, env = process.env }) {
	const st = require("./figma-status");
	const parseFigmaUrl = (t) => require("./figma-selection").parseFigmaUrl(t);
	let inflight = null; // one probe at a time: callers share the running one
	const file = () => fileFor(readSettings(), getRepo(), env);
	const fileLink = () => {
		const f = file();
		return { set: !!f.key, name: f.name, scope: f.scope };
	};
	function run() {
		if (!inflight) inflight = runOnce().finally(() => (inflight = null));
		return inflight;
	}
	async function runOnce() {
		const raw = await probe();
		// The process check only matters when the port is closed.
		const proc = raw && raw.stage === "connect" ? await checkProcess() : {};
		const c = st.classify(raw, proc);
		return { raw, result: { state: c.state, hint: c.hint, message: c.message, pill: st.pillText(c.state), name: c.name || "", fileLink: fileLink(), checkedAt: Date.now() } };
	}
	const self = {
		file,
		status: async () => (await run()).result,
		// Like status, plus what was checked: [{ label, ok }] (ok null = not reached).
		test: async () => {
			const { raw, result } = await run();
			return { ...result, checks: st.checks(raw) };
		},
		setFile: (link) => {
			const text = String(link || "").trim();
			const f = text.length <= 500 && /^https:\/\/(?:www\.)?figma\.com\//.test(text) ? parseFigmaUrl(text) : null;
			if (!f) return { ok: false, error: "That doesn't look like a Figma link. Paste a link to a Figma file." };
			const repo = getRepo();
			if (repo) {
				const files = { ...(readSettings().figmaFiles || {}) };
				delete files[repo]; // an entry under the old raw key moves to the normalised one
				files[repoKey(repo)] = { key: f.key, name: f.name };
				writeSettings({ figmaFiles: files });
			}
			else writeSettings({ figmaFileKey: f.key, figmaFileName: f.name });
			return { ok: true, key: f.key, name: f.name, fileLink: fileLink() };
		},
		// Old channel: parse a pasted text, store per project, return { key, name } or null.
		setFileFromText: (text) => {
			// A pasted text may hold the link among other words: take the first https figma link in it.
			const m = /https:\/\/(?:www\.)?figma\.com\/\S+/.exec(String(text || ""));
			const r = m ? self.setFile(m[0]) : { ok: false };
			return r.ok ? { key: r.key, name: r.name } : null;
		},
	};
	return self;
}

const HELP_URL = "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/";

let api;
function register(ctx) {
	const { ipcMain } = ctx;
	// Selftest only (ctx.selftest, never true in a packaged app; PI_CRUST_SELFTEST=1 and PI_CRUST_FIGMA_STUB=<port>, with PI_CRUST_FIGMA_MCP_URL pointing at that port):
	// the stub Figma server runs in this process, the file link lives in memory (never touches the real settings.json),
	// and the process check answers what the test says.
	const stubPort = ctx.selftest === true && Number(process.env.PI_CRUST_FIGMA_STUB);
	let mem = {};
	let stub = null;
	let procFacts = {};
	api = makeApi({
		readSettings: () => (stubPort ? mem : ctx.readSettings()),
		writeSettings: (p) => (stubPort ? void Object.assign(mem, p) : ctx.writeSettings(p)),
		getRepo: () => ctx.repo,
		probe: () => require("./figma-mcp").probe(),
		checkProcess: () => (stubPort ? Promise.resolve(procFacts) : require("./figma-status").checkFigmaProcess()),
	});
	ipcMain.handle("figma:status", () => api.status());
	ipcMain.handle("figma:test", () => api.test());
	ipcMain.handle("figma:setFile", (_e, link) => api.setFile(link));
	ipcMain.handle("figma:setFileFromText", (_e, text) => api.setFileFromText(text));
	ipcMain.handle("figma:file", () => legacyFile(api.file()));
	ipcMain.handle("figma:openHelp", () => {
		require("electron").shell.openExternal(HELP_URL);
		return {};
	});
	if (stubPort) {
		ipcMain.handle("figma:stubMode", async (_e, mode, o = {}) => {
			if (stub) await stub.close();
			stub = null;
			procFacts = o.proc || {};
			if (o.clearFile) mem = {};
			stub = await require("../scripts/figma-stub-server").start(mode, stubPort, { delayMs: o.delayMs || 0 });
			return true;
		});
	}
	return api;
}

module.exports = { repoKey, HELP_URL, register, makeApi, fileFor, legacyFile };
