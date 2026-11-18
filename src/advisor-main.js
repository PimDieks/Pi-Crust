// The advisor extension (pi-extension/advisor.ts) for every Pi on this machine, not only Pi Crust's chats.
// Chats load it with -e, but subagents and terminal Pi are plain `pi` processes that only read
// <agent dir>/extensions. At startup this writes a small pointer file there that imports this app's copy.
// - Written only when the file is missing or still carries MARKER (remove the marker line to keep your own file).
// - The pointer does nothing when the target is gone (app moved or uninstalled), so Pi never fails to start.
// - advisor.ts guards against loading twice in one process, so chats that get it both ways register it once.
const fs = require("node:fs");
const path = require("node:path");
const { agentDir } = require("./subscriptions-main");

const MARKER = "pi-crust:advisor-pointer";

function pointerSource(target) {
	return [
		`// ${MARKER} (written by Pi Crust; remove this line to stop Pi Crust from updating this file)`,
		"// Loads Pi Crust's advisor extension in terminal Pi and subagents. Config: ~/.pi/agent/advisor.json",
		'import * as fs from "node:fs";',
		'import { pathToFileURL } from "node:url";',
		`const TARGET = ${JSON.stringify(target)};`,
		"export default async function (pi: any) {",
		"	if (!fs.existsSync(TARGET)) return; // Pi Crust moved or removed",
		"	const mod = await import(pathToFileURL(TARGET).href);",
		"	return mod.default(pi);",
		"}",
		"",
	].join("\n");
}

// Returns "written", "unchanged", "kept" (a file without the marker) or "missing-target".
function ensurePointer({ target, dir = agentDir() }) {
	if (!fs.existsSync(target)) return "missing-target";
	const file = path.join(dir, "extensions", "advisor.ts");
	const want = pointerSource(target);
	let have = null;
	try {
		have = fs.readFileSync(file, "utf8");
	} catch {}
	if (have === want) return "unchanged";
	if (have !== null && !have.includes(MARKER)) return "kept";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, want);
	return "written";
}

// The log line names the folder the pointer really goes to (PI_CODING_AGENT_DIR may move it away from ~/.pi/agent).
function pointerMessage(result, dir = agentDir()) {
	return `[advisor] pointer in ${path.join(dir, "extensions")}: ${result}`;
}

function register() {
	if (!require("electron").app.isPackaged && process.env.PI_CRUST_SELFTEST === "1") return; // a test run must not repoint the user's Pi at a test checkout
	try {
		const result = ensurePointer({ target: path.join(__dirname, "pi-extension", "advisor.ts") });
		if (result !== "unchanged") console.log(pointerMessage(result));
	} catch (err) {
		console.warn(`[advisor] could not write the pointer: ${err.message}`);
	}
}

module.exports = { pointerMessage, register, ensurePointer, pointerSource, MARKER };
