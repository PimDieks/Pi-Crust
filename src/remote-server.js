// Remote access: the HTTP server (node:http only, no Electron). Static phone app, JSON API, SSE. Everything it can do to
// a chat goes through `actions`, which remote-main.js wires to main.js. Binds to one loopback or private LAN address only.
// Auth is a bearer token (Authorization header), never a cookie: a cookie would also go to other ports on the same host.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const net = require("node:net");
const {
	resolveStatic,
	matchRoute,
	checkHost,
	checkOrigin,
	isPrivateLan,
	isLoopback,
	readJson,
	SECURITY_HEADERS,
	PAGE_CSP,
	PERMISSION_MODES,
} = require("./remote-routes");
const { isValidSubscriptionKeys } = require("./webpush");

const MAX_STREAMS_PER_DEVICE = 3;
const PING_MS = 25_000;
const MAX_BACKLOG = 1_000_000;
const MAX_PROMPT = 32 * 1024;
const MODES = new Set(["auto", "steer", "followUp"]);

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

function createRemoteServer({
	host,
	port,
	via = () => "tailscale", // how phones reach us right now: "tailscale" | "lan"
	hostsAllowed,
	originsAllowed,
	auth,
	hub,
	actions,
	isShared = () => true, // per-chat sharing: an unshared chat is as good as unknown to a phone
	vapidPublicKey = () => null,
	log = () => {},
	onClientsChanged = () => {},
	maxStreams = 30,
} = {}) {
	if (typeof host !== "string" || !net.isIPv4(host) || !(isLoopback(host) || isPrivateLan(host))) throw new Error("Remote server must listen on a loopback or private LAN IPv4 address");

	const streams = new Set(); // { res, deviceId, ping }

	const connectedDevices = () => [...new Set([...streams].map((s) => s.deviceId))];
	const notifyClients = () => {
		try {
			onClientsChanged(connectedDevices());
		} catch {}
	};

	function sendJson(res, status, body, extraHeaders) {
		if (res.headersSent) return res.end();
		const text = JSON.stringify(body ?? {});
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...extraHeaders });
		res.end(text);
	}
	const fail = (res, status, error) => sendJson(res, status, { error });

	function authenticate(req) {
		const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
		const device = bearer ? auth.verify(bearer[1]) : null;
		// A Wi-Fi pairing only works in Wi-Fi mode: it was made over plain http.
		if (device && device.pairedVia === "lan" && via() !== "lan") return null;
		return device;
	}

	function serveStatic(res, entry) {
		const headers = { "Content-Type": entry.type };
		if (entry.type.startsWith("text/html")) {
			headers["Content-Security-Policy"] = PAGE_CSP;
			headers["Cache-Control"] = "no-cache";
		} else if (entry.file.endsWith("sw.js")) headers["Cache-Control"] = "no-cache";
		const stream = fs.createReadStream(entry.file);
		stream.once("open", () => {
			res.writeHead(200, headers);
			stream.pipe(res);
		});
		stream.once("error", () => fail(res, 404, "Not found"));
		res.once("close", () => stream.destroy());
	}

	function openStream(req, res, device) {
		// A phone that reconnects leaves a stale stream behind for a while: the newest wins, the oldest of that device goes.
		const mine = [...streams].filter((x) => x.deviceId === device.id);
		while (mine.length >= MAX_STREAMS_PER_DEVICE) evict(mine.shift());
		if (streams.size >= maxStreams) return fail(res, 503, "Too many open connections");
		req.socket.setTimeout(0);
		req.socket.setKeepAlive(true);
		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		res.flushHeaders?.();
		res.write("retry: 3000\n\n");
		const s = { res, deviceId: device.id, ping: null };
		streams.add(s);
		s.ping = setInterval(() => write(s, ": ping\n\n"), PING_MS);
		s.ping.unref?.();
		const gone = () => {
			clearInterval(s.ping);
			if (streams.delete(s)) notifyClients();
		};
		res.once("close", gone);
		res.once("error", gone);
		write(s, frame("hello", { repo: hub.repo?.() ?? null, device: { id: device.id, name: device.name }, chats: actions.listChats(), serverTime: Date.now() }));
		notifyClients();
	}

	function evict(s) {
		clearInterval(s.ping);
		streams.delete(s);
		s.res.destroy();
	}

	const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	function write(s, text) {
		if (s.res.destroyed) return;
		// A phone that stopped reading: drop it, it reconnects and resyncs.
		if (s.res.writableLength > MAX_BACKLOG) return s.res.destroy();
		try {
			s.res.write(text);
		} catch {
			s.res.destroy();
		}
	}
	function broadcast(event, data) {
		if (!streams.size) return;
		const text = frame(event, data);
		for (const s of [...streams]) write(s, text);
	}
	function closeDevice(deviceId) {
		for (const s of [...streams]) if (s.deviceId === deviceId) s.res.end();
	}

	const result = (res, r, ok = {}) => {
		if (r && r.error) return fail(res, r.status || 400, r.error);
		sendJson(res, 200, r && typeof r === "object" ? r : ok);
	};

	const knownChat = (id) => {
		if (!hub.summary(id)) throw new HttpError(404, "Unknown chat");
		if (!isShared(id)) throw new HttpError(404, "This chat is not shared with your phone");
	};

	async function api(req, res, route, url) {
		const { name, params } = route;
		if (name === "pair") {
			const body = await readJson(req);
			const r = auth.redeem(typeof body.code === "string" ? body.code : "", typeof body.deviceName === "string" ? body.deviceName : "", via());
			if (r.error) {
				log("pair-failed", { status: r.status });
				return fail(res, r.status || 401, r.error);
			}
			log("paired", { device: r.device.id });
			notifyClients();
			// The phone keeps the token itself (localStorage) and sends it as a bearer header.
			return sendJson(res, 200, { token: r.token, device: { id: r.device.id, name: r.device.name } });
		}

		const device = authenticate(req);
		if (!device) return fail(res, 401, "Not paired");

		switch (name) {
			case "unpair":
				await readJson(req);
				auth.revoke(device.id);
				closeDevice(device.id);
				log("unpaired", { device: device.id });
				notifyClients();
				return sendJson(res, 200, {});
			case "state":
				return sendJson(res, 200, {
					repo: hub.repo?.() ?? null,
					device: { id: device.id, name: device.name },
					chats: actions.listChats(),
					serverTime: Date.now(),
					push: { available: !!vapidPublicKey(), subscribed: !!device.push },
					vapidPublicKey: vapidPublicKey() || null,
				});
			case "events":
				return openStream(req, res, device);
			case "messages": {
				knownChat(params.id);
				if (hub.summary(params.id).status === "stopped") throw new HttpError(409, "Pi is not running in this chat");
				const r = await actions.getMessages(params.id, device.id);
				if (r?.error) return fail(res, r.status || 409, r.error);
				return sendJson(res, 200, { chat: hub.summary(params.id), messages: r.messages, truncated: !!r.truncated, seq: r.seq ?? 0, asks: hub.asks(params.id), queue: hub.queue(params.id), held: hub.held(params.id) });
			}
			case "newChat": {
				await readJson(req);
				return result(res, await actions.newChat(device.id));
			}
			case "prompt": {
				knownChat(params.id);
				const body = await readJson(req);
				const text = typeof body.text === "string" ? body.text : "";
				const mode = body.mode === undefined ? "auto" : body.mode;
				if (!text.trim()) throw new HttpError(400, "Message is empty");
				if (Buffer.byteLength(text) > MAX_PROMPT) throw new HttpError(400, "Message is too long");
				if (!MODES.has(mode)) throw new HttpError(400, "Unknown mode");
				return result(res, await actions.prompt(params.id, text, mode, device.id));
			}
			case "abort":
				knownChat(params.id);
				await readJson(req);
				return result(res, await actions.abort(params.id, device.id));
			case "heldTake": {
				knownChat(params.id);
				const body = await readJson(req);
				if (!Number.isInteger(body.index) || body.index < 0 || typeof body.text !== "string") throw new HttpError(400, "Send index and text");
				return result(res, await actions.heldTake(params.id, body.index, body.text, device.id));
			}
			case "ui": {
				knownChat(params.id);
				const body = await readJson(req);
				const kinds = [typeof body.value === "string", typeof body.confirmed === "boolean", body.cancelled === true].filter(Boolean).length;
				if (kinds !== 1 || Object.keys(body).length !== 1) throw new HttpError(400, "Send exactly one of value, confirmed or cancelled");
				const resp = "value" in body ? { value: body.value } : "confirmed" in body ? { confirmed: body.confirmed } : { cancelled: true };
				const ok = await actions.answerUi(params.id, params.reqId, resp, device.id);
				if (ok && ok.error) return fail(res, ok.status || 404, ok.error);
				if (!ok) throw new HttpError(409, "Already answered");
				return sendJson(res, 200, {});
			}
			case "restart":
				knownChat(params.id);
				await readJson(req);
				if (hub.summary(params.id).status !== "stopped") throw new HttpError(409, "Pi is still running in this chat");
				return result(res, await actions.restart(params.id, device.id), {});
			case "settings": {
				knownChat(params.id);
				if (hub.summary(params.id).status === "stopped") throw new HttpError(409, "Pi is not running in this chat");
				return result(res, await actions.getSettings(params.id, device.id));
			}
			case "setSettings": {
				knownChat(params.id);
				const body = await readJson(req);
				if (hub.summary(params.id).status === "stopped") throw new HttpError(409, "Pi is not running in this chat");
				const keys = Object.keys(body);
				if (keys.length !== 1) throw new HttpError(400, "Send exactly one of model, thinkingLevel or mode");
				let change;
				if ("model" in body) {
					const m = body.model;
					if (!isObj(m) || typeof m.provider !== "string" || typeof m.id !== "string" || !m.provider || !m.id || m.provider.length > 200 || m.id.length > 200) throw new HttpError(400, "Invalid model");
					change = { model: { provider: m.provider, id: m.id } };
				} else if ("thinkingLevel" in body) {
					if (typeof body.thinkingLevel !== "string" || !/^[a-z]{1,20}$/.test(body.thinkingLevel)) throw new HttpError(400, "Invalid thinking level");
					change = { thinkingLevel: body.thinkingLevel };
				} else if ("mode" in body) {
					if (!PERMISSION_MODES.has(body.mode)) throw new HttpError(400, "Unknown permission mode");
					change = { mode: body.mode };
				} else throw new HttpError(400, "Send exactly one of model, thinkingLevel or mode");
				return result(res, await actions.setSettings(params.id, change, device.id));
			}
			case "pushSubscribe": {
				const body = await readJson(req);
				const sub = body.subscription;
				if (!isObj(sub) || typeof sub.endpoint !== "string" || !isObj(sub.keys) || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") throw new HttpError(400, "Invalid subscription");
				if (!isValidSubscriptionKeys(sub.keys.p256dh, sub.keys.auth)) throw new HttpError(400, "Invalid subscription keys");
				return result(res, await actions.subscribePush(device.id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }), {});
			}
			case "pushUnsubscribe":
				await readJson(req);
				return result(res, await actions.unsubscribePush(device.id), {});
		}
		throw new HttpError(404, "Not found");
	}

	async function handle(req, res) {
		const url = new URL(req.url, "http://x");
		if (!checkHost(req.headers.host, hostsAllowed())) return fail(res, 421, "Unknown host");
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

		const pathname = url.pathname;
		if (req.method === "GET") {
			const entry = resolveStatic(pathname);
			if (entry) return serveStatic(res, entry);
		}
		if (!pathname.startsWith("/api/")) return fail(res, 404, "Not found");
		res.setHeader("Cache-Control", "no-store");

		const route = matchRoute(req.method, pathname);
		if (!route) return fail(res, 404, "Not found");
		if (req.method === "POST") {
			if (!checkOrigin(req.headers.origin, originsAllowed())) return fail(res, 403, "Origin not allowed");
			if (req.headers["x-crust-remote"] !== "1") return fail(res, 403, "Missing header");
			if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return fail(res, 403, "Expected JSON");
		}
		await api(req, res, route, url);
	}

	const server = http.createServer((req, res) => {
		handle(req, res).catch((e) => {
			if (e instanceof HttpError) return fail(res, e.status, e.message);
			if (e && typeof e.status === "number" && typeof e.error === "string") {
				// readJson. Too large: the rest of the body is still on its way, so answer and drop the connection.
				if (e.status === 413) {
					res.setHeader("Connection", "close");
					res.once("finish", () => req.destroy());
				}
				return fail(res, e.status, e.error);
			}
			log("error", { message: String(e?.message || e).slice(0, 200) });
			fail(res, 500, "Internal error");
		});
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 5_000;

	return {
		listen: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					server.on("error", (e) => log("server-error", { message: e.message }));
					resolve({ port: server.address().port });
				});
			}),
		close: () =>
			new Promise((resolve) => {
				for (const s of [...streams]) s.res.destroy();
				server.close(() => resolve());
				server.closeAllConnections?.();
			}),
		broadcast,
		closeDevice,
		connectedDevices,
	};
}

module.exports = { createRemoteServer };
