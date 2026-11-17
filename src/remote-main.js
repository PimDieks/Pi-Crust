// Remote access: Electron wiring (config, lifecycle, IPC, Tailscale, push). The pure parts live in remote-*.js and webpush.js.
// Nothing here is ever logged that could carry a token, a pairing code or prompt text.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createTokenStore } = require("./remote-auth");
const { createHub, slimRecord, slimMessages } = require("./remote-state");
const { createShareSet } = require("./remote-share");
const { allowedHosts, allowedOrigins, pickLanAddress, listLanCandidates, parseSlash, DESKTOP_ONLY_COMMANDS } = require("./remote-routes");
const { createRemoteServer } = require("./remote-server");
const tailscale = require("./remote-tailscale");
const { generateVapidKeys, sendPush, isAllowedPushEndpoint } = require("./webpush");

const VAPID_SUBJECT = "mailto:pi-crust@users.noreply.github.com";
// owned: the Tailscale Serve mapping we created ({ httpsPort, target }), so we only ever remove our own.
// tailnetHost: the last good tailnet name, for when detection fails (tailscaled not ready after a reboot).
const DEFAULTS = { version: 1, enabled: false, mode: "tailscale", port: 7391, httpsPort: 443, lanAddress: null, tailnetHost: null, owned: null, pushPreview: true, vapid: null, devices: [], sharedSessions: [] };
const HTTPS_PORTS = [443, 8443, 10000];
const LAN_WARNING = "Plain HTTP on your Wi-Fi: no notifications, traffic is not encrypted";
const CHECKPOINT_WAIT_MS = 10_000;
const FUNNEL_STOPPED = "Tailscale Funnel is on for this port: Remote stopped so it is not on the public internet";
const LAN_CHECK_MS = 30_000;
const TS_POLL_MS = 60_000;
const TS_POLL_FAST_MS = 10_000;
const ts0 = () => ({ found: false, running: false, dnsName: "", https: false, loginName: "", tailnet: "", otherUsers: 0, serving: false, conflict: false, conflictReason: null, funnel: false, consentUrl: null, bin: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPort = (n) => Number.isInteger(n) && n >= 1024 && n <= 65535;

function register(ctx) {
	const { ipcMain } = ctx;

	// --- Selftest: Remote is never on; the panel just learns that it is unavailable. -------------
	if (ctx.selftest) {
		const off = () => ({ enabled: false, disabled: "selftest" });
		ipcMain.handle("remote:status", off);
		ipcMain.handle("remote:setEnabled", () => ({ ...off(), error: "Remote access is not available in the self-test" }));
		for (const ch of ["share", "configure", "newPairing", "cancelPairing", "unpair", "setupTailscale", "openExternal"]) ipcMain.handle(`remote:${ch}`, () => ({ error: "Remote access is not available in the self-test" }));
		return;
	}

	const { powerSaveBlocker, shell } = require("electron");
	const cfgFile = () => path.join(ctx.app.getPath("userData"), "remote.json");

	// --- Config ---------------------------------------------------------------------------------
	function readConfig() {
		let raw = {};
		try {
			raw = JSON.parse(fs.readFileSync(cfgFile(), "utf8")) || {};
		} catch {}
		const c = { ...DEFAULTS, ...raw, version: 1 };
		if (c.mode !== "tailscale" && c.mode !== "lan") c.mode = DEFAULTS.mode;
		if (!isPort(c.port)) c.port = DEFAULTS.port;
		if (!HTTPS_PORTS.includes(c.httpsPort)) c.httpsPort = 443;
		if (typeof c.lanAddress !== "string") c.lanAddress = null;
		c.enabled = c.enabled === true;
		c.tailnetHost = typeof c.tailnetHost === "string" && c.tailnetHost ? c.tailnetHost : null;
		c.pushPreview = c.pushPreview !== false;
		const o = c.owned;
		c.owned = o && typeof o === "object" && HTTPS_PORTS.includes(o.httpsPort) && typeof o.target === "string" ? { httpsPort: o.httpsPort, target: o.target } : null;
		// Older config: a boolean that meant "the mapping for the current port is ours".
		if (!c.owned && raw.tailscaleServeOwned === true) c.owned = { httpsPort: c.httpsPort, target: `http://127.0.0.1:${c.port}` };
		delete c.tailscaleServeOwned;
		if (!Array.isArray(c.devices)) c.devices = [];
		if (!Array.isArray(c.sharedSessions)) c.sharedSessions = [];
		return c;
	}
	function writeConfig() {
		const file = cfgFile();
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(tmp, JSON.stringify(cfg, null, "\t"), { mode: 0o600 });
			fs.renameSync(tmp, file);
		} catch (e) {
			log("config-write-failed", { message: e.message });
			try {
				fs.unlinkSync(tmp);
			} catch {}
		}
	}

	// --- Log (ring buffer, also to the console) -------------------------------------------------
	const activity = [];
	function log(action, detail = {}) {
		const time = new Date().toISOString();
		console.log("[remote]", time, action, JSON.stringify(detail));
		activity.push({ time, action, detail });
		if (activity.length > 100) activity.shift();
	}

	const cfg = readConfig();
	if (!cfg.vapid?.publicKey || !cfg.vapid?.privateJwk) {
		cfg.vapid = generateVapidKeys();
		writeConfig();
	}
	const auth = createTokenStore({
		load: () => cfg.devices,
		save: (devices) => {
			cfg.devices = devices;
			writeConfig();
		},
	});
	// Per-chat sharing: the phone only ever sees chats in here. The hub still tracks every chat so status is right the moment one is shared.
	const share = createShareSet({
		load: () => cfg.sharedSessions,
		save: (files) => {
			cfg.sharedSessions = files;
			writeConfig();
		},
	});
	const lastFile = new Map(); // chatId -> session file, as last reported by Pi (for forget and for the share test)
	const hub = createHub();
	hub.reset(ctx.repo || null);

	// --- State ----------------------------------------------------------------------------------
	let server = null;
	let running = false;
	let error = null;
	let boundHost = null;
	let boundPort = null;
	let lanAddress = null;
	let blockerId = null;
	let pairing = null; // { code, url, expiresAt, qr }
	let ts = ts0();
	let tsAt = 0;
	let tsBusy = null;
	let syncTimer = null;
	let tsPoll = null;
	let funnelStopped = false; // stopped because of Funnel: keep watching and start again once it is off
	let noLanAddress = false; // LAN mode found no address: try again when one shows up
	const seqs = new Map(); // chatId -> number of record events broadcast so far

	// Start, stop, configure and Tailscale setup await each other's work: run them one at a time.
	let queue = Promise.resolve();
	const enqueue = (fn) => {
		const run = queue.then(fn);
		queue = run.catch(() => {});
		return run;
	};

	const httpsMode = () => cfg.mode === "tailscale";
	// The detected name, else the last good one: an empty detection must never make every request a 421.
	const tailnetHost = () => ts.dnsName || cfg.tailnetHost || null;
	const baseUrl = () => {
		if (httpsMode()) return tailnetHost() ? `https://${tailnetHost()}${cfg.httpsPort === 443 ? "" : `:${cfg.httpsPort}`}` : null;
		return lanAddress ? `http://${lanAddress}:${cfg.port}` : null;
	};
	const hostParams = () => ({ mode: cfg.mode, port: cfg.port, httpsPort: cfg.httpsPort, tailnetHost: tailnetHost(), lanAddress });

	// The screen stays awake only while it matters: a phone is connected or a chat is working/waiting.
	function updateBlocker() {
		const want = !!server && running && (server.connectedDevices().length > 0 || hub.list().some((c) => c.status === "working" || c.status === "waiting"));
		if (want && blockerId === null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
		else if (!want && blockerId !== null) {
			try {
				powerSaveBlocker.stop(blockerId);
			} catch {}
			blockerId = null;
		}
	}

	function buildStatus() {
		const connected = new Set(server?.connectedDevices() || []);
		const candidates = listLanCandidates(os.networkInterfaces());
		const info = auth.pairingInfo();
		if (!info || !pairing || pairing.expiresAt !== info.expiresAt) pairing = null;
		let shared = [];
		try {
			shared = ctx.openChats().filter((c) => isShared(c.id, c.file)).map((c) => c.id);
		} catch {}
		return {
			enabled: cfg.enabled,
			shared,
			running,
			mode: cfg.mode,
			port: cfg.port,
			httpsPort: cfg.httpsPort,
			url: running ? baseUrl() : null,
			error,
			clients: connected.size,
			pushPreview: cfg.pushPreview,
			devices: auth.list().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, connected: connected.has(d.id), push: d.push, pairedVia: d.pairedVia })),
			lan: { address: lanAddress, interface: candidates.find((c) => c.address === lanAddress)?.name || null, preferred: cfg.lanAddress, candidates, warning: LAN_WARNING },
			tailscale: { found: ts.found, running: ts.running, dnsName: tailnetHost() || "", https: ts.https, loginName: ts.loginName, tailnet: ts.tailnet, otherUsers: ts.otherUsers, serving: ts.serving, conflict: ts.conflict, conflictReason: ts.conflictReason, funnel: ts.funnel, consentUrl: ts.consentUrl },
			pairing,
			activity: activity.slice(-20),
		};
	}
	const pushStatus = () => {
		try {
			ctx.send("remote:status", buildStatus());
		} catch {}
	};

	// --- Chats ----------------------------------------------------------------------------------
	// Chats closed on the desktop never produce an event: compare with main's list.
	function sync() {
		const open = ctx.openChats();
		const ids = new Set(open.map((c) => c.id));
		let changed = false;
		for (const c of hub.list()) {
			if (ids.has(c.id)) continue;
			// Closing a chat ends its sharing for good (the file too): reopening it later starts unshared.
			const was = isShared(c.id);
			share.forget(c.id, lastFile.get(c.id));
			lastFile.delete(c.id);
			hub.drop(c.id);
			seqs.delete(c.id);
			if (was) {
				server?.broadcast("chat_removed", { chatId: c.id });
				changed = true;
			}
		}
		if (changed) pushStatus();
		return open;
	}
	// A chat counts as shared by its id, or by its session file (survives restarts, when ids are reassigned).
	function isShared(id, file) {
		return share.isShared(id, file ?? lastFile.get(id) ?? ctx.openChats().find((c) => c.id === id)?.file ?? null);
	}
	const summaryOf = (o) => hub.summary(o.id) || { id: o.id, title: "", cwd: o.cwd, branch: null, status: o.running ? "starting" : "stopped", asking: 0, lastText: "", updatedAt: 0 };
	function listChats() {
		return sync().filter((o) => isShared(o.id, o.file)).map(summaryOf);
	}
	const notShared = () => ({ status: 404, error: "This chat is not shared with your phone" });

	// Make a chat visible to phones now: they get its summary.
	function shareChat(o) {
		share.share(o.id, o.file || lastFile.get(o.id) || null);
		log("share", { chat: o.id });
		server?.broadcast("chat", { chat: summaryOf(o) });
	}

	function emit(outs) {
		for (const o of outs || []) {
			// Everything a chat produces is filtered here: unshared chats never reach a phone or a notification.
			const id = o.sse ? o.sse[1]?.chatId ?? o.sse[1]?.chat?.id : o.push?.chatId;
			if (id !== undefined && !isShared(id)) continue;
			if (o.sse) server?.broadcast(...o.sse);
			if (o.push) queuePush(o.push);
		}
	}

	function onTap(channel, p) {
		if (channel === "repo:changed") {
			hub.apply(channel, p);
			server?.broadcast("reset", { repo: hub.repo(), chats: listChats() });
			return;
		}
		if (!channel.startsWith("pi:")) return;
		const open = sync();
		// Late events of a chat that was closed on the desktop.
		if (typeof p?.chatId !== "string" || !open.some((c) => c.id === p.chatId)) return;
		// Judge sharing by the file the chat had before this event, then follow it to a new session file.
		const wasShared = isShared(p.chatId);
		if ((channel === "pi:ready" || channel === "pi:started") && typeof p.sessionFile === "string" && p.sessionFile) {
			if (wasShared) {
				if (!share.ids().includes(p.chatId)) share.share(p.chatId, p.sessionFile); // shared by file after a restart: adopt the id
				else share.noteFile(p.chatId, p.sessionFile);
			}
			lastFile.set(p.chatId, p.sessionFile);
		}
		const outs = hub.apply(channel, p);
		emit(outs);
		if (outs.some((o) => o.sse?.[0] === "chat")) updateBlocker();
		if (channel === "pi:record" && server) {
			const record = slimRecord(p.record);
			// seq counts the records phones were sent, in order: getMessages returns the count at its cut so the phone can
			// replay exactly the records that came after the history it loaded.
			if (record) {
				const seq = (seqs.get(p.chatId) || 0) + 1;
				seqs.set(p.chatId, seq);
				if (wasShared) server.broadcast("record", { chatId: p.chatId, seq, record });
			}
		}
	}
	ctx.addSendTap(onTap);

	// --- Actions the phone can trigger ----------------------------------------------------------
	const actions = {
		listChats,
		async getMessages(id, device) {
			if (!isShared(id)) return notShared();
			log("messages", { device, chat: id });
			// main reads Pi's stdout in order: the seq captured when this answer is settled is the exact cut.
			const r = await ctx.piRequest(id, "get_messages", {}, 30_000, () => seqs.get(id) || 0);
			if (!r.success) return { status: 409, error: r.error || "Couldn't read the chat" };
			const list = Array.isArray(r.data?.messages) ? r.data.messages : [];
			if (!hub.summary(id)?.title) {
				const first = list.find((m) => m?.role === "user");
				const text = typeof first?.content === "string" ? first.content : (first?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
				emit(hub.setTitle(id, String(text || "").replace(/\s+/g, " ").trim()));
			}
			return { ...slimMessages(list), seq: r.mark ?? seqs.get(id) ?? 0 };
		},
		async prompt(id, text, mode, device) {
			if (!isShared(id)) return notShared();
			log("prompt", { device, chat: id });
			const slash = parseSlash(text);
			if (slash && DESKTOP_ONLY_COMMANDS.has(slash.name)) return { status: 400, error: `/${slash.name} is only available on the desktop` };
			if (slash?.name === "compact") {
				const r = await ctx.piRequest(id, "compact", slash.arg ? { customInstructions: slash.arg } : {}, 600_000);
				return r.success ? { disposition: "compacted" } : { status: 409, error: r.error || "Compaction failed" };
			}
			// Best effort: the same snapshot the desktop takes before a prompt, so Rewind works for phone prompts too.
			const file = ctx.openChats().find((c) => c.id === id)?.file || undefined;
			if (ctx.createCheckpoint) await Promise.race([ctx.createCheckpoint(id, file, text).catch(() => null), sleep(CHECKPOINT_WAIT_MS)]);
			const st = hub.summary(id)?.status;
			const working = st === "working" || st === "waiting";
			const streamingBehavior = mode === "followUp" ? "followUp" : mode === "steer" || working ? "steer" : "followUp";
			const r = await ctx.piRequest(id, "prompt", { message: text, streamingBehavior });
			return r.success ? { disposition: typeof r.data?.disposition === "string" ? r.data.disposition : working ? "queued" : "sent" } : { status: 409, error: r.error || "Pi didn't accept the message" };
		},
		async abort(id, device) {
			if (!isShared(id)) return notShared();
			log("abort", { device, chat: id });
			// Queued messages become "held" (shared with the desktop); they come back to the phone as a "held" event.
			await ctx.stopChat(id);
			return {};
		},
		heldTake(id, index, text, device) {
			if (!isShared(id)) return notShared();
			log("held-take", { device, chat: id });
			return ctx.heldTake(id, index, text);
		},
		// Model, thinking level: what the composer and the model pill show (the permission mode and context come with the summary).
		async getSettings(id) {
			if (!isShared(id)) return notShared();
			const [st, list, lv] = await Promise.all([ctx.piRequest(id, "get_state"), ctx.piRequest(id, "get_available_models"), ctx.piRequest(id, "get_available_thinking_levels")]);
			if (!st.success) return { status: 409, error: st.error || "Couldn't read the chat's settings" };
			const m = st.data?.model;
			const str = (s) => (typeof s === "string" ? s.slice(0, 200) : undefined);
			const models = (Array.isArray(list.data?.models) ? list.data.models : []).slice(0, 500).map((x) => ({ provider: str(x?.provider), id: str(x?.id), name: str(x?.name) })).filter((x) => x.provider && x.id);
			const levels = (Array.isArray(lv.data?.levels) ? lv.data.levels : []).filter((l) => typeof l === "string").slice(0, 20);
			return {
				model: m ? { provider: str(m.provider), id: str(m.id), name: str(models.find((x) => x.provider === m.provider && x.id === m.id)?.name || m.name) } : null,
				models,
				thinkingLevel: str(st.data?.thinkingLevel) || null,
				thinkingLevels: levels,
			};
		},
		async setSettings(id, change, device) {
			if (!isShared(id)) return notShared();
			log("settings", { device, chat: id, what: Object.keys(change)[0] });
			let r;
			if (change.model) r = await ctx.piRequest(id, "set_model", { provider: change.model.provider, modelId: change.model.id });
			else if (change.thinkingLevel) r = await ctx.piRequest(id, "set_thinking_level", { level: change.thinkingLevel });
			// /mode is an extension command: Pi runs it right away, also while it is working (like the desktop's selector).
			else if (change.mode) r = await ctx.piRequest(id, "prompt", { message: `/mode ${change.mode}` });
			if (!r?.success) return { status: 409, error: r?.error || "Pi didn't accept the change" };
			// The desktop's model pill and thinking select follow (the mode follows the extension's status by itself).
			if (!change.mode) {
				try {
					ctx.send("remote:chatSettings", { chatId: id });
				} catch {}
			}
			return {};
		},
		async answerUi(id, reqId, resp, device) {
			if (!isShared(id)) return notShared();
			// Only questions Pi is actually waiting on (the phone can't invent ids or answer expired ones).
			if (!hub.asks(id).some((a) => a.id === reqId)) return { status: 404, error: "Unknown or expired question" };
			log("answer", { device, chat: id });
			return !!(await ctx.answerUi(id, { type: "extension_ui_response", id: reqId, ...resp }, "remote"));
		},
		async newChat(device) {
			log("new-chat", { device });
			const id = await ctx.newChat(undefined, undefined);
			if (!id) return { status: 409, error: "Couldn't start a chat" };
			// A chat started from the phone is for the phone.
			const o = ctx.openChats().find((c) => c.id === id);
			if (o) shareChat(o);
			else share.share(id, null);
			pushStatus();
			return { chatId: id };
		},
		async restart(id, device) {
			if (!isShared(id)) return notShared();
			log("restart", { device, chat: id });
			const open = ctx.openChats().find((c) => c.id === id);
			if (!open) return { status: 404, error: "Unknown chat" };
			if (open.running) return { status: 409, error: "Pi is still running in this chat" };
			if ((await ctx.restartChat(id, open.file || undefined)) === false) return { status: 404, error: "This chat was closed" };
			return {};
		},
		async subscribePush(deviceId, sub) {
			if (!httpsMode()) return { status: 400, error: "Notifications need the Tailscale (HTTPS) mode" };
			if (!isAllowedPushEndpoint(sub.endpoint)) return { status: 400, error: "Unsupported push service" };
			auth.setPush(deviceId, sub);
			log("push-subscribed", { device: deviceId });
			pushStatus();
			return {};
		},
		async unsubscribePush(deviceId) {
			auth.setPush(deviceId, null);
			log("push-unsubscribed", { device: deviceId });
			pushStatus();
			return {};
		},
	};

	// --- Push -----------------------------------------------------------------------------------
	function queuePush({ kind, chatId, title, body }) {
		if (!running || !httpsMode()) return;
		const devices = auth.devicesWithPush();
		if (!devices.length) return;
		const label = String(title || "Chat").slice(0, 80);
		// Notification text shows on a lock screen: with the preview off nothing from the chat leaves this machine.
		const payload = JSON.stringify(
			cfg.pushPreview
				? { title: kind === "ask" ? `Pi asks — ${label}` : `Done — ${label}`, body: String(body || "").slice(0, 200), chatId, kind }
				: { title: "Pi Crust", body: kind === "ask" ? "Pi needs your answer" : "Pi finished", chatId, kind },
		);
		const topic = `c${crypto.createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16)}`;
		for (const d of devices) {
			if (!isAllowedPushEndpoint(d.push?.endpoint)) continue;
			sendPush(d.push, payload, { vapid: cfg.vapid, subject: VAPID_SUBJECT, urgency: kind === "ask" ? "high" : "normal", topic })
				.then((r) => {
					if (r.status === 404 || r.status === 410) {
						auth.setPush(d.id, null);
						pushStatus();
					} else if (r.status >= 400) log("push-failed", { device: d.id, status: r.status });
				})
				.catch((e) => log("push-failed", { device: d.id, message: String(e?.message || e).slice(0, 100) }));
		}
	}

	// --- Tailscale ------------------------------------------------------------------------------
	const runCli = (bin, args, opts = {}) => ctx.run(bin, args, { ...opts, cwd: os.homedir() });
	const ourTarget = () => `http://127.0.0.1:${cfg.port}`;
	// Ours: the target for the current port, or the one we created (the port setting may have changed since).
	const isOurs = (target) => !!target && (target === ourTarget() || (cfg.owned?.httpsPort === cfg.httpsPort && target === cfg.owned.target));

	function refreshTailscale() {
		if (tsBusy) return tsBusy;
		tsBusy = (async () => {
			try {
				const d = await tailscale.detect(runCli);
				// Only a good name is remembered; a failed detection has none and must not erase it.
				if (d.dnsName && d.dnsName !== cfg.tailnetHost) {
					cfg.tailnetHost = d.dnsName;
					writeConfig();
				}
				const next = { ...ts0(), found: d.found, running: d.running, dnsName: d.dnsName, https: d.https, loginName: d.loginName, tailnet: d.tailnet, otherUsers: d.otherUsers, bin: d.bin, consentUrl: ts.consentUrl };
				const host = d.dnsName || cfg.tailnetHost;
				if (d.found && d.running && host) {
					const st = await tailscale.serveStatus(runCli, d.bin, host, cfg.httpsPort);
					if (!st.ok) {
						// The CLI didn't answer: keep what we knew rather than flip to "not serving".
						Object.assign(next, { serving: ts.serving, conflict: ts.conflict, conflictReason: ts.conflictReason, funnel: ts.funnel });
					} else {
						const ours = isOurs(st.target);
						next.serving = ours && !st.otherHandlers && !st.tcpOther;
						next.funnel = st.funnel;
						next.conflict = st.funnel || (!!st.target && !ours) || st.otherHandlers || st.tcpOther;
						next.conflictReason = st.funnel ? "funnel" : next.conflict ? "other" : null;
					}
					if (next.serving) next.consentUrl = null;
				}
				ts = next;
				tsAt = Date.now();
				if (ts.funnel) stopForFunnel();
				else if (funnelStopped && cfg.enabled) enqueue(() => (funnelStopped && cfg.enabled && !running ? startImpl() : null));
			} catch (e) {
				log("tailscale-failed", { message: String(e?.message || e).slice(0, 100) });
			} finally {
				tsBusy = null;
			}
			pushStatus();
		})();
		return tsBusy;
	}

	// Funnel puts the port on the public internet: never keep serving there.
	function stopForFunnel() {
		if (!running || !httpsMode()) return;
		enqueue(async () => {
			if (!running || !httpsMode()) return;
			await stopImpl();
			funnelStopped = true;
			error = FUNNEL_STOPPED;
			log("funnel-stop", { httpsPort: cfg.httpsPort });
			pushStatus();
			schedulePoll();
		});
	}

	// Slow while all is well, fast while the name is missing or we aren't serving yet (tailscaled may still be starting).
	function schedulePoll() {
		clearTimeout(tsPoll);
		tsPoll = null;
		if (!cfg.enabled || !httpsMode() || (!running && !funnelStopped)) return;
		const fast = !ts.dnsName || !ts.serving;
		tsPoll = setTimeout(async () => {
			await refreshTailscale();
			schedulePoll();
		}, fast ? TS_POLL_FAST_MS : TS_POLL_MS);
		tsPoll.unref?.();
	}

	function portProblem() {
		return ts.conflictReason === "funnel"
			? `Tailscale Funnel is on for port ${cfg.httpsPort}: Remote would be on the public internet. Turn Funnel off first.`
			: `Port ${cfg.httpsPort} on your tailnet name already serves something else. Change it in Tailscale first.`;
	}

	async function setupTailscaleImpl() {
		await refreshTailscale();
		if (!ts.found) return { error: "Tailscale was not found. Install it first." };
		if (!ts.running) return { error: "Tailscale is not running or you're not signed in." };
		if (!tailnetHost()) return { error: "Tailscale's address isn't known yet. Try again in a moment." };
		if (ts.conflict) return { error: portProblem(), conflict: true };
		const r = await tailscale.serveOn(runCli, ts.bin, cfg.httpsPort, cfg.port);
		if (r.consentUrl) {
			ts = { ...ts, consentUrl: r.consentUrl };
			pushStatus();
			return { error: "Tailscale needs your approval first", consentUrl: r.consentUrl };
		}
		if (!r.ok) {
			log("serve-failed", { output: String(r.output || "").slice(0, 200) });
			return { error: String(r.output || "tailscale serve failed").split("\n").find(Boolean)?.slice(0, 200) || "tailscale serve failed" };
		}
		cfg.owned = { httpsPort: cfg.httpsPort, target: ourTarget() };
		writeConfig();
		log("serve-on", { httpsPort: cfg.httpsPort });
		await refreshTailscale();
		return buildStatus();
	}

	// Remove the mapping we created, but only while that port still holds exactly it. `owned` is cleared after success only.
	async function releaseOwned() {
		const o = cfg.owned;
		if (!o) return true;
		await refreshTailscale();
		const host = ts.dnsName || cfg.tailnetHost;
		if (!ts.bin || !ts.running || !host) {
			log("serve-release-skipped", { reason: "tailscale unavailable" });
			return false;
		}
		const st = await tailscale.serveStatus(runCli, ts.bin, host, o.httpsPort);
		if (!st.ok) return false;
		if (st.target === o.target && !st.otherHandlers && !st.tcpOther) {
			const r = await tailscale.serveOff(runCli, ts.bin, o.httpsPort);
			if (!r.ok) {
				log("serve-off-failed", { httpsPort: o.httpsPort });
				return false;
			}
			log("serve-off", { httpsPort: o.httpsPort });
		} else if (st.target || st.otherHandlers || st.tcpOther) {
			log("serve-kept", { httpsPort: o.httpsPort }); // changed since: not ours to remove
		}
		cfg.owned = null;
		writeConfig();
		await refreshTailscale();
		return true;
	}

	// --- Lifecycle (only called through enqueue, or from other *Impl functions) ----------------------
	async function startImpl() {
		if (running) return;
		error = null;
		funnelStopped = false;
		noLanAddress = false;
		try {
			auth.pruneStale();
			if (httpsMode()) {
				// Know the name and whether Funnel is on before listening, but don't hang here when the CLI is slow.
				await Promise.race([refreshTailscale(), sleep(8000)]);
				if (ts.funnel) {
					error = FUNNEL_STOPPED;
					funnelStopped = true;
					log("funnel-stop", { httpsPort: cfg.httpsPort });
					return;
				}
				boundHost = "127.0.0.1";
				lanAddress = null;
			} else {
				lanAddress = pickLanAddress(os.networkInterfaces(), cfg.lanAddress);
				if (!lanAddress) {
					noLanAddress = true;
					throw new Error("No private Wi-Fi/LAN address found. Connect to a network or use Tailscale.");
				}
				boundHost = lanAddress;
			}
			const s = createRemoteServer({
				host: boundHost,
				port: cfg.port,
				via: () => (httpsMode() ? "tailscale" : "lan"),
				hostsAllowed: () => allowedHosts(hostParams()),
				originsAllowed: () => allowedOrigins(hostParams()),
				auth,
				hub,
				actions,
				isShared: (id) => isShared(id),
				vapidPublicKey: () => (httpsMode() ? cfg.vapid.publicKey : null),
				log,
				onClientsChanged: () => {
					updateBlocker();
					pushStatus();
				},
			});
			try {
				boundPort = (await s.listen()).port;
			} catch (e) {
				throw new Error(e.code === "EADDRINUSE" ? `Port ${cfg.port} is already in use` : e.message);
			}
			server = s;
			running = true;
			updateBlocker();
			syncTimer = setInterval(() => {
				if (server?.connectedDevices().length) sync();
				updateBlocker(); // an ask can time out without any event
			}, 2000);
			syncTimer.unref?.();
			log("started", { mode: cfg.mode, port: boundPort });
		} catch (e) {
			error = e.message;
			running = false;
			log("start-failed", { message: e.message });
		} finally {
			schedulePoll();
			pushStatus();
		}
	}

	async function stopImpl({ teardownServe = false } = {}) {
		clearInterval(syncTimer);
		syncTimer = null;
		clearTimeout(tsPoll);
		tsPoll = null;
		funnelStopped = false;
		auth.cancelPairing();
		pairing = null;
		const s = server;
		server = null;
		running = false;
		updateBlocker();
		if (s) await s.close().catch(() => {});
		if (teardownServe && cfg.owned) await releaseOwned();
		if (s) log("stopped", {});
		pushStatus();
	}

	async function restartImpl() {
		await stopImpl();
		await startImpl();
	}

	const lanTimer = setInterval(() => {
		if (!cfg.enabled || httpsMode()) return;
		enqueue(async () => {
			if (!cfg.enabled || httpsMode()) return;
			const cands = listLanCandidates(os.networkInterfaces());
			if (running) {
				if (cands.some((c) => c.address === lanAddress)) return;
				log("lan-address-gone", {});
				await restartImpl(); // binds the new best address, or stops with an error when there is none
			} else if (noLanAddress && cands.length) await startImpl();
		}).catch(() => {});
	}, LAN_CHECK_MS);
	lanTimer.unref?.();

	ctx.app.whenReady().then(() => cfg.enabled && enqueue(startImpl));
	ctx.app.on("before-quit", () => {
		enqueue(() => stopImpl()).catch(() => {});
	});

	// --- IPC ------------------------------------------------------------------------------------
	ipcMain.handle("remote:status", () => {
		// Tailscale can change under us (signed out, serve removed): look again, the answer arrives as a status event.
		if (cfg.enabled && httpsMode() && Date.now() - tsAt > 10_000) refreshTailscale();
		return buildStatus();
	});
	const setEnabledImpl = async (on) => {
		cfg.enabled = on === true;
		writeConfig();
		if (cfg.enabled) await startImpl();
		else {
			error = null;
			await stopImpl({ teardownServe: true });
		}
		return buildStatus();
	};
	ipcMain.handle("remote:setEnabled", (_e, on) => enqueue(() => setEnabledImpl(on)));
	ipcMain.handle("remote:share", (_e, chatId, on) => {
		const o = typeof chatId === "string" ? ctx.openChats().find((c) => c.id === chatId) : null;
		if (!o) return { error: "Unknown chat" };
		if (on === true) {
			if (!isShared(o.id, o.file)) shareChat(o);
			// Sharing a chat turns Remote on (through the lifecycle queue, like the switch does).
			return cfg.enabled ? (pushStatus(), buildStatus()) : enqueue(() => setEnabledImpl(true));
		}
		const was = isShared(o.id, o.file);
		share.unshare(o.id, o.file || null);
		if (lastFile.get(o.id)) share.unshare(o.id, lastFile.get(o.id)); // Pi may already be on another file than main knows
		if (was) {
			log("unshare", { chat: o.id });
			server?.broadcast("chat_removed", { chatId: o.id });
		}
		pushStatus();
		return buildStatus();
	});
	ipcMain.handle("remote:configure", (_e, o) =>
		enqueue(async () => {
			o = o && typeof o === "object" ? o : {};
			const mode = o.mode === undefined ? cfg.mode : o.mode;
			const port = o.port === undefined ? cfg.port : Number(o.port);
			const httpsPort = o.httpsPort === undefined ? cfg.httpsPort : Number(o.httpsPort);
			if (mode !== "tailscale" && mode !== "lan") return { error: "Unknown mode" };
			if (!isPort(port)) return { error: "Port must be between 1024 and 65535" };
			if (!HTTPS_PORTS.includes(httpsPort)) return { error: "HTTPS port must be 443, 8443 or 10000" };
			if (o.pushPreview !== undefined && typeof o.pushPreview !== "boolean") return { error: "pushPreview must be true or false" };
			const lan = typeof o.lanAddress === "string" && o.lanAddress ? o.lanAddress : null;
			const serveChanged = mode !== cfg.mode || port !== cfg.port || httpsPort !== cfg.httpsPort;
			const changed = serveChanged || lan !== cfg.lanAddress;
			const hadOwned = !!cfg.owned;
			// The old mapping would keep pointing at the old port: remove it (if it is still only ours) before moving.
			if (serveChanged && hadOwned) await releaseOwned();
			Object.assign(cfg, { mode, port, httpsPort, lanAddress: lan });
			if (typeof o.pushPreview === "boolean") cfg.pushPreview = o.pushPreview;
			writeConfig();
			if (changed && running) await restartImpl();
			else if (changed && cfg.enabled) await startImpl();
			if (serveChanged && hadOwned && running && httpsMode()) {
				const r = await setupTailscaleImpl();
				if (r?.error) log("serve-setup-failed", { message: r.error.slice(0, 100) });
			}
			pushStatus();
			return buildStatus();
		}),
	);
	ipcMain.handle("remote:newPairing", () => {
		if (!running) return { error: "Turn Remote on first" };
		// A phone can only open an https link once the mapping exists and we know the name it will be reached by.
		if (httpsMode() && !(ts.serving && tailnetHost())) return { error: "Set up Tailscale Serve first" };
		const base = baseUrl();
		if (!base) return { error: httpsMode() ? "Tailscale's address isn't known yet. Check Tailscale is running." : "No Wi-Fi address found" };
		const { code, expiresAt } = auth.newPairing();
		const url = `${base}/#pair=${code}`;
		let qr = "";
		try {
			const q = require("qrcode-generator")(0, "M");
			q.addData(url);
			q.make();
			qr = q.createDataURL(6, 4);
		} catch (e) {
			log("qr-failed", { message: e.message }); // the code is still shown as text
		}
		pairing = { code, url, expiresAt, qr };
		log("pairing-started", {});
		pushStatus();
		return pairing;
	});
	ipcMain.handle("remote:cancelPairing", () => {
		auth.cancelPairing();
		pairing = null;
		pushStatus();
		return {};
	});
	ipcMain.handle("remote:unpair", (_e, id) => {
		if (typeof id !== "string") return { error: "Unknown device" };
		auth.revoke(id);
		server?.closeDevice(id);
		log("unpaired", { device: id });
		pushStatus();
		return {};
	});
	ipcMain.handle("remote:setupTailscale", () => enqueue(setupTailscaleImpl));
	ipcMain.handle("remote:openExternal", (_e, url) => {
		if (typeof url !== "string" || !(url.startsWith("https://login.tailscale.com/") || url.startsWith("https://tailscale.com/"))) return { error: "Link not allowed" };
		shell.openExternal(url);
		return {};
	});
}

module.exports = { register };
