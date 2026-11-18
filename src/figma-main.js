// Main-process side of the Figma setup: connection status, Test connection and the per-project file link.
// IPC: figma:status, figma:test, figma:setFile, figma:file, figma:setFileFromText (old name, kept).
// No timer and no probe at startup: the renderer asks (Design tab opened, panel opened, Test connection, after a failed Figma action).
"use strict";

// File link for a repo: this project's entry first, then the old app-wide value, then the env var.
// Returns { key, name, scope: "project" | "app" | "env" | null }.
function fileFor(settings, repo, env = process.env) {
	const s = settings || {};
	const p = repo && s.figmaFiles && s.figmaFiles[repo];
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
	const file = () => fileFor(readSettings(), getRepo(), env);
	const fileLink = () => {
		const f = file();
		return { set: !!f.key, name: f.name, scope: f.scope };
	};
	async function run() {
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
			const f = parseFigmaUrl(String(link || ""));
			if (!f) return { ok: false, error: "That doesn't look like a Figma link. Paste a link to a Figma file." };
			const repo = getRepo();
			if (repo) writeSettings({ figmaFiles: { ...(readSettings().figmaFiles || {}), [repo]: { key: f.key, name: f.name } } });
			else writeSettings({ figmaFileKey: f.key, figmaFileName: f.name });
			return { ok: true, key: f.key, name: f.name, fileLink: fileLink() };
		},
		// Old channel: parse a pasted text, store per project, return { key, name } or null.
		setFileFromText: (text) => {
			const f = parseFigmaUrl(String(text || ""));
			if (!f) return null;
			const r = self.setFile(text);
			return r.ok ? { key: f.key, name: f.name } : null;
		},
	};
	return self;
}

let api;
function register(ctx) {
	const { ipcMain } = ctx;
	api = makeApi({
		readSettings: () => ctx.readSettings(),
		writeSettings: (p) => ctx.writeSettings(p),
		getRepo: () => ctx.repo,
		probe: () => require("./figma-mcp").probe(),
		checkProcess: () => require("./figma-status").checkFigmaProcess(),
	});
	ipcMain.handle("figma:status", () => api.status());
	ipcMain.handle("figma:test", () => api.test());
	ipcMain.handle("figma:setFile", (_e, link) => api.setFile(link));
	ipcMain.handle("figma:setFileFromText", (_e, text) => api.setFileFromText(text));
	ipcMain.handle("figma:file", () => legacyFile(api.file()));
	return api;
}

module.exports = { register, makeApi, fileFor, legacyFile };
