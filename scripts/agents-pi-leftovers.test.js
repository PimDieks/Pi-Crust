"use strict";
// Step S8: what left main.js for the Pi adapter (the check-in setting, the advisor pointer, the MCP config path).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../src/agents/pi/process");
const pi = require("../src/agents/pi");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
const strip = (t) => t.replace(/\/\/.*$/gm, "");

test("toolCheckIn: the setting, default 40, 0 = off, junk falls back (same rules as the old main.js function)", () => {
	assert.strictEqual(P.toolCheckIn({}), 40);
	assert.strictEqual(P.toolCheckIn(undefined), 40);
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: 7 }), 7);
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: "12" }), 12);
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: 0 }), 0);
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: null }), 0); // Number(null) is 0, as before
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: 3.9 }), 3);
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: -1 }), 40);
	assert.strictEqual(P.toolCheckIn({ toolCallCheckIn: "x" }), 40);
});

test("the advisor pointer is byte-identical to what the code wrote before the move (hash of the file with its target masked)", () => {
	const { ensurePointer } = require("../src/advisor-main");
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adv-"));
	const target = path.join(d, "advisor.ts");
	fs.writeFileSync(target, "//");
	assert.strictEqual(ensurePointer({ target, dir: path.join(d, "agent") }), "written");
	const text = fs.readFileSync(path.join(d, "agent", "extensions", "advisor.ts"), "utf8").split(JSON.stringify(target)).join("<TARGET>");
	// Taken on origin/main 10dd661, before phase 6 touched anything.
	assert.strictEqual(crypto.createHash("sha256").update(text).digest("hex"), "c18ce7d4af7e7c54a9ddb3fe9fe8ecd45b7fb64b4ae894b9d5d0ff6a8d037271");
});

test("the adapter's app start is the advisor registration, and it stays off in a selftest", () => {
	assert.strictEqual(typeof pi.onAppStart, "function");
	const adv = src("advisor-main.js");
	assert.ok(adv.includes('process.env.PI_CRUST_SELFTEST === "1"')); // the guard exists exactly once
	assert.strictEqual(adv.split('PI_CRUST_SELFTEST === "1"').length, 2);
});

test("the Figma bridge asks the agent for its MCP file", () => {
	const B = require("../src/figma-bridge-main");
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-"));
	const file = path.join(d, "mcp.json");
	B.register({ agents: { get: () => ({ mcpConfigPath: () => file }) }, ipcMain: { handle() {} }, app: { on() {} }, readSettings: () => ({}) });
	assert.match(B.loadConfig({}).error, /No figma-console MCP server/); // no file yet
	fs.writeFileSync(file, JSON.stringify({ mcpServers: { "figma-console": { command: "x", args: ["a"] } } }));
	assert.deepStrictEqual(B.loadConfig({}), { command: "x", args: ["a"], env: undefined, from: file });
});

test("main.js and the Figma bridge no longer know Pi's config folder, the check-in function or the advisor module", () => {
	const main = strip(src("main.js"));
	assert.ok(!/toolCheckIn/.test(main));
	assert.ok(!/advisor-main/.test(main));
	assert.ok(!/\.pi["']/.test(main));
	assert.ok(!/["']\.pi["']/.test(strip(src("figma-bridge-main.js"))));
});
