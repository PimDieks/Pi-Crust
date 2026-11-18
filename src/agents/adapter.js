// The agent adapter contract (phase 6). An agent is something the app can locate, start, send to and stop.
// This file only describes it: nothing requires it until the extraction steps move code behind it.
//
// Design (option A, a thin transport): the adapter owns the process, the framing, readiness and translation, and speaks the
// record shapes the app already consumes. Those are Pi's shapes, listed below as the contract. The Pi adapter passes them
// through; a second agent translates into them and answers a request it cannot serve with { success:false, unsupported:true }.
// A capability list lets the UI hide what an agent cannot do (nothing reads it yet).
//
// Adapter {
//   id, label,                          "pi", "Pi"
//   capabilities,                       see CAPABILITY_KEYS; use capabilities({...}) to build one
//   strings,                            main-side error texts only: { notRunning, stopped, noAnswer, refused, ... }
//   locate(): { installed, command, args, binDir, version? } | null
//   pathExtras(): string[]              folders to add to PATH for every child
//   start(opts, sink): Handle           opts = { cwd, sessionRef?, env, settings }
//   send(handle, record): boolean       one JSON record in; false when not writable
//   stop(handle): void                  orderly, then tree kill
//   listSessions({ cwd }): SessionInfo[]   { path, name, firstPrompt, mtime, size }; path is an opaque string
//   auth: { status(provider?), login(...), logout(...) } | null
//   mcpConfigPath(): string | null
//   onAppStart(ctx): void
// }
// Sink { ready(data), record(record), stderr(text), exit({ code, signal, error }) }  (called synchronously, in order)
// Handle is opaque to core except `pid`. A sessionRef is a plain string and never a path core opens.
//
// The record contract below is what the renderer (handleRecord, handleUiRequest), the phone (remote-state.js) and history
// (sessions.js, duration.js) read. Shapes are as Pi emits them today; see those files for the fields.
"use strict";

// Requests the app sends: `{ id, type, ...fields }`, answered by `{ type:"response", id, command, success, data|error }`.
// (The phase 6 plan counts 20; these are the 19 distinct type strings found in the code.)
const REQUEST_TYPES = Object.freeze([
	"get_state",
	"get_messages",
	"prompt", // fields: message, images, streamingBehavior ("steer" | "followUp")
	"abort",
	"clear_queue",
	"get_available_models",
	"set_model",
	"get_available_thinking_levels",
	"set_thinking_level",
	"get_commands",
	"compact",
	"set_session_name",
	"get_session_stats",
	"get_last_assistant_text",
	"export_html",
	"get_fork_messages",
	"fork",
	"clone",
	"extension_ui_response", // one answer per request id; no response record
]);

// Records the app receives (17 types).
const RECORD_TYPES = Object.freeze([
	"response",
	"agent_start",
	"agent_end",
	"agent_settled",
	"queue_update",
	"message_start",
	"message_update", // assistantMessageEvent.type: text_delta, thinking_delta, text_end, thinking_end, toolcall_start, toolcall_end
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_retry_start",
	"compaction_start",
	"compaction_end",
	"session_info_changed",
	"extension_error",
	"extension_ui_request",
]);

// extension_ui_request `method` values (9). select, confirm, input and editor are dialogs, answered with extension_ui_response.
const UI_METHODS = Object.freeze(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "select", "confirm", "input", "editor"]);
const UI_DIALOG_METHODS = Object.freeze(["select", "confirm", "input", "editor"]);

// Stored message roles in history: user, assistant (text, thinking, toolCall blocks), toolResult, custom, compactionSummary.
const MESSAGE_ROLES = Object.freeze(["user", "assistant", "toolResult", "custom", "compactionSummary"]);

// Every flag is true for Pi in phase 6. permissionModes is a list [{ id, label }] (or null), not a flag.
const PI_PERMISSION_MODES = Object.freeze([
	{ id: "plan", label: "Plan (read-only)" },
	{ id: "ask-edits", label: "Ask before edits" },
	{ id: "ask-commands", label: "Ask before commands" },
	{ id: "trusted", label: "Trusted" },
]);
const CAPABILITY_FLAGS = Object.freeze([
	"steering", // Alt+Enter steer
	"followUpQueue", // queue strip, clear_queue, held messages
	"thinkingLevels",
	"modelSwitch",
	"slashCommands",
	"extensions", // statuses and widgets from agent extensions
	"contextBreakdown",
	"checkpoints", // generic (git), always true
	"conversationRewind", // needs fork
	"fork",
	"clone",
	"exportHtml",
	"compact",
	"sessionStats",
	"sessionName",
	"sessionResume",
	"subagentCards",
	"advisor",
	"costMeter",
	"images",
	"mcpConfig",
	"auth",
]);
const CAPABILITY_KEYS = Object.freeze([...CAPABILITY_FLAGS, "permissionModes", "readyOnSpawn"]);

// Pi's capabilities. readyOnSpawn is false for Pi: it is probed until it answers.
function allOn() {
	return { ...Object.fromEntries(CAPABILITY_FLAGS.map((k) => [k, true])), permissionModes: PI_PERMISSION_MODES.map((m) => ({ ...m })), readyOnSpawn: false };
}
// allOn() with overrides; an unknown key is a mistake.
function capabilities(overrides = {}) {
	const bad = Object.keys(overrides).filter((k) => !CAPABILITY_KEYS.includes(k));
	if (bad.length) throw new Error(`unknown capability: ${bad.join(", ")}`);
	return { ...allOn(), ...overrides };
}

const REQUIRED_FUNCTIONS = Object.freeze(["locate", "pathExtras", "start", "send", "stop", "listSessions", "mcpConfigPath", "onAppStart"]);

// Throws a descriptive Error when `a` does not satisfy the contract; returns `a` otherwise.
function assertAdapter(a) {
	const fail = (why) => {
		throw new Error(`invalid agent adapter${a && a.id ? ` "${a.id}"` : ""}: ${why}`);
	};
	if (!a || typeof a !== "object") fail("not an object");
	if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id)) fail("id must be a lowercase string");
	if (typeof a.label !== "string" || !a.label) fail("label must be a non-empty string");
	for (const f of REQUIRED_FUNCTIONS) if (typeof a[f] !== "function") fail(`missing function ${f}`);
	if (!a.capabilities || typeof a.capabilities !== "object") fail("missing capabilities");
	for (const k of CAPABILITY_KEYS) if (!(k in a.capabilities)) fail(`capabilities.${k} is missing`);
	for (const k of Object.keys(a.capabilities)) if (!CAPABILITY_KEYS.includes(k)) fail(`unknown capability ${k}`);
	for (const k of CAPABILITY_FLAGS) if (typeof a.capabilities[k] !== "boolean") fail(`capabilities.${k} must be a boolean`);
	if (typeof a.capabilities.readyOnSpawn !== "boolean") fail("capabilities.readyOnSpawn must be a boolean");
	const pm = a.capabilities.permissionModes;
	if (pm !== null && !(Array.isArray(pm) && pm.every((m) => m && typeof m.id === "string" && typeof m.label === "string"))) fail("capabilities.permissionModes must be null or [{ id, label }]");
	if (!a.strings || typeof a.strings !== "object") fail("missing strings");
	if (a.auth !== null && !(a.auth && ["status", "login", "logout"].every((f) => typeof a.auth[f] === "function"))) fail("auth must be null or { status, login, logout }");
	return a;
}

module.exports = { REQUEST_TYPES, RECORD_TYPES, UI_METHODS, UI_DIALOG_METHODS, MESSAGE_ROLES, PI_PERMISSION_MODES, CAPABILITY_FLAGS, CAPABILITY_KEYS, REQUIRED_FUNCTIONS, allOn, capabilities, assertAdapter };
