// Figma connection status: states, words and the mapping from a probe result (figma-mcp.js probe()) to a state.
// Pure, no Electron. Texts marked "assumed" are guesses about Figma's wording that real Figma must confirm (verify 2026-11-18).
"use strict";

const STATES = ["not_reachable", "no_file", "wrong_tab", "no_selection", "ready", "problem"];
// Hints only exist for not_reachable: not_installed, not_running, server_off, seat, unknown.
const HINTS = ["not_installed", "not_running", "server_off", "seat", "unknown"];

const PILL = {
	checking: "Figma: checking…",
	not_reachable: "Figma: not connected",
	no_file: "Figma: open a file",
	wrong_tab: "Figma: switch tab",
	no_selection: "Figma: select a frame",
	ready: "Figma: ready",
	problem: "Figma: problem",
};

const LINE = {
	checking: "Looking for Figma desktop.",
	not_reachable: "Pi Crust can't reach Figma desktop. Open it and switch on its MCP server.",
	no_file: "Figma is connected, but no design file is open.",
	wrong_tab: "The active Figma tab is not a design file. Switch to a design (or FigJam) file in Figma desktop.",
	no_selection: "Connected. Select a frame in Figma desktop, then choose Test connection.",
	ready: "Connected. Selected frame: <name>.",
	problem: "",
};

const HINT_LINE = {
	not_installed: "Figma desktop doesn't seem to be installed.",
	not_running: "Figma desktop isn't running.",
	server_off: "Figma is running, but its MCP server is off.",
	// Assumed: HTTP 401/403 from the port means a seat or plan refusal.
	seat: "Figma answered, but refused the connection. Ask the Figma admin for a Dev or Full seat.",
	unknown: LINE.not_reachable,
};

const pillText = (state) => PILL[state] || PILL.problem;

// Panel line under the title. extra: { name } for ready (frame name), { message } for problem (raw text).
function textFor(state, hint, extra = {}) {
	if (state === "not_reachable") return HINT_LINE[hint] || LINE.not_reachable;
	if (state === "ready") return LINE.ready.replace("<name>", extra.name || "(unnamed)");
	if (state === "problem") return extra.message || "Something went wrong talking to Figma.";
	return LINE[state] || LINE.problem;
}

// Merged figmaError for the toasts of the picker (noun "layer") and Compare/Tokens (noun "frame").
function figmaError(e, { noun = "layer" } = {}) {
	const msg = String((e && e.message) || e);
	const code = e && ((e.cause && e.cause.code) || e.code);
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || /fetch failed|timed out|ECONNREFUSED/i.test(msg))
		return "Figma desktop isn't reachable. Open Figma desktop and enable the desktop MCP server: Dev Mode → Inspect.";
	if (/only available if your active tab/i.test(msg)) return "The active Figma tab is not a design file. Switch to a design (or FigJam) file in Figma desktop.";
	if (/nothing is selected/i.test(msg)) return `Nothing is selected in Figma. Select a ${noun} in Figma desktop first.`;
	return msg;
}

const isRefused = (r) => r.errorCode === "ECONNREFUSED" || r.errorCode === "ECONNRESET" || r.errorCode === "UND_ERR_CONNECT_TIMEOUT" || /fetch failed|timed out|ECONNREFUSED/i.test(r.errorMessage || "");

// Probe result (see figma-mcp.js probe) plus optional process facts { running: bool|null, installed: bool|null } -> { state, hint, message }.
function classify(r, proc = {}) {
	if (!r) return { state: "problem", hint: null, message: "No result from the Figma check." };
	if (r.stage === "connect" || (!r.reachable && isRefused(r))) {
		let hint = "unknown";
		if (proc.running === true) hint = "server_off";
		else if (proc.running === false) hint = proc.installed === false ? "not_installed" : proc.installed === true ? "not_running" : "not_running";
		return { state: "not_reachable", hint, message: textFor("not_reachable", hint) };
	}
	if (r.status === 401 || r.status === 403) return { state: "not_reachable", hint: "seat", message: textFor("not_reachable", "seat") };
	if (r.stage === "not_mcp") return { state: "problem", hint: null, message: "Something else answers on the Figma MCP port. Close it, or set PI_CRUST_FIGMA_MCP_URL." };
	if (r.stage === "initialize") return { state: "problem", hint: null, message: r.errorMessage || "Figma did not accept the connection." };
	if (r.stage === "tools" && r.tools && !r.tools.includes("get_design_context")) return { state: "problem", hint: null, message: "Figma answered, but without design tools." };
	if (r.stage === "tools") return { state: "problem", hint: null, message: r.errorMessage || "Figma did not list its tools." };
	const c = r.call;
	if (!c) return { state: "problem", hint: null, message: r.errorMessage || "Figma did not answer the check." };
	if (c.ok) return { state: "ready", hint: null, message: textFor("ready", null, { name: frameName(c.text) }), name: frameName(c.text) };
	const t = c.error || "";
	if (/only available if your active tab/i.test(t)) return { state: "wrong_tab", hint: null, message: textFor("wrong_tab") };
	if (/nothing is selected/i.test(t)) return { state: "no_selection", hint: null, message: textFor("no_selection") };
	// Assumed: with no file open the tool error mentions a file/document/page. Real text unknown.
	if (/\b(file|document)\b/i.test(t)) return { state: "no_file", hint: null, message: textFor("no_file") };
	return { state: "problem", hint: null, message: t || "Figma returned an error." };
}

// First name="..." in get_metadata XML, if any.
function frameName(xml) {
	const m = /<[a-z][\w-]*\s[^>]*\bname="([^"]*)"/i.exec(String(xml || ""));
	return m ? m[1] : "";
}

// What the probe checked, for Test connection: [{ label, ok }] (ok: true | false | null for not reached).
function checks(r) {
	const server = !!(r && r.initialized);
	const tools = !!(r && r.tools && r.tools.includes("get_design_context"));
	const sel = !!(r && r.call && r.call.ok);
	return [
		{ label: "server answers", ok: server },
		{ label: "design tools found", ok: server ? tools : null },
		{ label: "selection read", ok: tools ? sel : null },
	];
}

// Process / install facts. exec and fs are injectable for tests. Returns { running, installed } (null = unknown).
function checkFigmaProcess({ platform = process.platform, execFile = require("node:child_process").execFile, fs = require("node:fs"), env = process.env } = {}) {
	return new Promise((resolve) => {
		const out = { running: null, installed: null };
		try {
			if (platform === "win32") out.installed = fs.existsSync(require("node:path").join(env.LOCALAPPDATA || "", "Figma"));
			else if (platform === "darwin") out.installed = fs.existsSync("/Applications/Figma.app");
		} catch {}
		const done = (running) => resolve({ ...out, running });
		try {
			if (platform === "win32") {
				// Process name Figma.exe: assumed, verify.
				execFile("tasklist", ["/FI", "IMAGENAME eq Figma.exe", "/FO", "CSV", "/NH"], { timeout: 3000, windowsHide: true }, (err, stdout) => done(err ? null : /"Figma\.exe"/i.test(String(stdout))));
			} else if (platform === "darwin") {
				execFile("pgrep", ["-x", "Figma"], { timeout: 3000 }, (err, stdout) => done(err && err.code === 1 ? false : err ? null : String(stdout).trim().length > 0));
			} else done(null);
		} catch {
			done(null);
		}
	});
}

module.exports = { STATES, HINTS, PILL, pillText, textFor, figmaError, classify, checks, checkFigmaProcess, frameName };
