// Self-test step `claude-approval`: a Claude Agent chat's approval prompt, from the permission gate to the screen and back. Offscreen, no prompt, the
// stand-in SDK (its script makes the tool calls: it runs each one through the real hook and canUseTool), the fake key store and engine, a temporary git
// repo and user-data folder: no real key, engine or model is touched, and the Remote server is never started.
// The step answers the prompts the way a user does (a click, Enter after the key guard) and checks what is on screen; the runner
// (scripts/claude-approval-selftest.js) reads the stand-in's gate log afterwards, which says what each answer did to its call (allow or deny).
// Run it with: node scripts/claude-approval-selftest.js [--shots <folder>] [--break]
// Negative control: PI_CRUST_SELFTEST_CLAUDE_BREAK=1 makes one expectation wrong on purpose and the step must report MISMATCH.
"use strict";

selftestSteps.push(async ({ snap, wait }) => {
	const problems = [];
	const check = (ok, what) => ok || problems.push(what);
	const vis = (n) => !!n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
	const until = async (fn, ms = 10000, step = 50) => {
		for (let t = 0; t < ms; t += step) {
			try {
				if (fn()) return true;
			} catch {}
			await wait(step);
		}
		return false;
	};
	if (!info.selftestClaudeFake) {
		console.error("SELFTEST claude-approval: needs PI_CRUST_SELFTEST_CLAUDE=fake and PI_CRUST_CLAUDE_SDK (stand-in) -> MISMATCH");
		return;
	}
	const GOOD = "sk-ant-test-good-0000";
	const THREE = ["Allow once", "Allow for this chat", "Deny"];
	const TWO = ["Allow once", "Deny"];
	const box = () => $("#ask");
	const promptUp = () => vis(box()) && box().classList.contains("perm");
	const labels = () => [...box().querySelectorAll(".options button")].map((b) => b.textContent);
	// The default answer is VISIBLY focused: exactly one answer has the filled look (accent border, tinted fill, bold), and it is the one Enter gives, whether or
	// not the window has OS focus (a background or offscreen window has no :focus styling; the screenshots below are taken in such a window).
	const defaultButton = (want) => [...box().querySelectorAll(".options button")].find((b) => b.textContent === want);
	const lookDefault = (label, want) => {
		const all = [...box().querySelectorAll(".options button")];
		const def = defaultButton(want);
		const filled = (b) => getComputedStyle(b).borderTopColor !== "rgba(0, 0, 0, 0)" && Number(getComputedStyle(b).fontWeight) >= 600;
		check(!!def && filled(def), `${label}: "${want}" does not look focused (border ${def && getComputedStyle(def).borderTopColor}, weight ${def && getComputedStyle(def).fontWeight})`);
		check(all.filter(filled).length === 1, `${label}: ${all.filter(filled).length} answers look focused, want exactly 1`);
	};
	let currentWant = null;
	const shots = async (name) => {
		const was = themeSetting();
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await wait(350);
			lookDefault(`${name} ${th} (window without focus)`, currentWant);
			await snap(`claude-approval-${name}-${th}`);
		}
		setTheme(was);
		await wait(200);
	};
	// Nothing of a question is left: the box has no layout (hidden and display none), no class of its own, no height between the conversation and the
	// message box, and the message box sits where it sat before the question.
	let baseTop = null;
	const noLeftover = (label) => {
		const b = box();
		const cs = getComputedStyle(b);
		const top = $("#input").getBoundingClientRect().top;
		check(b.getClientRects().length === 0 && cs.display === "none" && b.offsetHeight === 0, `${label}: an empty question box is left (display ${cs.display}, height ${b.offsetHeight}, hidden ${b.hidden}, class "${b.className}")`);
		check(!b.hidden || (!b.classList.contains("perm") && !b.classList.contains("risky")), `${label}: the hidden question box keeps its class "${b.className}"`);
		check(!b.childElementCount, `${label}: the hidden question box keeps ${b.childElementCount} children`);
		if (baseTop !== null) check(Math.abs(top - baseTop) <= 1, `${label}: the message box moved from ${baseTop} to ${top}`);
	};
	const press = (key) => {
		const t = document.activeElement;
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		t.dispatchEvent(ev);
		if (!ev.defaultPrevented && key === "Enter" && t.tagName === "BUTTON") t.click(); // the browser's own default action
		t.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
		return ev.defaultPrevented;
	};
	const users = (c) => [...c.el.querySelectorAll(".msg.user")];
	const settled = (c, n) => !c.turn && users(c).length >= n && c.el.querySelectorAll(".msg.assistant-turn").length >= n;
	const send = async (c, text) => {
		$("#input").value = text;
		await submit();
	};
	// One prompt: wait for it, check what it shows, then answer it. spec: { has: [text that must be in it], options, risky, shot, answer: "enter" | "<label>", guard }
	const answerPrompt = async (spec, label) => {
		if (!(await until(promptUp, 10000, 20))) return check(false, `${label}: no approval prompt`);
		const opened = performance.now();
		const text = box().textContent;
		for (const t of spec.has) check(text.includes(t), `${label}: the prompt does not show "${t}": ${text.slice(0, 160)}`);
		check(labels().join("|") === spec.options.join("|"), `${label}: buttons [${labels()}], want [${spec.options}] (no Cancel)`);
		check(box().classList.contains("risky") === !!spec.risky, `${label}: risky=${box().classList.contains("risky")}, want ${!!spec.risky}`);
		const want = spec.risky ? "Deny" : "Allow once";
		check(document.activeElement?.textContent === want, `${label}: the focused answer is "${document.activeElement?.textContent}", want ${want}`);
		check(!!defaultButton(want) && defaultButton(want).classList.contains("ask-default"), `${label}: "${want}" is not marked as the default`);
		check(!/claude:|sk-ant-/.test(text), `${label}: internal name or key in the prompt`);
		if (spec.guard) {
			// Enter inside the first 500 ms is ignored: a key meant for the message box cannot answer it.
			const early = performance.now() - opened < 450 ? press("Enter") : null;
			check(early === true, `${label}: Enter inside the key guard was not ignored (${early === null ? "too late to test" : "answered"})`);
			check(promptUp(), `${label}: the key guard let Enter answer the prompt`);
		}
		currentWant = want;
		await wait(300); // the fill fades in
		lookDefault(label, want);
		if (spec.shot) await shots(spec.shot);
		await wait(Math.max(0, 600 - (performance.now() - opened))); // a click from the keyboard or a script is ignored inside the 500 ms key guard, like a key
		if (spec.answer === "enter") {
			press("Enter");
		} else {
			const b = [...box().querySelectorAll(".options button")].find((x) => x.textContent === spec.answer);
			check(!!b, `${label}: no "${spec.answer}" button`);
			b?.click();
		}
		check(await until(() => !promptUp(), 4000), `${label}: the prompt did not close after the answer`);
		noLeftover(`${label} after the answer`); // at once: the next prompt of the same turn may already be coming
	};
	const turn = async (c, n, text, prompts, name) => {
		baseTop = $("#input").getBoundingClientRect().top;
		await send(c, text);
		for (let i = 0; i < prompts.length; i++) await answerPrompt(prompts[i], `${name} prompt ${i + 1}`);
		check(await until(() => settled(c, n), 15000), `${name}: the turn did not finish`);
		check(!promptUp() && !(c.asks || []).length, `${name}: a prompt is still open or queued (${(c.asks || []).length})`);
		if (name === "ask-commands") {
			const was = themeSetting();
			for (const th of ["light", "dark"]) {
				setTheme(th);
				await wait(350);
				noLeftover(`${name} ${th} after the turn`);
				await snap(`claude-approval-after-answer-${th}`); // the chat right after the answered questions: no bar above the message box
			}
			setTheme(was);
		}
	};
	const setModeTo = async (m) => {
		await setMode(m);
		return until(() => $("#perm-mode").dataset.mode === m, 8000);
	};
	const wasSelftest = info.selftest;
	info.selftest = false; // renderAsk would answer a question by itself after 1.5 s: here a user (this step) answers
	check(crust.app.selftestRun === true && crustNative.notify("Claude Agent asks", { body: "selftest" }) === null, "a native notification can be created in a selftest run (the page flag is off here, the main process flag must hold)");
	let made = null;
	try {
		await crust.health.stubSet({});
		await newChat(null, "Approval test", { agent: "claude" });
		made = active;
		check(await until(() => made.needsSetup), "no setup card");
		await crust.claude.fakeSet({ engine: "ready" });
		await crust.claude.saveKey(GOOD);
		check(await until(() => made.state.ready && !made.needsSetup && !$("#input").readOnly, 15000), "the Claude chat did not start");
		check(await until(() => $("#perm-mode").dataset.mode === "ask-commands", 8000), `the first mode is ${$("#perm-mode").dataset.mode}, want ask-commands`);

		// 1. Ask before commands: every call that is not a plain read or an edit inside the project asks.
		//    build x3: Allow once (Enter after the key guard), then Allow for this chat, then the grant covers the same command without a prompt;
		//    lint: asks again (the grant is for build only) and is denied; the Agent tool asks; a subagent's own command asks too; a protected file
		//    is risky: two answers, opens on Deny, Enter denies.
		await turn(
			made,
			1,
			"Build it, lint it, then have a subagent run the tests and touch the git config.",
			[
				{ has: ["Allow this command?", "npm run build", "Mode: Ask before commands"], options: THREE, answer: "enter", guard: true, shot: "command" },
				{ has: ["npm run build"], options: THREE, answer: "Allow for this chat" },
				// (the third build has no prompt: the next one is lint)
				{ has: ["npm run lint"], options: THREE, answer: "Deny" },
				{ has: ["Allow starting a subagent?", "Task: Run the tests", "Its own commands and edits ask separately."], options: THREE, answer: "Allow once", shot: "subagent" },
				{ has: ["npm run test"], options: THREE, answer: "Deny" },
				{ has: ["config", "Allow this edit?", "This file can change what git or Claude Agent runs."], options: TWO, risky: true, answer: "enter", shot: "risky" },
			],
			"ask-commands",
		);

		// 2. Plan: nothing asks, the calls are denied by the gate.
		check(await setModeTo("plan"), "no switch to Plan");
		await turn(made, 2, "Try the same in Plan.", [], "plan");

		// 3. Trusted: nothing asks, everything runs.
		check(await setModeTo("trusted"), "no switch to Trusted");
		await turn(made, 3, "And in Trusted.", [], "trusted");

		// 3b. The question box is shared with Pi chats: a plain Pi question and a Pi permission question (same records) leave nothing either, and a
		//     second question after the first shows and leaves the same way. (Closed with dismiss(): nothing is sent to a process.)
		baseTop = $("#input").getBoundingClientRect().top;
		for (const [kind, spec] of [["plain", { method: "select", title: "Pick one", options: ["A", "B"] }], ["permission", { method: "select", title: "Allow this command?\nnpm run x", options: TWO }]]) {
			for (const n of [1, 2]) {
				askInChat(made, { id: `selftest-${kind}-${n}`, ...spec });
				check(await until(() => vis(box()), 3000), `shared ${kind} ${n}: the question did not show`);
				check(box().classList.contains("perm") === (kind === "permission"), `shared ${kind} ${n}: class "${box().className}"`);
				await wait(100);
				made.asks[0]?.dismiss();
				await wait(100);
				noLeftover(`shared ${kind} question ${n} after it closed`);
			}
		}

		// 4. A prompt that is open when the chat is closed leaves the screen and the call is denied (the runner reads the gate log).
		check(await setModeTo("ask-commands"), "no switch back to Ask before commands");
		await send(made, "One more command, then I close the chat.");
		check(await until(promptUp, 10000, 20), "closing: no approval prompt");
		check(/npm run closing/.test(box().textContent), `closing: the prompt shows "${box().textContent.slice(0, 100)}"`);
		const closing = closeChat(made);
		if (await until(() => vis($("#modal-backdrop")), 3000)) [...document.querySelectorAll("#modal .modal-actions button")].find((b) => b.textContent === "Close chat")?.click();
		await closing;
		check(await until(() => !chats.has(made.id), 5000), "the chat did not close");
		check(!promptUp(), "the prompt stayed on screen after its chat closed");
		noLeftover("closing: after the chat closed");
		made = null;
		await wait(800); // the gate's deny reaches the stand-in's log
		if (info.selftestClaudeBreak) check(false, "negative control: this expectation is wrong on purpose");
	} catch (e) {
		problems.push(`threw ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e}`);
	} finally {
		info.selftest = wasSelftest;
		try {
			if (made && chats.has(made.id)) await closeChat(made);
		} catch {}
	}
	console.error(`SELFTEST claude-approval: Claude Agent approval prompt (Allow once by Enter after the key guard, Allow for this chat covers the same command only, Deny, a subagent's call asks, a risky prompt opens on Deny with two answers, Plan and Trusted ask nothing, closing the chat withdraws the prompt), light and dark${problems.length ? " -> MISMATCH: " + problems.join("; ") : " -> OK"}`);
}, "claude-approval");
