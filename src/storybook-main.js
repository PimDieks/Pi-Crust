// Storybook detection for the Design tab's Stories view (main process).
//  - finds `storybook` scripts in the repo root and in apps/*, libs/*, packages/* (and which package manager to use);
//  - probes the running Storybook (settings `storybookUrl`, default http://localhost:6006): /index.json, then /stories.json.
//  - also tries ports from the scripts (`-p 6007`) when no URL is configured, and resolves a story to its files (storybook:resolve).
// register(ctx) wires the IPC handlers `storybook:detect`, `storybook:setUrl` and `storybook:resolve`.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_URL = "http://localhost:6006";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SRC_BYTES = 2 * 1024 * 1024;
const validUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u.trim());

// index.json (Storybook 7+: { entries }) or stories.json ({ stories }) -> [{ id, title, name, importPath }] (stories only, no docs pages).
function parseIndex(json) {
	const entries = json && (json.entries || json.stories);
	if (!entries || typeof entries !== "object") return [];
	return Object.values(entries)
		.filter((e) => e && e.id && (!e.type || e.type === "story"))
		.map((e) => {
			const s = { id: String(e.id), title: String(e.title || e.kind || ""), name: String(e.name || e.story || e.id), importPath: e.importPath ? String(e.importPath) : "" };
			if (e.componentPath) s.componentPath = String(e.componentPath);
			if (Array.isArray(e.tags)) s.tags = e.tags.map(String);
			return s;
		});
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function packageManager(repo) {
	if (fs.existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(repo, "yarn.lock"))) return "yarn";
	return "npm";
}

// The port a storybook script asks for: `-p 6007`, `--port 6007`, `--port=6007`.
function portOf(script) {
	const m = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{2,5})\b/.exec(String(script || ""));
	return m ? Number(m[1]) : 0;
}

// -> [{ dir: relative dir ("" = root), name: package name, script: "storybook" | "start-storybook", port: 0 when unknown }]
function detectProjects(repo) {
	const dirs = [""];
	for (const group of ["apps", "libs", "packages"]) {
		try {
			for (const d of fs.readdirSync(path.join(repo, group), { withFileTypes: true })) if (d.isDirectory()) dirs.push(`${group}/${d.name}`);
		} catch {}
	}
	const out = [];
	for (const dir of dirs) {
		const pkg = readJson(path.join(repo, dir, "package.json"));
		const scripts = (pkg && pkg.scripts) || {};
		const script = ["storybook", "start-storybook", "storybook:start"].find((s) => scripts[s]);
		if (script) out.push({ dir, name: (pkg && pkg.name) || dir || path.basename(repo), script, port: portOf(scripts[script]) });
	}
	return out;
}

async function fetchJson(url, ms = 2000) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), ms);
	try {
		const res = await fetch(url, { signal: ctl.signal });
		if (!res.ok) return null;
		if (Number(res.headers.get("content-length")) > MAX_JSON_BYTES) return null;
		// Read with a cap: a server can lie about (or omit) the length.
		const reader = res.body.getReader();
		const chunks = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_JSON_BYTES) {
				ctl.abort();
				return null;
			}
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function probe(baseUrl) {
	const base = baseUrl.replace(/\/+$/, "");
	for (const file of ["index.json", "stories.json"]) {
		const json = await fetchJson(`${base}/${file}`);
		const stories = parseIndex(json);
		if (stories.length) return stories;
	}
	return null;
}

// --- resolving a story to its files (pure parts, tested) ---------------------------------------
const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");

// `component: Button` (or `Button.Item`) in the stories file -> "Button"
function componentName(src) {
	const m = /\bcomponent\s*:\s*([A-Za-z_$][\w$]*)/.exec(src);
	return m ? m[1] : "";
}

// The module specifier `name` is imported from (default, named or `x as name`), or "".
function importSource(src, name) {
	if (!name) return "";
	const re = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
	for (let m; (m = re.exec(src)); ) {
		const clause = m[1];
		const braces = /\{([^}]*)\}/.exec(clause);
		const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[\w$]+/, "").replace(/,/g, "").trim();
		if (def === name) return m[2];
		if (braces && braces[1].split(",").some((p) => p.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim() === name)) return m[2];
	}
	return "";
}

// A relative specifier next to `fromFile` -> an existing file path (absolute), or "". `isFile` is injectable for tests.
function resolveRelative(fromFile, spec, isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile()) {
	if (!spec || !spec.startsWith(".")) return "";
	const base = path.resolve(path.dirname(fromFile), spec);
	const bare = base.replace(/\.(m?js|jsx)$/, "");
	const tries = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => bare + e), ...EXTS.map((e) => path.join(base, "index" + e))];
	return tries.find(isFile) || "";
}

// The export that belongs to a story name ("With image" -> withImage / WithImage), or "".
function exportNameFor(src, story) {
	const names = [...src.matchAll(/export\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
	const want = [norm(story.name), norm(String(story.id || "").split("--").slice(1).join("-"))].filter(Boolean);
	return names.find((n) => want.includes(norm(n))) || "";
}

const FIGMA_RE = /https:\/\/(?:www\.)?figma\.com\/[^\s'"`)<>\\]+/;
// A Figma URL (addon-designs `parameters.design.url`): from the story's own export when there is one, else the first in the file.
function figmaUrlIn(src, exportName) {
	if (exportName) {
		const start = src.search(new RegExp(`export\\s+(?:const|let|var|function)\\s+${exportName.replace(/\$/g, "\\$")}\\b`));
		if (start >= 0) {
			const rest = src.slice(start + 1);
			const next = rest.search(/\nexport\s/);
			const own = FIGMA_RE.exec(next < 0 ? rest : rest.slice(0, next));
			if (own) return own[0];
		}
	}
	const m = FIGMA_RE.exec(src);
	return m ? m[0] : "";
}

// -> { storyFile, componentFile, figmaUrl, exportName }, repo-relative; "" for what can't be found.
function resolveStory(repo, projects, story, guard = (rel) => path.resolve(repo, rel)) {
	const out = { storyFile: "", componentFile: "", figmaUrl: "", exportName: "" };
	const isFile = (f) => {
		try {
			return fs.statSync(f).isFile();
		} catch {
			return false;
		}
	};
	const inside = (abs) => {
		try {
			const rel = path.relative(repo, abs);
			if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "";
			guard(rel);
			return rel.split(path.sep).join("/");
		} catch {
			return "";
		}
	};
	const dirs = [...projects.map((p) => p.dir), ""];
	const find = (rel) => {
		if (!rel) return "";
		for (const d of dirs) {
			const abs = path.resolve(repo, d, rel);
			if (isFile(abs) && inside(abs)) return abs;
		}
		return "";
	};
	const storyAbs = find(story.importPath);
	if (!storyAbs) return out;
	out.storyFile = inside(storyAbs);
	let src = "";
	try {
		const fd = fs.openSync(storyAbs, "r");
		try {
			const buf = Buffer.alloc(MAX_SRC_BYTES);
			src = buf.subarray(0, fs.readSync(fd, buf, 0, MAX_SRC_BYTES, 0)).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {}
	out.exportName = exportNameFor(src, story);
	out.figmaUrl = figmaUrlIn(src, out.exportName);
	let compAbs = find(story.componentPath);
	if (!compAbs) compAbs = resolveRelative(storyAbs, importSource(src, componentName(src)), isFile);
	if (compAbs) out.componentFile = inside(compAbs);
	return out;
}

// origin + path without a trailing slash: no query, hash or credentials.
function cleanUrl(u) {
	const x = new URL(String(u).trim());
	return x.origin + x.pathname.replace(/\/+$/, "");
}

function register(ctx) {
	let lastProjects = null; // { repo, projects } from the last detect, reused by storybook:resolve
	ctx.ipcMain.handle("storybook:detect", async () => {
		const set = ctx.readSettings().storybookUrl;
		let clean = "";
		try {
			clean = validUrl(set) ? cleanUrl(set) : "";
		} catch {}
		const invalid = !!set && !clean; // only valid http(s) URLs are probed
		const projects = ctx.repo ? detectProjects(ctx.repo) : [];
		lastProjects = { repo: ctx.repo, projects };
		const configured = !invalid && clean;
		const candidates = configured ? [clean] : [...new Set([DEFAULT_URL, ...projects.map((p) => p.port).filter(Boolean).map((p) => `http://localhost:${p}`)])];
		const results = await Promise.all(candidates.map(probe));
		const hit = results.findIndex((r) => r && r.length);
		const url = candidates[hit < 0 ? 0 : hit];
		const stories = hit < 0 ? [] : results[hit];
		return { url, invalidUrl: invalid, running: hit >= 0, stories, projects, pm: ctx.repo ? packageManager(ctx.repo) : "npm", custom: !!set };
	});
	ctx.ipcMain.handle("storybook:setUrl", (_e, url) => {
		const u = typeof url === "string" ? url.trim() : "";
		if (u && !validUrl(u)) return { ok: false, error: "The address must start with http:// or https://" };
		try {
			if (u) new URL(u);
		} catch {
			return { ok: false, error: "That isn't a valid address" };
		}
		ctx.writeSettings({ storybookUrl: u ? cleanUrl(u) : "" }); // "" = back to the default
		return { ok: true, url: u ? cleanUrl(u) : DEFAULT_URL };
	});
	ctx.ipcMain.handle("storybook:resolve", (_e, story) => {
		const empty = { storyFile: "", componentFile: "", figmaUrl: "", exportName: "" };
		if (!ctx.repo || !story || typeof story !== "object") return empty;
		try {
			return resolveStory(ctx.repo, lastProjects && lastProjects.repo === ctx.repo ? lastProjects.projects : (lastProjects = { repo: ctx.repo, projects: detectProjects(ctx.repo) }).projects, { id: String(story.id || ""), name: String(story.name || ""), importPath: String(story.importPath || ""), componentPath: story.componentPath ? String(story.componentPath) : "" }, (rel) => ctx.insideRepo(rel));
		} catch {
			return empty;
		}
	});
}

module.exports = { register, validUrl, parseIndex, detectProjects, packageManager, probe, portOf, componentName, importSource, resolveRelative, exportNameFor, figmaUrlIn, resolveStory, cleanUrl, DEFAULT_URL };
