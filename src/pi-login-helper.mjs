// Runs Pi's own login for one provider, so auth.json is written exactly as `/login` does (Pi's ModelRuntime.login:
// credential format + file lock). Spawned by subscriptions-main.js with the Node that Pi itself runs on.
//   node pi-login-helper.mjs <pi package root> <provider id> [logout]
// With `logout` it only calls ModelRuntime.logout (Pi's own credential removal + file lock) and prints done/error.
// JSONL on stdio (one JSON object per LF-terminated line). Credentials are never printed.
//   out: {type:"event", event:<AuthEvent>}          auth_url | device_code | info | progress
//        {type:"prompt", id, prompt:<AuthPrompt>}   text | secret | select | manual_code; answer with {type:"answer"}
//        {type:"cancel-prompt", id}                 the flow no longer needs that prompt (e.g. the callback won)
//        {type:"done", warning?} | {type:"error", message}
//   in:  {type:"answer", id, value} | {type:"cancel"}
// Pi API used: public export "." of @earendil-works/pi-coding-agent (ModelRuntime, SettingsManager, getAgentDir).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
// The last line is flushed (callback) before exiting, so the app never misses done/error. Returns a promise that never
// settles so the code after an `await end(...)` doesn't run while the exit is pending.
const end = (msg, code) => {
	process.stdout.write(`${JSON.stringify(msg)}\n`, () => process.exit(code));
	return new Promise(() => {});
};
const fail = (message) => end({ type: "error", message: String(message) }, 1);

const [root, providerId, mode] = process.argv.slice(2);
if (!root || !providerId) await fail("Usage: pi-login-helper <pi package root> <provider id>");

let pi;
try {
	pi = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
} catch (e) {
	await fail(`Couldn't load Pi from ${root}: ${e.message}`);
}

const controller = new AbortController();
const waiting = new Map(); // prompt id -> { resolve, reject }
let seq = 0;
const cancelled = () => new Error("Login cancelled");

function onLine(line) {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type === "cancel") {
		controller.abort();
		for (const w of waiting.values()) w.reject(cancelled());
		waiting.clear();
	} else if (msg.type === "answer" && waiting.has(msg.id)) {
		const w = waiting.get(msg.id);
		waiting.delete(msg.id);
		w.resolve(String(msg.value ?? ""));
	}
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.trim()) onLine(line);
	}
});
// The app went away: stop the flow.
process.stdin.on("end", () => controller.abort());

function prompt(p) {
	if (controller.signal.aborted || p.signal?.aborted) return Promise.reject(cancelled());
	const id = String(++seq);
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve, reject });
		const { signal, ...plain } = p;
		// A prompt the flow aborts itself (manual code raced against the callback server).
		signal?.addEventListener("abort", () => {
			if (waiting.delete(id)) {
				out({ type: "cancel-prompt", id });
				reject(cancelled());
			}
		}, { once: true });
		out({ type: "prompt", id, prompt: plain });
	});
}

try {
	const agentDir = pi.getAgentDir();
	const runtime = await pi.ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	if (mode === "logout") {
		await runtime.logout(providerId);
		await end({ type: "done" }, 0);
	}
	const provider = runtime.getProvider(providerId);
	if (!provider) await fail(`Unknown provider: ${providerId}`);
	// Subscriptions sign in with OAuth. Fall back to the API key flow only when that is all the provider has.
	const method = provider.auth.oauth ? "oauth" : provider.auth.apiKey?.login ? "api_key" : null;
	if (!method) await fail(`${provider.name} has no interactive login`);
	const settings = pi.SettingsManager.create(process.cwd(), agentDir);
	await runtime.login(
		providerId,
		method,
		{ signal: controller.signal, prompt, notify: (event) => out({ type: "event", event }) },
		{ getDeviceId: () => settings.getOrCreateDeviceId() },
	);
	await end({ type: "done" }, 0);
} catch (e) {
	// The credential was saved but Pi's local refresh failed: the sign-in itself worked.
	if (pi.CredentialSynchronizationError && e instanceof pi.CredentialSynchronizationError) await end({ type: "done", warning: e.message }, 0);
	await fail(controller.signal.aborted ? "Login cancelled" : e instanceof Error ? e.message : e);
}
