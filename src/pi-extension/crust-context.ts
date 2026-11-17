// Loaded only by Pi Crust (`pi --mode rpc -e <this file>`). Reports what the model context is used for and
// which models the session used, as JSON in the "crust-context" status, which reaches the UI over RPC.
// Token counts other than Pi's own context total are chars/4 estimates (the same heuristic Pi uses).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = "crust-context";
const est = (s: string) => Math.ceil((s || "").length / 4);

// The system prompt is built from sections wrapped in <name>…</name> (except the untagged preamble).
function splitPrompt(prompt: string) {
	let skills = 0;
	let memory = 0;
	const memoryFiles: { path: string; tokens: number }[] = [];
	const sk = prompt.match(/<skills>[\s\S]*?<\/skills>/);
	if (sk) skills = est(sk[0]);
	const skillCount = sk ? (sk[0].match(/<skill>/g) || []).length : 0;
	const pc = prompt.match(/<project_context>[\s\S]*?<\/project_context>/);
	if (pc) {
		memory = est(pc[0]);
		for (const m of pc[0].matchAll(/<project_instructions path="([^"]*)">([\s\S]*?)<\/project_instructions>/g))
			memoryFiles.push({ path: m[1], tokens: est(m[2]) });
	}
	return { system: Math.max(0, est(prompt) - skills - memory), skills, skillCount, memory, memoryFiles };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: any) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : c.type === "toolCall" ? JSON.stringify(c.arguments ?? {}) + c.name : c.type === "image" ? "x".repeat(4800) : ""))
		.join("");
}

type ModelUse = { model: string; source: "chat" | "subagent"; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export default function (pi: ExtensionAPI) {
	let last = "";

	function report(ctx: ExtensionContext) {
		try {
			const prompt = ctx.getSystemPrompt() || "";
			const parts = splitPrompt(prompt);

			// Tools declared to the model vs. registered but only reachable via codemode / tool_search.
			const active = new Set(pi.getActiveTools());
			let tools = 0;
			let deferred = 0;
			let toolCount = 0;
			let deferredCount = 0;
			for (const t of pi.getAllTools()) {
				const size = est(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
				if (active.has(t.name)) {
					tools += size;
					toolCount++;
				} else if (t.exposure !== "hidden") {
					deferred += size;
					deferredCount++;
				}
			}

			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow || ctx.model?.contextWindow || 0;

			// Messages: Pi's real total minus the fixed parts; right after a compaction Pi has no total yet, so estimate.
			const branch = ctx.sessionManager.getBranch() as any[];
			let messages: number;
			let estimated = false;
			if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
				messages = Math.max(0, usage.tokens - parts.system - parts.skills - parts.memory - tools);
			} else {
				estimated = true;
				let start = 0;
				for (let i = branch.length - 1; i >= 0; i--)
					if (branch[i].type === "compaction") {
						start = i;
						break;
					}
				messages = 0;
				for (const e of branch.slice(start)) {
					if (e.type === "compaction") messages += est(e.summary || "");
					else if (e.type === "message") messages += est(textOf(e.message?.content));
				}
			}

			let reserve = 16384;
			try {
				const s: any = pi.getSettings();
				if (s?.compaction?.enabled === false) reserve = 0;
				else if (typeof s?.compaction?.reserveTokens === "number") reserve = s.compaction.reserveTokens;
			} catch {}

			// Models used in the whole session (all branches): the chat's own turns and subagents.
			const models = new Map<string, ModelUse>();
			const add = (model: string, source: ModelUse["source"], u: any, turns: number) => {
				if (!model) return;
				const k = `${source}:${model}`;
				const m = models.get(k) || { model, source, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				m.turns += turns;
				m.input += u?.input || 0;
				m.output += u?.output || 0;
				m.cacheRead += u?.cacheRead || 0;
				m.cacheWrite += u?.cacheWrite || 0;
				m.cost += typeof u?.cost === "number" ? u.cost : u?.cost?.total || 0;
				models.set(k, m);
			};
			for (const e of ctx.sessionManager.getEntries() as any[]) {
				if (e.type !== "message") continue;
				const msg = e.message;
				if (msg?.role === "assistant" && msg.usage) add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model, "chat", msg.usage, 1);
				else if (msg?.role === "toolResult" && msg.toolName === "subagent")
					for (const r of msg.details?.results || []) add(r.model, "subagent", r.usage, r.usage?.turns || 0);
			}

			const data = {
				window,
				total: estimated ? null : usage?.tokens ?? null,
				percent: usage?.percent ?? null,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
				estimated,
				categories: { messages, tools, skills: parts.skills, system: parts.system, memory: parts.memory, reserve },
				deferred,
				toolCount,
				deferredCount,
				skillCount: parts.skillCount,
				memoryFiles: parts.memoryFiles,
				models: [...models.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
			};
			const json = JSON.stringify(data);
			if (json === last) return;
			last = json;
			ctx.ui.setStatus(KEY, json);
		} catch (e) {
			// Never break the session over a report.
		}
	}

	for (const ev of ["session_start", "turn_end", "agent_settled", "model_select", "session_compact", "session_tree"] as const)
		pi.on(ev as any, async (_e: unknown, ctx: ExtensionContext) => report(ctx));
	// Tool results (e.g. subagents) and tool_search activations change the picture mid-run.
	pi.on("tool_execution_end", async (_e, ctx) => report(ctx));
}
