#!/usr/bin/env node
// Stub of the Figma desktop MCP server, for testing the Figma status without real Figma.
// Usage: node scripts/figma-stub-server.js <mode> [port]   (default port 3845; then set PI_CRUST_FIGMA_MCP_URL=http://127.0.0.1:<port>/mcp)
// Modes: closed (listens on nothing), no-file, wrong-tab, no-selection, ready, no-tools, http-403, not-mcp.
// The no-file error text is invented (real Figma's text is unknown); the others copy what the app already matches.
"use strict";
const http = require("node:http");

const MODES = ["closed", "no-file", "wrong-tab", "no-selection", "ready", "no-tools", "http-403", "not-mcp"];
const TOOLS = ["get_design_context", "get_variable_defs", "get_metadata", "get_screenshot"];
const TOOL_ERROR = {
	"no-file": "No file is open in Figma. Open a design file first.",
	"wrong-tab": "This tool is only available if your active tab is a design file.",
	"no-selection": "Nothing is selected. Select a layer first.",
};

function handle(mode, body, res) {
	const reply = (obj, headers = {}) => {
		res.writeHead(200, { "Content-Type": "application/json", ...headers });
		res.end(JSON.stringify(obj));
	};
	const { id, method, params } = body || {};
	if (method === "initialize") return reply({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "figma-stub", version: "0" } } }, { "mcp-session-id": "stub-session" });
	if (method && method.startsWith("notifications/")) {
		res.writeHead(202);
		return res.end();
	}
	if (method === "tools/list") return reply({ jsonrpc: "2.0", id, result: { tools: (mode === "no-tools" ? ["other_tool"] : TOOLS).map((name) => ({ name })) } });
	if (method === "tools/call") {
		if (TOOL_ERROR[mode]) return reply({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: TOOL_ERROR[mode] }] } });
		const name = params && params.name;
		const text = name === "get_metadata" ? '<frame id="1:2" name="Stub Card" x="0" y="0" width="390" height="844" />' : name === "get_variable_defs" ? '{"color/bg":"#ffffff"}' : '<div data-node-id="1:2" data-name="Stub Card" className="bg-[var(--color/bg,#ffffff)]">stub</div>';
		return reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
	}
	return reply({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

// Starts the stub. Resolves { port, close() }. Mode "closed" listens on nothing.
// opts.delayMs delays every answer (to show the "checking" state).
function start(mode, port = 0, opts = {}) {
	if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
	if (mode === "closed") return Promise.resolve({ port: null, close: () => Promise.resolve() });
	const server = http.createServer((req, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => setTimeout(() => {
			if (mode === "http-403") {
				res.writeHead(403, { "Content-Type": "text/plain" });
				return res.end("Forbidden");
			}
			if (mode === "not-mcp") {
				res.writeHead(200, { "Content-Type": "text/html" });
				return res.end("<html>hello, not MCP</html>");
			}
			let body = null;
			try {
				body = JSON.parse(data);
			} catch {}
			handle(mode, body, res);
		}, opts.delayMs || 0));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () =>
			resolve({
				port: server.address().port,
				close: () =>
					new Promise((r) => {
						if (server.closeAllConnections) server.closeAllConnections();
						server.close(() => r());
					}),
			}),
		);
	});
}

module.exports = { start, MODES };

if (require.main === module) {
	const mode = process.argv[2];
	if (!MODES.includes(mode)) {
		console.error(`usage: node figma-stub-server.js <${MODES.join("|")}> [port]`);
		process.exit(2);
	}
	start(mode, Number(process.argv[3]) || 3845).then((s) => {
		if (!s.port) return console.log("closed: nothing is listening");
		console.log(`figma stub (${mode}) on http://127.0.0.1:${s.port}/mcp, Ctrl+C to stop`);
	});
}
