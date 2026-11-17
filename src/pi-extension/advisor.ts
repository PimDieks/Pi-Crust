/**
 * Anthropic advisor tool (beta `advisor-tool-2026-03-01`) for Pi and Pi Crust.
 * Docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
 *
 * A faster executor model can consult a stronger advisor model mid-generation. Anthropic runs the
 * advisor server-side inside the same /v1/messages request, so there is nothing to execute locally.
 *
 * What this extension does (anthropic provider only):
 *  - Adds `{type: "advisor_20260301", name: "advisor", model}` to `tools` + the beta to `betas`,
 *    using the executor -> advisor pairing from ~/.pi/agent/advisor.json.
 *  - Pi's Anthropic client drops server_tool_use / advisor_tool_result blocks. We capture them from
 *    the raw stream, store them on the assistant message (`message.advisor`, persisted in the session)
 *    and re-insert them verbatim in later requests, anchored next to the block they followed.
 *  - Adds advisor sub-inference cost (usage.iterations[type=advisor_message]) to the message cost.
 *  - Auto-continues a turn that ended with stop_reason "pause_turn".
 *  - For non-Opus executors, adds Anthropic's suggested advisor-timing guidance to the system prompt.
 *
 * Pi Crust loads this file into each chat's Pi with `-e`. Terminal Pi and subagents get it from the pointer
 * ~/.pi/agent/extensions/advisor.ts that Pi Crust writes at startup (src/advisor-main.js), on Windows and macOS.
 * A process-wide guard keeps it from registering twice.
 * Config (personal, outside the repo): ~/.pi/agent/advisor.json
 * Command: /advisor [on|off|status|<advisor-model>|none]
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BETA = "advisor-tool-2026-03-01";
const TOOL_TYPE = "advisor_20260301";
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "advisor.json");
const MAX_AUTO_CONTINUES = 4;

type Config = {
	enabled: boolean;
	/** executor model id -> advisor model id (null = no advisor for that executor) */
	pairs: Record<string, string | null>;
	/** per-turn cap on advisor calls (server-enforced); null = unlimited */
	maxUsesPerTurn: number | null;
	/** cap on advisor output tokens per call (min 1024); null = model default */
	maxTokens: number | null;
	/** advisor-side prompt caching TTL; null = off. Worth it at >= 3 calls per conversation. */
	caching: "5m" | "1h" | null;
	/** add Anthropic's suggested timing guidance to the system prompt for non-Opus executors */
	steerPrompt: boolean;
};

const DEFAULT_CONFIG: Config = {
	enabled: true,
	pairs: {
		"claude-opus-5-5": null,
		"claude-sonnet-5-5": "claude-opus-5-5",
		"claude-haiku-5-5": "claude-opus-5-5",
	},
	maxUsesPerTurn: 3,
	maxTokens: null,
	caching: "5m",
	steerPrompt: true,
};

function loadConfig(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		return { ...DEFAULT_CONFIG, ...raw, pairs: { ...DEFAULT_CONFIG.pairs, ...(raw.pairs ?? {}) } };
	} catch {
		return DEFAULT_CONFIG;
	}
}

function saveConfig(cfg: Config) {
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/** Advisor model for an executor, or undefined when the advisor should not be offered. */
function advisorFor(cfg: Config, provider: string | undefined, executor: string | undefined) {
	if (!cfg.enabled || provider !== "anthropic" || !executor) return undefined;
	return cfg.pairs[executor] ?? undefined;
}

// ---------- block fingerprints (anchor advisor blocks to a neighbouring pi/payload block) ----------

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/**
 * Fingerprints a pi assistant content block can have once pi-ai serializes it for Anthropic.
 * Thinking blocks get two: signed (same model) and plain text (pi converts them when the model changes).
 */
function piFingerprints(b: any): string[] {
	if (b?.type === "text") return b.text?.trim() ? [hash("t:" + b.text)] : [];
	if (b?.type === "toolCall") return [hash("u:" + b.id)];
	if (b?.type === "thinking") {
		if (b.redacted) return [hash("r:" + b.thinkingSignature)];
		const fps: string[] = [];
		if (b.thinkingSignature?.trim()) fps.push(hash("s:" + b.thinkingSignature));
		if (b.thinking?.trim()) fps.push(hash("t:" + b.thinking));
		return fps;
	}
	return [];
}

function payloadFingerprint(b: any): string | undefined {
	if (b?.type === "text") return hash("t:" + b.text);
	if (b?.type === "tool_use") return hash("u:" + b.id);
	if (b?.type === "redacted_thinking") return hash("r:" + b.data);
	if (b?.type === "thinking") return b.signature?.trim() ? hash("s:" + b.signature) : hash("t:" + b.thinking);
	return undefined;
}

type Anchor = { fp: string; where: "after" | "before" };
/** `anchors`: candidates in priority order (nearest block before the call first, then blocks after it). */
type StoredPair = { anchors: Anchor[]; blocks: [any, any] };
type AdvisorMeta = {
	model?: string;
	/** fingerprints of every block in the message, used to find it again in the payload */
	fps: string[];
	pairs: StoredPair[];
	calls: number;
	errors: string[];
	advice: string[]; // plaintext advice (only for advisor models that return advisor_result)
	cost: number;
};

// ---------- extension ----------

const LOADED = Symbol.for("pi-crust.advisor-extension");

export default function (pi: ExtensionAPI) {
	// Loaded both via Pi Crust's `-e` and the global pointer: register only once per process.
	// Cleared on session_shutdown so /reload and session replacement register again.
	const g = globalThis as any;
	if (g[LOADED]) return;
	g[LOADED] = true;
	pi.on("session_shutdown", () => {
		g[LOADED] = false;
	});

	let cfg = loadConfig();

	// Raw-stream capture for the in-flight response.
	let piBlockCount = 0;
	let pendingUse = new Map<string, { block: any; after: number }>();
	let captured: { block: [any, any]; after: number }[] = [];
	let iterations: any[] = [];
	let requestAdvisor: string | undefined;

	// Built in `context`, consumed in `before_provider_request` for the same request.
	let replay: { fps: Set<string>; pairs: StoredPair[] }[] = [];
	let autoContinues = 0;
	let sessionCalls = 0;

	const resetCapture = () => {
		piBlockCount = 0;
		pendingUse = new Map();
		captured = [];
		iterations = [];
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const adv = advisorFor(cfg, ctx.model?.provider, ctx.model?.id);
		ctx.ui.setStatus(
			"advisor",
			adv ? `advisor: ${adv.replace(/^claude-/, "")}${sessionCalls ? ` (${sessionCalls})` : ""}` : undefined,
		);
	};

	pi.on("session_start", (_e, ctx) => {
		cfg = loadConfig();
		sessionCalls = 0;
		updateStatus(ctx);
	});
	pi.on("model_select", (_e, ctx) => updateStatus(ctx));

	// Steering prompt for executors that tend to under-call the advisor (Sonnet / Haiku).
	pi.on("before_agent_start", (event, ctx) => {
		cfg = loadConfig();
		autoContinues = 0;
		const sections = event.systemPromptOptions.sections;
		const adv = advisorFor(cfg, ctx.model?.provider, ctx.model?.id);
		if (adv && cfg.steerPrompt && !/opus|fable|mythos/.test(ctx.model?.id ?? "")) sections.advisor = STEER_PROMPT;
		else delete sections.advisor;
		updateStatus(ctx);
	});

	// Collect stored advisor blocks for the messages actually being sent.
	pi.on("context", (event) => {
		replay = [];
		for (const m of event.messages as any[]) {
			const meta: AdvisorMeta | undefined = m?.role === "assistant" ? m.advisor : undefined;
			if (!meta?.pairs?.length) continue;
			// Recompute from content, so older stored formats keep working.
			const fps = new Set<string>((m.content ?? []).flatMap(piFingerprints));
			const pairs = meta.pairs
				.map((p: any) => (p.anchors ? p : { anchors: [{ fp: p.anchor, where: p.where }], blocks: p.blocks }))
				.filter((p: StoredPair) => p.anchors?.length && p.blocks?.length === 2);
			if (pairs.length) replay.push({ fps, pairs });
		}
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as any;
		if (!payload || !Array.isArray(payload.messages) || ctx.model?.provider !== "anthropic") return undefined;
		if (ctx.model.api !== "anthropic-messages") return undefined;

		// 1) Re-insert advisor blocks from history.
		let reinserted = 0;
		let next = 0; // stored messages are matched in order, so a repeated text can't pull blocks into the wrong message
		for (const msg of payload.messages) {
			if (next >= replay.length) break;
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			const blockFps = msg.content.map(payloadFingerprint);
			const present = blockFps.filter((fp: string | undefined): fp is string => !!fp);
			if (present.length === 0) continue;
			// The payload message must consist of blocks of the stored message (pi may drop some, e.g. thinking).
			const j = replay.findIndex((r, i) => i >= next && present.every((fp: string) => r.fps.has(fp)));
			if (j < 0) continue;
			next = j + 1;
			const presentSet = new Set(present);
			const before = new Map<string, StoredPair[]>();
			const after = new Map<string, StoredPair[]>();
			for (const p of replay[j].pairs) {
				const a = p.anchors.find((c) => presentSet.has(c.fp));
				if (!a) continue; // anchor blocks all gone: drop the pair (harmless, the advice is just not replayed)
				const map = a.where === "before" ? before : after;
				map.set(a.fp, [...(map.get(a.fp) ?? []), p]);
			}
			const out: any[] = [];
			msg.content.forEach((b: any, i: number) => {
				const fp = blockFps[i];
				for (const p of (fp && before.get(fp)) || []) out.push(...p.blocks);
				out.push(b);
				for (const p of (fp && after.get(fp)) || []) out.push(...p.blocks);
				if (fp) (before.delete(fp), after.delete(fp)); // insert once even if a block repeats
			});
			reinserted += out.length - msg.content.length;
			msg.content = out;
		}

		// 2) Offer the advisor tool.
		requestAdvisor = advisorFor(cfg, ctx.model.provider, payload.model);
		if (requestAdvisor) {
			const tool: any = { type: TOOL_TYPE, name: "advisor", model: requestAdvisor };
			if (cfg.maxUsesPerTurn) tool.max_uses = cfg.maxUsesPerTurn;
			if (cfg.maxTokens) tool.max_tokens = Math.max(1024, cfg.maxTokens);
			if (cfg.caching) tool.caching = { type: "ephemeral", ttl: cfg.caching };
			payload.tools = [...(payload.tools ?? []).filter((t: any) => t?.type !== TOOL_TYPE), tool];
		}

		// History blocks also need the beta header, even with the tool removed.
		if (requestAdvisor || reinserted > 0) {
			payload.betas = [...new Set([...(payload.betas ?? []), BETA])];
		}
		if (process.env.PI_ADVISOR_DEBUG) {
			const summary = {
				model: payload.model,
				betas: payload.betas,
				advisorTool: payload.tools?.find((t: any) => t?.type === TOOL_TYPE),
				reinserted,
				messages: payload.messages.map((m: any) =>
					`${m.role}: ${Array.isArray(m.content) ? m.content.map((c: any) => c.type).join(",") : typeof m.content}`,
				),
			};
			fs.appendFileSync(process.env.PI_ADVISOR_DEBUG, JSON.stringify(summary) + "\n");
		}
		return payload;
	});

	// Capture advisor blocks from the raw Anthropic stream (pi-ai drops them during normalization).
	pi.on("provider_stream_event", (event) => {
		if (event.api !== "anthropic-messages") return;
		const d = event.data as any;
		if (!d || typeof d !== "object") return;
		if (d.type === "message_start") return resetCapture();
		if (d.type === "content_block_start") {
			const cb = d.content_block;
			if (!cb) return;
			if (["text", "thinking", "redacted_thinking", "tool_use"].includes(cb.type)) piBlockCount++;
			else if (cb.type === "server_tool_use" && cb.name === "advisor") {
				pendingUse.set(cb.id, { block: { type: "server_tool_use", id: cb.id, name: "advisor", input: {} }, after: piBlockCount });
			} else if (cb.type === "advisor_tool_result") {
				const use = pendingUse.get(cb.tool_use_id);
				if (use) {
					pendingUse.delete(cb.tool_use_id);
					captured.push({ block: [use.block, structuredClone(cb)], after: use.after });
				}
			}
			return;
		}
		if (d.type === "message_delta" && Array.isArray(d.usage?.iterations)) iterations = d.usage.iterations;
	});

	pi.on("message_end", (event, ctx) => {
		const msg = event.message as any;
		if (msg?.role !== "assistant" || msg.api !== "anthropic-messages") return undefined;
		const advisorIters = iterations.filter((it) => it?.type === "advisor_message");
		if (captured.length === 0 && advisorIters.length === 0) return resetCapture();

		const content: any[] = Array.isArray(msg.content) ? msg.content : [];
		const pairs: StoredPair[] = [];
		for (const c of captured) {
			// Candidates: blocks before the call (nearest first), then blocks after it (nearest first).
			// On replay the first candidate still present in the payload wins.
			const anchors: Anchor[] = [];
			for (let i = c.after - 1; i >= 0; i--)
				for (const fp of piFingerprints(content[i])) anchors.push({ fp, where: "after" });
			for (let i = c.after; i < content.length; i++)
				for (const fp of piFingerprints(content[i])) anchors.push({ fp, where: "before" });
			if (anchors.length) pairs.push({ anchors, blocks: c.block });
		}

		// Advisor sub-inference cost is billed at the advisor model's rates and is not in top-level usage.
		let cost = 0;
		for (const it of advisorIters) {
			const m = ctx.modelRegistry.find("anthropic", it.model)?.cost;
			if (!m) continue;
			cost +=
				((it.input_tokens ?? 0) * m.input +
					(it.output_tokens ?? 0) * m.output +
					(it.cache_read_input_tokens ?? 0) * m.cacheRead +
					(it.cache_creation_input_tokens ?? 0) * m.cacheWrite) /
				1e6;
		}

		const results = captured.map((c) => c.block[1]?.content);
		const meta: AdvisorMeta = {
			model: requestAdvisor,
			fps: content.flatMap(piFingerprints),
			pairs,
			calls: captured.length,
			errors: results.filter((r) => r?.type === "advisor_tool_result_error").map((r) => r.error_code),
			advice: results.filter((r) => r?.type === "advisor_result" && r.text).map((r) => r.text),
			cost,
		};
		resetCapture();

		sessionCalls += meta.calls;
		updateStatus(ctx);
		if (meta.errors.length) ctx.ui.notify(`Advisor error: ${meta.errors.join(", ")}`, "warning");

		const usage = msg.usage?.cost ? { ...msg.usage, cost: { ...msg.usage.cost } } : msg.usage;
		if (usage?.cost && cost > 0) {
			usage.cost.total = (usage.cost.total ?? 0) + cost;
			usage.cost.advisor = cost;
		}
		return { message: { ...msg, usage, advisor: meta } };
	});

	// stop_reason "pause_turn": the API paused while an advisor call was pending. Pi treats it as a
	// normal stop, so ask for one more model request. (The unresolved server_tool_use is not replayed;
	// the executor simply continues and can call the advisor again.)
	pi.on("turn_end", (event) => {
		const msg = event.message as any;
		if (msg?.role !== "assistant" || msg.rawStopReason !== "pause_turn") return undefined;
		if (event.toolResults.length > 0 || event.continue) return undefined;
		if (autoContinues >= MAX_AUTO_CONTINUES) return undefined;
		autoContinues++;
		return {
			entries: [
				{
					type: "custom_message",
					customType: "advisor-continue",
					content: "(Your turn was paused while the advisor was running. Continue where you left off.)",
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.registerCommand("advisor", {
		description: "Advisor tool: /advisor [on|off|status|<advisor-model>|none] (applies to the current model)",
		handler: async (args, ctx) => {
			cfg = loadConfig();
			const arg = (args ?? "").trim();
			const exec = ctx.model?.id ?? "?";
			if (arg === "on" || arg === "off") {
				cfg.enabled = arg === "on";
				saveConfig(cfg);
			} else if (arg === "none") {
				cfg.pairs[exec] = null;
				saveConfig(cfg);
			} else if (arg && arg !== "status") {
				cfg.pairs[exec] = arg;
				cfg.enabled = true;
				saveConfig(cfg);
			}
			updateStatus(ctx);
			const adv = advisorFor(cfg, ctx.model?.provider, exec);
			const pairs = Object.entries(cfg.pairs)
				.map(([e, a]) => `  ${e} -> ${a ?? "(none)"}`)
				.join("\n");
			ctx.ui.notify(
				`Advisor ${cfg.enabled ? "enabled" : "disabled"}. Current: ${exec} -> ${adv ?? "(none)"}\n` +
					`Session calls: ${sessionCalls}\nPairs (${CONFIG_PATH}):\n${pairs}`,
				"info",
			);
		},
	});
}

// Anthropic's suggested system prompt for coding tasks (timing + how to treat advice).
const STEER_PROMPT = `You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`;
