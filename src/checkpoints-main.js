// Checkpoints: a snapshot of the working tree (tracked + untracked, not ignored) taken when you send a message,
// so you can rewind the files later. SAFETY: this never touches the real index, HEAD, branches or the stash.
//  - snapshots are built with a throw-away copy of the index (GIT_INDEX_FILE) and stored as commits under refs/pi-crust/cp/*;
//  - restoring runs `read-tree -m -u` against that throw-away index, which only rewrites the working tree.
// register(ctx) wires the IPC handlers; createStore() is the testable core.
"use strict";

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hardenGitArgs } = require("./git-harden");

const REF_PREFIX = "refs/pi-crust/cp/";
const KEEP = 300;
const TEXT_MAX = 120;

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const normText = (t) => String(t || "").replace(/\s+/g, " ").trim();
const textHash = (t) => sha1(normText(t));

// Environment for a git child: drop anything that could redirect git to another repo or index.
function cleanEnv(base, extra = {}) {
	const env = { ...base };
	for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
	return { ...env, ...extra };
}

function git(cwd, args, env) {
	return new Promise((resolve) => {
		// Automatic on every message: hardened (no fsmonitor, no hooks such as reference-transaction, no filter driver that runs
		// a program; Git LFS's stay on, so a snapshot still stores LFS pointers). See git-harden.js.
		execFile("git", hardenGitArgs(args, { cwd }), { cwd, env, maxBuffer: 50e6, windowsHide: true }, (err, stdout, stderr) =>
			resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") || (err ? err.message : "") }),
		);
	});
}

// store: { repo, dataDir, env? }. All git operations of one store are serialised.
function createStore({ repo, dataDir, env: baseEnv = process.env, keep = KEEP }) {
	const metaFile = path.join(dataDir, `${sha1(repo)}.json`);
	let chain = Promise.resolve();
	const serial = (fn) => {
		const p = chain.then(fn, fn);
		chain = p.catch(() => {});
		return p;
	};
	const IDENT = { GIT_AUTHOR_NAME: "Pi Crust", GIT_AUTHOR_EMAIL: "pi-crust@localhost", GIT_COMMITTER_NAME: "Pi Crust", GIT_COMMITTER_EMAIL: "pi-crust@localhost" };
	let top = null;

	async function root() {
		if (top) return top;
		const r = await git(repo, ["rev-parse", "--show-toplevel"], cleanEnv(baseEnv));
		if (!r.ok) throw new Error("Not a git repository");
		top = fs.realpathSync(r.stdout.trim());
		return top;
	}
	// Commands on a throw-away index must not write a split index (its shared part would land next to the real index).
	const g = async (args, extra) => git(await root(), extra && extra.GIT_INDEX_FILE ? ["-c", "core.splitIndex=false", ...args] : args, cleanEnv(baseEnv, extra));
	const must = async (args, extra) => {
		const r = await g(args, extra);
		if (!r.ok) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
		return r.stdout.trim();
	};

	function readMeta() {
		try {
			const d = JSON.parse(fs.readFileSync(metaFile, "utf8"));
			return Array.isArray(d) ? d : [];
		} catch {
			return [];
		}
	}
	function writeMeta(list) {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(`${metaFile}.tmp`, JSON.stringify(list));
		fs.renameSync(`${metaFile}.tmp`, metaFile);
	}

	// Builds a tree of the current working tree using a copy of the real index. The real index is only read (copied).
	async function snapshotTree() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-idx-"));
		const idx = path.join(dir, "index");
		const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
		try {
			const real = path.resolve(await root(), await must(["rev-parse", "--git-path", "index"]));
			if (fs.existsSync(real)) {
				fs.copyFileSync(real, idx);
				// Git decides whether a same-size file changed within the index's own timestamp ("racy" entries) by comparing
				// with the index file's mtime. The copy must keep that mtime (rounded down, which only makes git re-check more).
				const ns = fs.statSync(real, { bigint: true }).mtimeNs;
				const t = Number(ns / 1000n - 1n) / 1e6;
				fs.utimesSync(idx, t, t);
			}
			const extra = { GIT_INDEX_FILE: idx };
			await must(["add", "-A"], extra);
			const tree = await must(["write-tree"], extra);
			return { tree, idx, cleanup };
		} catch (e) {
			cleanup();
			throw e;
		}
	}

	async function commitOf(tree, message) {
		const head = await g(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
		const args = ["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", message];
		if (head.ok && head.stdout.trim()) args.push("-p", head.stdout.trim());
		return must(args, IDENT);
	}

	async function prune() {
		const list = readMeta();
		if (list.length <= keep) return;
		const sorted = [...list].sort((a, b) => a.at - b.at);
		const drop = sorted.slice(0, list.length - keep);
		for (const e of drop) await g(["update-ref", "-d", REF_PREFIX + e.id]);
		const gone = new Set(drop.map((e) => e.id));
		writeMeta(list.filter((e) => !gone.has(e.id)));
	}

	async function createInner({ sessionFile = null, text = "", hidden = false, label, keepIndex = false } = {}) {
		const snap = await snapshotTree();
		try {
			const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
			const commit = await commitOf(snap.tree, `pi-crust checkpoint ${id}`);
			await must(["update-ref", REF_PREFIX + id, commit]);
			const entry = { id, commit, tree: snap.tree, sessionFile, textHash: textHash(text), text: normText(label || text).slice(0, TEXT_MAX), at: Date.now() };
			if (hidden) entry.hidden = true;
			writeMeta([...readMeta(), entry]);
			await prune();
			return keepIndex ? { entry, idx: snap.idx, cleanup: snap.cleanup } : (snap.cleanup(), { entry });
		} catch (e) {
			snap.cleanup();
			throw e;
		}
	}

	const find = (id) => readMeta().find((e) => e.id === id);
	const parseStatus = (out) =>
		out
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [status, ...p] = l.split("\t");
				return { status: status[0], path: p[p.length - 1], from: p.length > 1 ? p[0] : undefined };
			});

	return {
		create: (opts) => serial(async () => (await createInner(opts)).entry),
		// No session file (null) means no checkpoints; undefined means all of them (tests, tools).
		list: ({ sessionFile, includeHidden = false } = {}) =>
			(sessionFile === null ? [] : readMeta())
				.filter((e) => (includeHidden || !e.hidden) && (sessionFile === undefined || e.sessionFile === sessionFile))
				.sort((a, b) => a.at - b.at),
		// What restoring `id` would change in the working tree right now.
		preview: (id) =>
			serial(async () => {
				const target = find(id);
				if (!target) return { ok: false, error: "Checkpoint not found" };
				const snap = await snapshotTree();
				try {
					const out = await must(["diff", "--name-status", "--no-renames", snap.tree, target.tree]);
					return { ok: true, files: parseStatus(out) };
				} finally {
					snap.cleanup();
				}
			}),
		// Puts the working tree back to `id`. A hidden "before restore" checkpoint is made first (its id is the undo).
		restore: (id) =>
			serial(async () => {
				const target = find(id);
				if (!target) return { ok: false, error: "Checkpoint not found" };
				const pre = await createInner({ sessionFile: target.sessionFile, text: "", hidden: true, label: "before restore", keepIndex: true });
				try {
					const out = await must(["diff", "--name-status", "--no-renames", pre.entry.tree, target.tree]);
					const files = parseStatus(out);
					// The "before" snapshot holds every file that isn't ignored, so a file the checkpoint adds that already exists
					// on disk is an ignored one: read-tree would silently overwrite it. Refuse instead.
					const top = await root();
					const inTheWay = files.filter((f) => f.status === "A" && fs.existsSync(path.join(top, f.path)));
					if (inTheWay.length) return { ok: false, error: `Not restored: ${inTheWay[0].path}${inTheWay.length > 1 ? ` and ${inTheWay.length - 1} more` : ""} exist${inTheWay.length > 1 ? "" : "s"} as ignored file${inTheWay.length > 1 ? "s" : ""} and would be overwritten`, files: [] };
					const r = await g(["read-tree", "-m", "-u", pre.entry.tree, target.tree], { GIT_INDEX_FILE: pre.idx });
					if (!r.ok) return { ok: false, error: r.stderr.trim() || "read-tree failed", undoId: pre.entry.id, files: [] };
					return { ok: true, undoId: pre.entry.id, files };
				} finally {
					pre.cleanup();
				}
			}),
		// A fork gets its own copies of the checkpoints up to `beforeAt` (ms), so rewinding keeps working there.
		copy: (fromFile, toFile, beforeAt = Infinity) =>
			serial(async () => {
				const src = readMeta().filter((e) => e.sessionFile === fromFile && !e.hidden && e.at <= beforeAt);
				const added = [];
				for (const e of src) {
					const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
					await must(["update-ref", REF_PREFIX + id, e.commit]);
					added.push({ ...e, id, sessionFile: toFile });
				}
				if (added.length) writeMeta([...readMeta(), ...added]);
				await prune();
				return { ok: true, copied: added.length };
			}),
		clear: () =>
			serial(async () => {
				for (const e of readMeta()) await g(["update-ref", "-d", REF_PREFIX + e.id]);
				writeMeta([]);
				return { ok: true };
			}),
	};
}

function register(ctx) {
	// One store per working root: the repo, or the worktree of the chat the renderer names (its edits are what a checkpoint must
	// cover). The root comes from that chat, not from whichever tab is active, and a worktree is validated by ctx.rootFor.
	const stores = new Map();
	const get = async (chatId) => {
		const root = ctx.rootFor ? await ctx.rootFor(chatId) : ctx.repo;
		let store = stores.get(root);
		if (!store) {
			store = createStore({ repo: root, dataDir: path.join(ctx.app.getPath("userData"), "checkpoints"), env: ctx.env });
			stores.set(root, store);
		}
		return store;
	};
	// Errors become { ok:false, error } so the UI can fall back to conversation-only.
	const safe = (chatIdOf, fn) => async (_e, ...a) => {
		try {
			return await fn(await get(chatIdOf(...a)), ...a);
		} catch (e) {
			return { ok: false, error: e && e.message ? e.message : String(e) };
		}
	};
	const { ipcMain } = ctx;
	// Only known fields cross the IPC boundary (no hidden/label/keepIndex from the renderer).
	const file = (v) => (typeof v === "string" && v ? v : null);
	const idOf = (v) => (typeof v === "string" ? v : "");
	// Remote (remote-main.js): the same snapshot the renderer takes in sendPrompt, for prompts sent from the phone.
	ctx.createCheckpoint = async (chatId, sessionFile, text) => {
		try {
			return await (await get(chatId)).create({ sessionFile: file(sessionFile), text: String(text || "") });
		} catch {
			return null;
		}
	};
	ipcMain.handle("checkpoints:create", safe((o) => o?.chatId, async (s, o) => ({ ok: true, entry: await s.create({ sessionFile: file(o?.sessionFile), text: typeof o?.text === "string" ? o.text : "" }) })));
	ipcMain.handle("checkpoints:list", safe((o) => o?.chatId, async (s, o) => ({ ok: true, list: s.list({ sessionFile: file(o?.sessionFile) }) })));
	ipcMain.handle("checkpoints:preview", safe((_id, chatId) => chatId, (s, id) => s.preview(idOf(id))));
	ipcMain.handle("checkpoints:restore", safe((_id, chatId) => chatId, (s, id) => s.restore(idOf(id))));
	ipcMain.handle("checkpoints:copy", safe((_f, _t, _b, chatId) => chatId, (s, from, to, before) => (file(from) && file(to) ? s.copy(file(from), file(to), Number.isFinite(before) ? before : Infinity) : { ok: false, error: "No session file" })));
	ipcMain.handle("checkpoints:clear", safe((chatId) => chatId, (s) => s.clear()));
}

module.exports = { register, createStore, textHash, normText };
