// Minimal MCP streamable-HTTP client for the Figma desktop MCP server (main process).
"use strict";

const URL_MCP = process.env.PI_CRUST_FIGMA_MCP_URL || "http://127.0.0.1:3845/mcp";
const TIMEOUT_MS = 15_000;
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let sessionId = null;
let nextId = 1;

// Body is JSON or SSE (`event: message` / `data: {...}`); return the JSON-RPC message with the given id.
function parseBody(text, id) {
	const msgs = [];
	const t = text.trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		try {
			const j = JSON.parse(t);
			msgs.push(...(Array.isArray(j) ? j : [j]));
		} catch {}
	} else {
		for (const ev of t.split(/\r?\n\r?\n/)) {
			const data = ev
				.split(/\r?\n/)
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).replace(/^ /, ""))
				.join("\n");
			if (!data) continue;
			try {
				msgs.push(JSON.parse(data));
			} catch {}
		}
	}
	return msgs.find((m) => m && m.id === id) || msgs[0] || null;
}

class SessionError extends Error {}

async function post(body, { withSession = true } = {}) {
	const headers = { ...HEADERS };
	if (withSession && sessionId) headers["mcp-session-id"] = sessionId;
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(URL_MCP, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
		const text = await res.text();
		if (!res.ok) {
			if (withSession && sessionId && (res.status === 400 || res.status === 404 || /session/i.test(text))) throw new SessionError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
			throw new Error(`Figma MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
		}
		return { res, text };
	} catch (e) {
		if (e && e.name === "AbortError") throw new Error("Figma MCP timed out");
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

async function initialize() {
	sessionId = null;
	const id = nextId++;
	const { res, text } = await post(
		{ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-crust", version: "0.1.0" } } },
		{ withSession: false },
	);
	const msg = parseBody(text, id);
	if (msg && msg.error) throw new Error(msg.error.message || "initialize failed");
	sessionId = res.headers.get("mcp-session-id");
	await post({ jsonrpc: "2.0", method: "notifications/initialized" });
}

async function rpc(method, params, retried = false) {
	if (!sessionId) await initialize();
	const id = nextId++;
	let out;
	try {
		out = await post({ jsonrpc: "2.0", id, method, params });
	} catch (e) {
		if (e instanceof SessionError && !retried) {
			sessionId = null;
			return rpc(method, params, true);
		}
		throw e;
	}
	const msg = parseBody(out.text, id);
	if (!msg) throw new Error("Empty response from Figma MCP");
	if (msg.error) {
		if (!retried && /session/i.test(msg.error.message || "")) {
			sessionId = null;
			return rpc(method, params, true);
		}
		throw new Error(msg.error.message || "Figma MCP error");
	}
	return msg.result;
}

// Returns the text of a tool result; throws with the tool's error text if isError.
async function callTool(name, args = {}) {
	const result = await rpc("tools/call", { name, arguments: args });
	const text = (result.content || [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	if (result.isError) throw new Error(text || "Figma tool error");
	return text;
}

// Like callTool, but returns the raw content parts (text and image parts), e.g. for get_screenshot.
async function callToolRaw(name, args = {}) {
	const result = await rpc("tools/call", { name, arguments: args });
	if (result.isError) {
		const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		throw new Error(text || "Figma tool error");
	}
	return result.content || [];
}

// Connection check for the status pill: its own fresh session (never the cached sessionId), tools/list, then one real call.
// Returns the raw facts, never throws: { stage, reachable, initialized, status, errorCode, errorMessage, tools, call }.
// stage = where it stopped: connect | initialize | not_mcp | tools | call (call = the tool answered, ok or not).
async function probe({ url = URL_MCP, timeoutMs = 5000 } = {}) {
	const out = { stage: "connect", reachable: false, initialized: false, status: null, errorCode: null, errorMessage: null, tools: null, call: null };
	let sid = null;
	let id = 1;
	const send = async (body) => {
		const headers = { ...HEADERS };
		if (sid) headers["mcp-session-id"] = sid;
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
			const text = await res.text();
			out.reachable = true;
			out.status = res.status;
			return { res, text };
		} catch (e) {
			if (e && e.name === "AbortError") throw Object.assign(new Error("Figma MCP timed out"), { code: "ETIMEDOUT" });
			throw e;
		} finally {
			clearTimeout(timer);
		}
	};
	const rpcCall = async (method, params) => {
		const myId = id++;
		const { res, text } = await send({ jsonrpc: "2.0", id: myId, method, params });
		return { res, text, msg: res.ok ? parseBody(text, myId) : null };
	};
	try {
		const init = await rpcCall("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-crust", version: "0.1.0" } });
		if (!init.res.ok) {
			out.stage = "initialize";
			out.errorMessage = `HTTP ${init.res.status}: ${init.text.slice(0, 200)}`;
			return out;
		}
		if (!init.msg || init.msg.jsonrpc !== "2.0") {
			out.stage = "not_mcp";
			out.errorMessage = init.text.slice(0, 200);
			return out;
		}
		if (init.msg.error) {
			out.stage = "initialize";
			out.errorMessage = init.msg.error.message || "initialize failed";
			return out;
		}
		out.initialized = true;
		sid = init.res.headers.get("mcp-session-id");
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		out.stage = "tools";
		const list = await rpcCall("tools/list", {});
		if (!list.msg || list.msg.error || !list.msg.result) {
			out.errorMessage = (list.msg && list.msg.error && list.msg.error.message) || (list.res.ok ? "Empty tool list answer" : `HTTP ${list.res.status}`);
			return out;
		}
		out.tools = (list.msg.result.tools || []).map((t) => t.name);
		if (!out.tools.includes("get_design_context")) return out;
		out.stage = "call";
		const call = await rpcCall("tools/call", { name: "get_metadata", arguments: {} });
		if (!call.msg || (!call.msg.result && !call.msg.error)) {
			out.call = { ok: false, error: call.res.ok ? "Empty response from Figma MCP" : `HTTP ${call.res.status}: ${call.text.slice(0, 200)}` };
		} else if (call.msg.error) {
			out.call = { ok: false, error: call.msg.error.message || "Figma MCP error" };
		} else {
			const r = call.msg.result;
			const t = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
			out.call = r.isError ? { ok: false, error: t || "Figma tool error" } : { ok: true, text: t };
		}
		return out;
	} catch (e) {
		out.errorCode = (e && ((e.cause && e.cause.code) || e.code)) || null;
		out.errorMessage = String((e && e.message) || e);
		return out;
	}
}

module.exports = { callTool, callToolRaw, probe, URL_MCP };
