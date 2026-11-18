// The Pi adapter (phase 6): everything the app knows about Pi sits behind this object. Pi's record shapes are the contract
// (see ../adapter.js), so this adapter passes them through unchanged.
"use strict";

const os = require("node:os");
const path = require("node:path");
const A = require("../adapter");
const locate = require("./locate");
const proc = require("./process");
const sessions = require("./sessions");

module.exports = A.assertAdapter({
	id: "pi",
	label: "Pi",
	capabilities: A.capabilities(),
	// The main-side texts, as they were written inline before the move.
	strings: {
		notInstalled: "Pi is not installed",
		notRunning: "Pi is not running",
		stopped: "Pi stopped",
		noAnswer: "Pi did not answer in time",
		refused: "Pi refused the request",
	},
	locate: locate.locate,
	pathExtras: locate.pathExtras,
	start: proc.start,
	canSend: proc.canSend,
	send: proc.send,
	stop: proc.stop,
	listSessions: sessions.listSessions,
	// Pi's sign-in runs through the IPC handlers of subscriptions-main.js (register(ctx)); a facade of plain functions is for
	// the second agent's phase, nothing needs it now.
	auth: null,
	// Where Pi's MCP servers are configured (the Figma bridge reads it). As it was: the home folder, not PI_CODING_AGENT_DIR.
	mcpConfigPath: () => path.join(os.homedir(), ".pi", "agent", "mcp.json"),
	// Registers what Pi needs at app start (the advisor pointer in Pi's extensions folder).
	onAppStart: (ctx) => require("../../advisor-main").register(ctx),
});
