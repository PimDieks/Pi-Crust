// Live subagent view: the subagent tool streams details.results (one per agent) while it runs.
"use strict";

function subagentSteps(messages) {
	// The tool calls each subagent made, newest last, as short lines.
	const steps = [];
	for (const m of messages || []) {
		if (m.role !== "assistant") continue;
		for (const c of m.content || []) if (c.type === "toolCall") steps.push({ name: c.name, arg: toolSummary(c.name, c.arguments) });
	}
	return steps;
}

function subagentFinal(messages) {
	for (let i = (messages || []).length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		if (text.trim()) return text;
	}
	return "";
}

function subagentRunning(r, finished) {
	return !finished && (r.exitCode === -1 || !r.stopReason || r.stopReason === "toolUse");
}

// Renders all subagents of one call into the card; returns the summary for the card header.
function renderSubagents(t, details, finished) {
	const results = details.results || [];
	if (!t.subProg) {
		t.subProg = el("div", "sub-progress");
		t.subProg.setAttribute("role", "progressbar");
		t.subProg.append(el("span"));
		t.d.insertBefore(t.subProg, t.d.children[1] || null);
	}
	const states = results.map((r) => {
		if (subagentRunning(r, finished)) return "running";
		return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted" ? "done" : "failed";
	});
	const prog = Duration.subagentProgress({ mode: details.mode, states, total: details.mode === "chain" ? t.args?.chain?.length || results.length : details.mode === "parallel" ? t.args?.tasks?.length || results.length : results.length });
	t.subProg.hidden = finished || details.mode === "single" || !prog.total;
	t.subProg.firstChild.style.width = `${Math.round(prog.fraction * 100)}%`;
	t.subProg.setAttribute("aria-valuenow", String(prog.finished));
	t.subProg.setAttribute("aria-valuemax", String(prog.total));
	t.subProg.title = prog.label;
	if (!t.subBox) {
		t.subBox = el("div");
		t.d.append(t.subBox);
	}
	const single = results.length === 1 && details.mode !== "chain" && details.mode !== "parallel";
	let done = 0;
	let failed = 0;
	const blocks = results.map((r, i) => {
		// Parallel marks running agents with exitCode -1; otherwise an agent is still going until its last
		// assistant message ends with a final stop reason ("toolUse" means it is about to run a tool).
		const running = states[i] === "running";
		const ok = states[i] === "done";
		if (!running) ok ? done++ : failed++;
		const box = el("div", "sub");
		const head = el("div", "sub-head");
		const turns = r.usage?.turns ? ` · ${r.usage.turns} turn${r.usage.turns === 1 ? "" : "s"}` : "";
		const steps = subagentSteps(r.messages);
		const model = (r.model || "").replace(/^github-copilot\//, "");
		if (single) {
			// The card summary already shows the agent, task, status dot, tool-call count and clock.
			const m = el("span", "model", model);
			m.title = model;
			head.append(m);
			if (r.usage?.turns) head.append(el("span", "state", turns.slice(3)));
			box.append(head);
		} else {
			const clk = el("span", "sub-clock");
			const span = Duration.messagesSpan(r.messages);
			if (running && span.start != null) {
				startClock(clk, span.start);
				clk.title = "Running for";
			} else if (running) clk.textContent = "starting…";
			else if (span.start != null && span.end != null) clk.textContent = Duration.formatDuration(span.end - span.start);
			const modelEl = el("span", "model", model);
			modelEl.title = model;
			const task = el("div", "sub-task", r.task);
			task.title = r.task || "";
			head.append(
				el("span", `dot`),
				el("span", "agent", `${r.step ? `${r.step}. ` : ""}${r.agent}`),
				modelEl,
				el("span", "state", `${running ? "running" : ok ? "done" : "failed"} · ${Duration.plural(steps.length, "tool call")}${turns}`),
				clk,
			);
			head.firstChild.style.background = running ? "var(--accent)" : ok ? "var(--ok)" : "var(--err)";
			box.append(head, task);
		}
		const stepsAt = box.children.length;
		for (const s of steps.slice(-4)) {
			const line = el("div", "sub-step");
			line.append(el("b", "", TOOL_LABEL[s.name] || s.name), ` ${s.arg}`);
			box.append(line);
		}
		if (steps.length > 4) box.insertBefore(el("div", "sub-step", `… ${steps.length - 4} earlier tool calls`), box.children[stepsAt]);
		const final = subagentFinal(r.messages);
		if (final && (!running || finished)) {
			const out = el("div", "sub-out msg assistant");
			out.append(md(final));
			box.append(out);
		} else if (running && final) {
			box.append(el("div", "sub-step", final.split("\n").filter(Boolean).pop()?.slice(0, 160) || ""));
		}
		if (!ok && !running && (r.errorMessage || r.stderr)) box.append(el("div", "sub-step", (r.errorMessage || r.stderr).slice(0, 300)));
		return box;
	});
	t.subBox.replaceChildren(...blocks);
	scroll();
	const total = results.length;
	if (!finished) return (t.meta.textContent = prog.label || Duration.plural(states.length ? subagentSteps(results[0].messages).length : 0, "tool call"));
	return failed ? `${failed} failed of ${total}` : `${total} agent${total === 1 ? "" : "s"}`;
}
