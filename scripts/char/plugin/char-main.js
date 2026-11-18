// Characterization recorder and driver (main process). TEST TOOL: scripts/char/run.js copies it to src/local/ (gitignored) for one
// run and removes it afterwards. It does nothing unless PI_CRUST_CHAR_OUT is set.
//  - Records every `pi:*` event the main process sends to the renderer (through the app's own send tap), in order.
//  - Drives the scenario's `drive` list through the same ctx functions Remote uses (piSend, answerUi, stopChat, piRequest, restartChat).
// Env: PI_CRUST_CHAR_OUT (events file, JSONL), PI_CRUST_CHAR_TRANSCRIPT (scenario json).
"use strict";

const fs = require("node:fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (o, dotted) => dotted.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);

function register(ctx) {
	const outFile = process.env.PI_CRUST_CHAR_OUT;
	if (!outFile) return;
	const T = JSON.parse(fs.readFileSync(process.env.PI_CRUST_CHAR_TRANSCRIPT, "utf8"));
	fs.writeFileSync(outFile, "");
	const waiters = new Set();
	let readyChat = null;
	let readyResolve;
	const ready = new Promise((r) => (readyResolve = r));
	const rec = (e) => {
		fs.appendFileSync(outFile, JSON.stringify(e) + "\n");
		for (const w of [...waiters]) if (Object.entries(w.match).every(([k, v]) => get(e, k) === v)) (waiters.delete(w), w.resolve(true));
	};
	ctx.addSendTap((channel, payload) => {
		if (!channel.startsWith("pi:")) return;
		rec({ src: "main", channel, payload });
		if (channel === "pi:ready" && !readyChat) (readyChat = payload.chatId), readyResolve();
	});

	const waitEmit = (match, timeoutMs = 20000) =>
		new Promise((resolve) => {
			const w = { match, resolve };
			waiters.add(w);
			setTimeout(() => waiters.delete(w) && resolve(false), timeoutMs);
		});

	let done;
	const finished = new Promise((r) => (done = r));
	ctx.ipcMain.handle("local:char-wait", () => finished);

	async function step(s) {
		const chat = s.chat || readyChat;
		switch (s.do) {
			case "settle":
				await sleep(s.ms ?? 500);
				return {};
			case "send":
				return { sent: ctx.piSend(chat, s.record) };
			case "waitEmit":
				return { matched: await waitEmit(s.match, s.timeoutMs) };
			case "answerUi":
				return { accepted: ctx.answerUi(chat, s.response, s.by || "desktop") };
			case "stop":
				return { result: await ctx.stopChat(chat) };
			case "request": {
				const r = await ctx.piRequest(chat, s.type, s.extra || {}, s.timeoutMs || 5000);
				return { result: r };
			}
			case "restart":
				return { restarted: await ctx.restartChat(chat, s.file) };
			case "ipc": {
				// Calls a handler the app registered with ipcMain.handle, as the renderer would.
				const h = ctx.ipcMain._invokeHandlers && ctx.ipcMain._invokeHandlers.get(s.channel);
				if (!h) return { error: "no handler" };
				const r = await h({ sender: ctx.win && ctx.win.webContents }, ...(s.args || []));
				if (s.summary === "subs-status") return { rows: (r.rows || []).filter((x) => x.kind === "oauth").map((x) => [x.id, x.status, x.detail]) };
				return { result: r };
			}
			default:
				return { error: `unknown step ${s.do}` };
		}
	}

	(async () => {
		try {
			await ready;
			await sleep(T.settleMs ?? 1500); // the renderer's own start-up requests (get_state, models) finish first
			let i = 0;
			for (const s of T.drive || []) {
				const r = await step(s);
				rec({ src: "drive", i: i++, do: s.do, ...(s.log === false ? {} : r) });
			}
			await sleep(T.endMs ?? 1000);
		} catch (e) {
			rec({ src: "drive", error: String(e && e.message) });
		}
		done(true);
	})();
	setTimeout(() => (rec({ src: "drive", error: "driver timeout" }), done(false)), 90000);
}

module.exports = { register };
