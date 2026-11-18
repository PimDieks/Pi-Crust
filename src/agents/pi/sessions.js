// Pi's session files (phase 6: moved out of main.js, same reading rules). Pi stores them per working folder in
// ~/.pi/agent/sessions/--<cwd with dashes>--/*.jsonl. Reading only; nothing here writes. `path` stays an opaque string for the core.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sessionsDirFor = (cwd, home = os.homedir()) => path.join(home, ".pi", "agent", "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`); // as Pi names it (also C:\ paths)

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

// The repo's own sessions plus those of its worktrees ([{ cwd, branch }], found by the caller), newest first, at most 60.
// `home` is where ~/.pi lives (the real home, unless a test passes a fixture folder).
async function listSessions({ repo, worktrees = [], home = os.homedir() }) {
	const sources = [{ dir: sessionsDirFor(repo, home), cwd: null }];
	for (const wt of worktrees) sources.push({ dir: sessionsDirFor(wt.cwd, home), cwd: wt.cwd, branch: wt.branch });
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
}

module.exports = { sessionsDirFor, sessionSummary, listSessions };
