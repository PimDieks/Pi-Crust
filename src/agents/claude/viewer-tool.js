// The Claude Agent's tool `show_in_viewer` (spec: Viewer tabs and project files, task 13), defined by the app and run in the app's own process:
// the SDK's supported way for a host-defined tool is an in-process MCP server (createSdkMcpServer with tool(), sdk.d.ts). This server holds
// exactly this one tool and nothing else, so no other host tool comes with it. The engine names it mcp__pi-crust__show_in_viewer, and that
// exact name is the one entry of the permission table (permissions.js TOOL_TABLE) that maps to the shared show_in_viewer rule: it goes through
// the PreToolUse hook and canUseTool like every other tool, and it never asks (what reading the file needs in the chat's mode, or a refusal).
// The handler judges the call once more in the chat's current mode, then hands the text to the app (viewer-agent-main.js), which decides what
// may be shown. A refusal is returned as an error result with its reason, so the model reads it.
"use strict";

const logic = require("../../permission-logic");
const { judge } = require("./permissions");
const { DESCRIPTION } = require("../../pi-viewer-tool");

const SERVER = "pi-crust";
const TOOL = "show_in_viewer";
const FULL_NAME = `mcp__${SERVER}__${TOOL}`;
const REFUSED = "The permission check failed, so nothing was shown.";

const result = (text, isError) => ({ content: [{ type: "text", text: String(text) }], ...(isError ? { isError: true } : {}) });

// sdk: the loaded SDK module. zod: the zod module (the SDK's schema language). show(chatId, target) -> { ok, text }.
// getMode(), getCwd(): this chat's current mode and project folder. Returns the server config for options.mcpServers, or null when the SDK
// (or zod) cannot build one: then the chat simply has no such tool.
function build({ sdk, zod, show, chatId, getMode, getCwd }) {
	if (!sdk || typeof sdk.createSdkMcpServer !== "function" || typeof sdk.tool !== "function" || !zod || !zod.z || typeof show !== "function") return null;
	const z = zod.z;
	const handler = async (args) => {
		try {
			const target = args && typeof args.target === "string" ? args.target : "";
			const j = judge({ mode: getMode(), toolName: FULL_NAME, input: { target }, grants: logic.createGrants(), cwd: getCwd() });
			if (!j || j.d.action !== "allow") return result(j && j.d && j.d.reason ? j.d.reason : REFUSED, true);
			const r = await show(chatId, target);
			return result(r && r.text ? r.text : REFUSED, !(r && r.ok));
		} catch {
			return result(REFUSED, true);
		}
	};
	const def = sdk.tool(TOOL, DESCRIPTION, { target: z.string().max(2000).describe("A project file path, or a localhost address.") }, handler);
	return sdk.createSdkMcpServer({ name: SERVER, version: "1.0.0", tools: [def] });
}

module.exports = { SERVER, TOOL, FULL_NAME, build };
