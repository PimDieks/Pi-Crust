// Self-test step `claude-setup`: the Claude Agent's setup card (every state of both steps), the disabled message box, the card leaving, the pause card
// with Continue and Change limit, and the Setup panel's rows before and after a Claude Agent chat was started. Offscreen, no prompt, the stand-in SDK
// and the fake key store and engine of main (claude-setup-main.js), so no key, no download and no model request is ever real.
// Run: PI_CRUST_SELFTEST_CLAUDE=fake PI_CRUST_CLAUDE_SDK=<repo>\scripts\claude-sdk-stand-in.mjs PI_CRUST_HEALTH_STUB={} PI_CRUST_SELFTEST_OFFSCREEN=1 PI_CRUST_SELFTEST_NOPROMPT=1 npm run selftest -- claude-setup
// Negative control: with PI_CRUST_SELFTEST_CLAUDE_BREAK=1 one expectation is wrong on purpose and the step must report MISMATCH.
"use strict";

selftestSteps.push(async ({ snap, wait }) => {
	const problems = [];
	const check = (ok, what) => ok || problems.push(what);
	const vis = (n) => !!n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
	const until = async (fn, ms = 8000) => {
		for (let t = 0; t < ms; t += 100) {
			try {
				if (fn()) return true;
			} catch {}
			await wait(100);
		}
		return false;
	};
	const GOOD = "sk-ant-test-good-0000";
	const BAD = "sk-ant-test-rejected-0000"; // the stand-in answers this one like the API answers a wrong key
	const ui = window.claudeSetupUi;
	let made = null;
	// Colour maths for the contrast check (WCAG): computed colours come as rgb(), rgba() or color(srgb ...).
	const chan = (str) => {
		const m = String(str).match(/-?\d*\.?\d+(?:e-?\d+)?/g) || [];
		const n = m.map(Number);
		const unit = /^color\(/.test(String(str)) ? 255 : 1;
		return { r: n[0] * unit, g: n[1] * unit, b: n[2] * unit, a: n.length > 3 ? n[3] : 1 };
	};
	const lum = ({ r, g, b }) => {
		const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const ratio = (fg, bg) => {
		const [a, b] = [lum(chan(fg)), lum(chan(bg))].sort((x, y) => y - x);
		return (a + 0.05) / (b + 0.05);
	};
	const opacityOf = (n) => {
		let o = 1;
		for (; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
		return o;
	};
	// The filled (primary) buttons inside `scope`: which ones they are (data-action), full opacity, and text against background of at least 4.5 to 1.
	const primaryCheck = (name, th, scope, want) => {
		const roots = [...document.querySelectorAll(scope)];
		const all = roots.flatMap((r) => [...r.querySelectorAll("button")]).filter(vis);
		const prim = all.filter((b) => b.classList.contains("btn") && !b.classList.contains("secondary"));
		const got = prim.map((b) => b.dataset.action || b.textContent).join();
		check(got === want, `primary buttons in ${name} (${th}): got "${got}", want "${want}"`);
		for (const b of prim) {
			const cs = getComputedStyle(b);
			const r = ratio(cs.color, cs.backgroundColor);
			check(r >= 4.5, `contrast of "${b.textContent}" in ${name} (${th}) is ${r.toFixed(2)}:1 (${cs.color} on ${cs.backgroundColor})`);
			check(opacityOf(b) === 1, `"${b.textContent}" in ${name} (${th}) is faded (opacity ${opacityOf(b)})`);
			check(!b.disabled && b.getAttribute("aria-disabled") !== "true", `"${b.textContent}" in ${name} reads as disabled`);
		}
	};
	// name: the screenshot; want: the primary buttons expected (data-action list); scope: where to look.
	const shots = async (name, want, scope = ".setup-card") => {
		const was = themeSetting();
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await wait(700); // the colours of a full-window view fade; a shot taken inside the fade shows dim text
			if (want !== undefined) primaryCheck(name, th, scope, want);
			await snap(`claude-setup-${name}-${th}`);
		}
		setTheme(was);
		await wait(150);
	};
	const arcOk = (s) => {
		const arc = s?.querySelector(".sc-mark svg .sc-arc");
		if (!arc) return false;
		const r = arc.getBoundingClientRect();
		const cs = getComputedStyle(arc);
		return r.width > 3 && r.height > 3 && cs.stroke !== "none" && chan(cs.stroke).a > 0.9 && Number.parseFloat(cs.strokeWidth) >= 2;
	};
	if (!info.selftestClaudeFake) {
		console.error("SELFTEST claude-setup: needs PI_CRUST_SELFTEST_CLAUDE=fake and PI_CRUST_CLAUDE_SDK (stand-in) -> MISMATCH");
		return;
	}
	const card = () => document.querySelector(`.setup-card[data-chat="${made?.id}"]`);
	const stepOf = (k) => card()?.querySelector(`.sc-step[data-step="${k}"]`);
	const info1 = (k) => {
		const s = stepOf(k);
		return s ? { state: s.dataset.state, title: s.querySelector(".sc-title")?.textContent.replace(/^(To do|Working|Done|Failed)\. /, ""), size: s.querySelector(".sc-size")?.textContent || "", mark: s.querySelector(".sc-mark")?.textContent || "", line: s.querySelector(".sc-line")?.textContent || "", buttons: [...s.querySelectorAll(".sc-actions button")].map((b) => b.textContent), alert: s.querySelector(".sc-line")?.getAttribute("role") === "alert" } : null;
	};
	const btn = (k, action) => stepOf(k)?.querySelector(`[data-action="${action}"]`);
	const fake = (cmd) => crust.claude.fakeSet(cmd);
	const typeKey = async (value) => {
		const input = stepOf("key").querySelector('.sc-field input[type="password"]');
		input.value = value;
		input.closest("form").requestSubmit();
		return input;
	};
	const obRows = () => [...document.querySelectorAll("#ob-rows .ob-row")].map((r) => r.dataset.id);
	const WANT_DOWNLOAD = info.selftestClaudeBreak ? "Install" : "Download"; // negative control: wrong on purpose when asked

	try {
		// 0. before any Claude Agent chat: the Setup panel is about Pi
		await crust.health.stubSet({});
		const pillBefore = $("#setup-pill").textContent;
		await window.crustOnboarding.open("claude-setup");
		await wait(500);
		const rowsBefore = obRows();
		check(rowsBefore.length > 0 && !rowsBefore.some((i) => /claude/.test(i)), `Setup panel before: ${rowsBefore}`);
		window.crustOnboarding.close({ restore: false });
		await wait(200);

		// 1. a new Claude Agent chat opens with the setup card
		await newChat(null, "setup test", { agent: "claude" });
		made = active;
		check(await until(() => made && made.needsSetup && card()), "no setup card in a new Claude Agent chat");
		check(made.agent?.id === "claude" && !made.state.ready, "the chat started without setup");
		const c1 = card();
		check(c1 && c1.parentElement === made.el && c1 === made.el.firstElementChild, "the card is not at the top of the chat");
		check(c1?.getAttribute("role") === "region" && /Set up Claude Agent/.test(c1.querySelector("h3")?.textContent), "card title");
		let k = info1("key");
		let e = info1("engine");
		check(k && k.state === "todo" && k.title === "API key" && k.mark === "1" && k.line === "Your own Anthropic key. Usage is billed to your Anthropic account." && k.buttons.join() === "Add key", `key step to do: ${JSON.stringify(k)}`);
		check(e && e.state === "todo" && e.title === "Engine" && e.mark === "2" && /^about \d+ MB$/.test(e.size) && e.line === "Downloaded once, checked before use." && e.buttons.join() === WANT_DOWNLOAD, `engine step to do: ${JSON.stringify(e)}`);
		check(!document.querySelector("#modal-backdrop:not([hidden])") && !dialogOpen, "a dialog is open");
		// the message box is disabled with the reason, until both steps are done
		const input = $("#input");
		const send = $("#send");
		check(input.readOnly && input.getAttribute("aria-disabled") === "true" && input.placeholder === "Finish setup to send a message", `message box: ${input.readOnly} "${input.placeholder}"`);
		check(send.getAttribute("aria-disabled") === "true" && send.dataset.reason === "Finish setup to send a message", "Send is not disabled with the reason");
		const msgsBefore = made.el.querySelectorAll(".msg.user").length;
		input.value = "hello";
		send.click();
		await wait(200);
		check(made.el.querySelectorAll(".msg.user").length === msgsBefore, "a message was sent during setup");
		// the reason shows only while the disabled control is hovered or focused: no box floats above the message box at rest, not even after a click on Send
		check(!document.querySelector("#toasts .toast") && !vis($("#reason-line")), `something floats above the message box at rest: toast "${document.querySelector("#toasts .toast")?.textContent}", reason line "${$("#reason-line").textContent}"`);
		send.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		check(vis($("#reason-line")) && $("#reason-line").textContent === "Finish setup to send a message", `hovering Send shows no reason: "${$("#reason-line").textContent}"`);
		send.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
		check(!vis($("#reason-line")), "the reason stays after the pointer left Send");
		input.value = "";
		check(!/Starting/.test($("#status-line").textContent), `status line: "${$("#status-line").textContent}"`);
		await wait(600); // let the card finish its entry animation before the contrast check
		await shots("todo", "add-key");

		// 2. the Setup panel now lists the Claude Agent rows (not counted)
		await window.crustOnboarding.open("claude-setup");
		await wait(500);
		const rowsAfter = obRows();
		check(rowsAfter.slice(-3).join() === "claude-key,claude-engine,claude-limit" && rowsAfter.length === rowsBefore.length + 3, `Setup panel after: ${rowsAfter}`);
		const pillNow = $("#setup-pill").textContent;
		check(pillNow === pillBefore, `the Setup count changed: "${pillBefore}" -> "${pillNow}"`);
		check($("#onboarding").textContent.includes("Claude Agent key") && $("#onboarding").textContent.includes("Claude Agent engine"), "panel row label missing");
		await shots("panel-rows-todo", "add-key", "#ob-rows");
		window.crustOnboarding.close({ restore: false });
		await wait(200);

		// 3. step 1: Add key opens a masked field inside the card (no dialog)
		btn("key", "add-key").click();
		await wait(150);
		const field = stepOf("key").querySelector(".sc-field input");
		check(field && field.type === "password" && field.autocomplete === "off" && vis(field) && !dialogOpen, "the key field is not masked or not in the card");
		await shots("key-field", "save-key");
		// a wrong key is refused when it is saved, engine or not: not stored, the card says why
		await typeKey(BAD);
		check(await until(() => info1("key")?.state === "failed" && /did not accept this key/.test(info1("key").line)), `wrong key on save: ${JSON.stringify(info1("key"))}`);
		check((await crust.claude.state()).key.state === "failed", "the wrong key was stored");
		btn("key", "add-key").click(); // Try again
		await wait(150);
		// no connection when it is saved: the key is stored and marked not checked yet; checked after the engine download (step 5)
		await fake({ net: "down" });
		await typeKey(BAD);
		check(stepOf("key").querySelector(".sc-field input") === null || stepOf("key").querySelector(".sc-field input").value === "", "the key stayed in the field after saving");
		check(await until(() => info1("key")?.state === "done"), `key step after save: ${JSON.stringify(info1("key"))}`);
		check(/not checked yet/.test(info1("key").line) && info1("key").buttons.join() === "Change key,Remove key", `pending key: ${JSON.stringify(info1("key"))}`);
		const leak = JSON.stringify(ui.state()) + document.body.innerText + [...document.querySelectorAll("[title],[aria-label]")].map((n) => n.title + n.getAttribute("aria-label")).join();
		check(!leak.includes(BAD), "the key is in the state or on the page");
		check(info1("key").mark === "✓", `key done mark: "${info1("key").mark}"`);
		await shots("key-done-pending", "download");
		btn("key", "remove-key").click();
		check(await until(() => info1("key")?.state === "todo"), "Remove key did not bring step 1 back to do");
		btn("key", "add-key").click();
		await wait(100);
		await typeKey(BAD);
		check(await until(() => info1("key")?.state === "done"), "the key was not stored again");

		// 4. step 2: the download runs only after the click, with the plan's one-time token
		const noToken = await crust.claude.engineDownload("not-a-token");
		check(noToken && noToken.ok === false && noToken.code === "no-confirm", `a download without a plan: ${JSON.stringify(noToken)}`);
		check((await crust.claude.state()).engine.state === "todo", "a download started without a token");
		btn("engine", "download").click();
		check(await until(() => info1("engine")?.state === "working" && /Downloading/.test(info1("engine").line)), `engine working: ${JSON.stringify(info1("engine"))}`);
		await fake({ engine: "progress", percent: 40 });
		check(await until(() => /40%/.test(info1("engine")?.line || "")), `progress: ${info1("engine")?.line}`);
		const bar = stepOf("engine").querySelector('[role="progressbar"]');
		check(bar && bar.getAttribute("aria-valuenow") === "40" && info1("engine").buttons.join() === "Cancel", `progress bar / Cancel: ${info1("engine")?.buttons}`);
		check(info1("engine").mark === "" && arcOk(stepOf("engine")), `the circle of the downloading engine step is empty or has no visible arc: ${JSON.stringify(info1("engine").mark)}`);
		check(info1("engine").title === "Engine" && !/^\d/.test(info1("engine").title), "the step number is shown twice");
		await shots("engine-downloading", "");
		btn("engine", "cancel-download").click();
		check(await until(() => info1("engine")?.state === "todo"), `Cancel: ${JSON.stringify(info1("engine"))}`);
		btn("engine", "download").click();
		await until(() => /Downloading/.test(info1("engine")?.line || ""));
		await fake({ engine: "fail" });
		check(await until(() => info1("engine")?.state === "failed"), "no failed state");
		e = info1("engine");
		check(/Not enough free disk space/.test(e.line) && e.alert && e.buttons.join() === "Try again", `engine failed: ${JSON.stringify(e)}`);
		check(info1("engine").mark === "!", `failed mark: "${info1("engine").mark}"`);
		await shots("engine-failed", "");
		btn("engine", "download").click(); // Try again
		await until(() => /Downloading/.test(info1("engine")?.line || ""));
		await fake({ hold: "keyCheck" });
		await fake({ net: "up" }); // the connection is back: the stored key is checked as soon as the engine is there
		await fake({ engine: "finish" });
		check(await until(() => info1("engine")?.state === "done"), `engine done: ${JSON.stringify(info1("engine"))}`);
		check(/Engine ready/.test(info1("engine").line), "engine done line");
		// 5. the key stored before the engine is checked now: working, then the wrong key fails with a readable reason
		check(await until(() => info1("key")?.state === "working" && /Checking your key/.test(info1("key").line)), `key checking: ${JSON.stringify(info1("key"))}`);
		check(made.needsSetup && input.readOnly, "the message box opened while the key was being checked");
		check(arcOk(stepOf("key")), "the working key step has no visible spinner arc");
		await shots("key-working", "");
		await fake({ release: "keyCheck" });
		check(await until(() => info1("key")?.state === "failed"), `key failed: ${JSON.stringify(info1("key"))}`);
		k = info1("key");
		check(/did not accept this key/.test(k.line) && k.alert && k.buttons.join() === "Try again" && !k.line.includes(BAD), `failed key text: ${JSON.stringify(k)}`);
		check(info1("engine").state === "done" && made.needsSetup && !made.state.ready, "one failed step must keep the card and the disabled message box");
		check(info1("key").mark === "!", `failed key mark: "${info1("key").mark}"`);
		await shots("key-failed", "");
		// 6. try again with a good key: engine is there, so it is checked at once; then both are done
		btn("key", "add-key").click(); // Try again
		await wait(150);
		await fake({ hold: "keyCheck" });
		await typeKey(GOOD);
		check(await until(() => info1("key")?.state === "working"), "no working state for the second save");
		await fake({ release: "keyCheck" });
		check(await until(() => info1("key")?.state === "done"), `key done: ${JSON.stringify(info1("key"))}`);
		k = info1("key");
		check(/saved/i.test(k.line) && k.buttons.join() === "Change key,Remove key", `key done step: ${JSON.stringify(k)}`);
		await shots("both-done", "");
		// the card goes away and the chat starts
		check(await until(() => !card() && !made.needsSetup, 6000), "the card did not go away when both steps were done");
		check(await until(() => made.state.ready, 10000), "the chat did not start");
		check(!input.readOnly && input.getAttribute("aria-disabled") === null && input.placeholder.startsWith("Ask Claude Agent") && send.getAttribute("aria-disabled") === null, `message box after setup: ${input.readOnly} "${input.placeholder}"`);
		check(!JSON.stringify(ui.state()).includes(GOOD), "the good key is in the state");

		// 7. the Setup panel rows: done, with Change key and Remove key (inline, no dialog)
		await window.crustOnboarding.open("claude-setup");
		await wait(500);
		const row = (id) => document.querySelector(`#ob-rows .ob-row[data-id="${id}"]`);
		check(row("claude-key")?.classList.contains("ready") && row("claude-engine")?.classList.contains("ready"), "panel rows are not done");
		const keyBtns = [...(row("claude-key")?.querySelectorAll(".sc-actions button") || [])].map((b) => b.textContent);
		check(keyBtns.join() === "Change key,Remove key", `panel key buttons: ${keyBtns}`);
		await shots("panel-rows-done", "", "#ob-rows");
		// the Claude Agent rows are drawn like the Pi, Git, Project and Figma rows: same background, same plain marks (no circle)
		{
			const piRow = row("git") || row("pi");
			const kr = row("claude-key");
			const cs = (n) => getComputedStyle(n);
			check(cs(kr).backgroundColor === cs(piRow).backgroundColor, `Claude row background ${cs(kr).backgroundColor} vs ${cs(piRow).backgroundColor}`);
			check(kr.querySelector(".ob-mark")?.textContent === "✓" && piRow.querySelector(".ob-mark")?.textContent === "✓", "done marks differ");
			check(!kr.querySelector(".sc-mark") && !row("claude-limit").querySelector(".sc-mark"), "a Claude row still has the circled mark");
			check(cs(kr.querySelector(".ob-mark")).borderTopWidth === cs(piRow.querySelector(".ob-mark")).borderTopWidth && cs(kr.querySelector(".ob-mark")).borderRadius === cs(piRow.querySelector(".ob-mark")).borderRadius, "the Claude mark has a different border from the Pi mark");
			check(cs(kr).borderRadius === cs(piRow).borderRadius && cs(kr).paddingLeft === cs(piRow).paddingLeft, "the Claude row's shape differs");
		}
		row("claude-key").querySelector('[data-action="change-key"]').click();
		await wait(150);
		check(!!row("claude-key").querySelector('.sc-field input[type="password"]') && !dialogOpen, "Change key in the panel has no inline field");
		row("claude-key").querySelector('[data-action="cancel-key"]').click();
		row("claude-key").querySelector('[data-action="remove-key"]').click();
		check(await until(() => row("claude-key")?.classList.contains("todo") || /Add key/.test(row("claude-key")?.textContent || "")), "Remove key in the panel did not remove the key");
		// the spend limit row: the same validation as the pause card
		const limitIn = row("claude-limit")?.querySelector("#claude-limit-input");
		check(!!limitIn, "the panel has no spend limit field");
		if (limitIn) {
			limitIn.value = "0.1";
			row("claude-limit").querySelector("form").requestSubmit();
			check(await until(() => /\$0\.50/.test(row("claude-limit")?.querySelector(".pc-error")?.textContent || "")), "a limit under the minimum was not refused in the panel");
			// zero, a negative number and text: each refused with its own readable sentence, and the typed text stays in the field
			for (const [bad, re] of [["0", /zero/], ["-2", /negative/], ["abc", /not an amount/], ["", /Enter an amount/]]) {
				const f = row("claude-limit").querySelector("#claude-limit-input");
				f.value = bad;
				row("claude-limit").querySelector("form").requestSubmit();
				check(await until(() => re.test(row("claude-limit")?.querySelector(".pc-error")?.textContent || "")), `limit "${bad}" in the panel: "${row("claude-limit")?.querySelector(".pc-error")?.textContent}"`);
				check(row("claude-limit").querySelector("#claude-limit-input").value === bad, `the refused text "${bad}" did not stay in the field`);
				check(ui.state()?.limitUsd !== 0 && ui.state()?.limitUsd > 0, "a refused limit changed the setting");
			}
			const input2 = row("claude-limit").querySelector("#claude-limit-input");
			check(input2.type === "text" && input2.inputMode === "decimal", `limit field type ${input2.type}/${input2.inputMode}`);
			input2.value = "7,5"; // a comma works like a point
			row("claude-limit").querySelector("form").requestSubmit();
			check(await until(() => ui.state()?.limitUsd === 7.5 && /Saved/.test(row("claude-limit")?.textContent || "")), "a valid limit (7,5) was not saved from the panel");
			check(row("claude-limit").querySelector("#claude-limit-input").value === "7.50", `the field shows "${row("claude-limit").querySelector("#claude-limit-input").value}", not 7.50`);
			check(/pauses and asks once it has used about \$7\.50\./.test(row("claude-limit").textContent) && /A Claude Agent chat pauses/.test(row("claude-limit").textContent) && /Spend limit per chat/.test(row("claude-limit").textContent), `limit row wording: ${row("claude-limit").textContent}`);
			check(!/per run|Claude Agent run/.test(row("claude-limit").textContent), "the limit row still says run");
			await crust.claude.setLimit(5);
		}
		window.crustOnboarding.close({ restore: false });
		await wait(200);
		await fake({ key: "reset" });
		await crust.claude.saveKey(GOOD); // the chat below needs no setup again
		await until(() => ui.state()?.ready);

		// 8. the pause card (the record the adapter sends at the spend limit), under a few messages of conversation
		const say = (...recs) => withChat(made, () => recs.forEach((r) => handleRecord(r)));
		const turn = (user, thinking, answer) => [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "user", content: [{ type: "text", text: user }] } },
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: user }] } },
			{ type: "message_start", message: { role: "assistant", content: [], stopReason: "stop" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinking } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: answer } },
			{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: answer } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: answer }], stopReason: "stop" } },
			{ type: "agent_end" },
			{ type: "agent_settled" },
		];
		say(...turn("Which files are in the src folder?", "The user wants a listing of src; I can answer from what I already read.", "The src folder holds the app's main files: the main process, the renderer, the styles and the agent adapters."));
		say(...turn("Please summarise what the renderer does.", "A short summary is enough here.", "The renderer draws the chat, the panels and the setup cards, and sends the person's choices to the main process."));
		await wait(300);
		check(made.el.querySelectorAll(".msg.user").length >= 2, "the conversation above the pause card has no messages");
		const rec = { type: "claude_paused", reason: "budget", message: "Stopped: the spending limit ($5.00) was reached. About $5.02 spent.", totalCostUsd: 5.02, limitUsd: 5, maxTurns: 100, sessionId: "stand-in-session", canContinue: true, continueLabel: "Continue" };
		withChat(made, () => handleRecord(rec));
		await wait(300);
		const pc = () => made.el.querySelector(".pause-card");
		check(pc() && made.el.lastElementChild === pc(), "the pause card is not at the end of the conversation");
		const pcLines = (n = pc()) => [...(n?.querySelectorAll(".pc-line") || [])].map((x) => x.textContent);
		check(pc()?.querySelector("h3")?.textContent === "Paused at the spend limit" && pc().getAttribute("aria-labelledby") === pc().querySelector("h3")?.id, `pause title: "${pc()?.querySelector("h3")?.textContent}"`);
		check(pc()?.firstElementChild?.tagName === "H3", "the title is not the first thing in the pause card");
		check(pcLines().join("|") === "This chat has used about $5.02.|Continue for up to another $5.00?", `pause text: ${pcLines().join("|")}`);
		{
			const [a, b] = [...pc().querySelectorAll(".pc-line")].map((x) => x.getBoundingClientRect());
			check(a && b && b.top >= a.bottom - 1, "the two lines of the pause card are not on two lines");
		}
		check([...pc().querySelectorAll("button")].map((b) => b.textContent).join() === "Continue,Change limit", "pause buttons");
		check(input.readOnly && input.placeholder === "Choose Continue to send a message" && send.dataset.reason === "Choose Continue to send a message", `pause gate: ${input.readOnly} "${input.placeholder}"`);
		await shots("pause", "continue", ".pause-card");
		// Change limit: an invalid amount is refused, a valid one is a setting and continues
		pc().querySelector('[data-action="change-limit"]').click();
		await wait(150);
		const lim = pc().querySelector(".pc-limit input");
		check(lim && lim.value === "5.00", `the limit field does not start at the current limit: "${lim && lim.value}"`);
		check(/Spend limit per chat/.test(pc().querySelector(".pc-limit label")?.textContent || ""), "the pause card's field is not labelled per chat");
		await shots("pause-limit", "continue,save-limit", ".pause-card");
		lim.value = "0.1";
		pc().querySelector("form").requestSubmit();
		check(await until(() => pc()?.querySelector(".pc-error")), "an invalid limit was accepted");
		pc().querySelector(".pc-limit input").value = "7,5";
		pc().querySelector("form").requestSubmit();
		check(await until(() => !pc() && !made.pause), "Save and continue did not close the pause card");
		check((await crust.claude.state()).limitUsd === 7.5, `limit setting: ${(await crust.claude.state()).limitUsd}`);
		check(await until(() => made.state.ready && !input.readOnly, 10000), "the chat did not come back after Change limit");
		// Continue with the same limit
		withChat(made, () => handleRecord({ ...rec, totalCostUsd: 7.51, limitUsd: 7.5 }));
		await wait(200);
		check(pcLines().join("|") === "This chat has used about $7.51.|Continue for up to another $7.50?", `second pause text: ${pcLines().join("|")}`);
		pc().querySelector('[data-action="continue"]').click();
		check(await until(() => !pc() && !made.pause), "Continue did not close the pause card");
		check(await until(() => made.state.ready && !input.readOnly && input.placeholder.startsWith("Ask Claude Agent"), 10000), "the chat did not come back after Continue");

		// 8b. a restored fork whose parent chat is gone: a card that says so, the message box disabled with the reason, nothing else
		{
			const gone = { type: "claude_fork_gone", message: "The chat this one was forked from is gone, so there is nothing to continue. Start a new chat." };
			withChat(made, () => handleRecord(gone));
			await wait(250);
			const gc = made.el.querySelector(".gone-card");
			check(!!gc && vis(gc) && /original chat is gone/.test(gc.querySelector("h3")?.textContent || ""), `gone card: ${gc && gc.textContent}`);
			check(/forked from a chat that no longer exists/.test(gc?.textContent || "") && /Start a new chat/.test(gc?.textContent || ""), "gone card text");
			check(input.readOnly && input.placeholder === "The chat this one was forked from is gone" && send.dataset.reason === input.placeholder && send.getAttribute("aria-disabled") === "true", `gone gate: ${input.readOnly} "${input.placeholder}"`);
			{
				const was = themeSetting();
				for (const th of ["light", "dark"]) {
					setTheme(th);
					await wait(700);
					await snap(`claude-setup-fork-gone-${th}`);
				}
				setTheme(was);
				await wait(150);
			}
			made.forkGone?.el.remove();
			made.forkGone = null;
			ui.syncComposer(made);
			check(!input.readOnly && input.placeholder.startsWith("Ask Claude Agent"), `message box after clearing the gone card: "${input.placeholder}"`);
		}

		// 6. the chip in a Claude Agent chat's header is the way to its key: it opens the Setup view at the Claude Agent rows, also once Pi is set up
		{
			const chip = $("#agent-chip");
			window.agentUi.sync(made);
			check(chip.getAttribute("role") === "button" && chip.tabIndex === 0, `Claude chip role/tabindex: ${chip.getAttribute("role")}/${chip.tabIndex}`);
			check(/Claude Agent/.test(chip.getAttribute("aria-label") || "") && /setup/i.test(chip.getAttribute("aria-label") || "") && /key/i.test(chip.getAttribute("aria-label") || ""), `Claude chip name: "${chip.getAttribute("aria-label")}"`);
			const cursor = getComputedStyle(chip).cursor;
			check(cursor === "pointer", `Claude chip cursor: ${cursor}`);
			// The ring comes from :focus-visible, which a scripted focus in a hidden window never matches: the rule itself is checked.
			const ringRule = [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).find((r) => r.selectorText && /\.agent-chip\[role="button"\]:focus-visible/.test(r.selectorText));
			check(ringRule && /2px/.test(ringRule.style.outline) && /accent/.test(ringRule.style.outline), `Claude chip focus rule: ${ringRule && ringRule.cssText}`);
			await shots("chip-header", undefined, "#chat-pane");
			// a Pi chat's chip does nothing new
			const pi = [...chats.values()].find((x) => x.agent && x.agent.id === "pi");
			if (pi) {
				activate(pi);
				window.agentUi.sync(pi);
				check(!chip.hasAttribute("role") && chip.tabIndex === -1 && !chip.hasAttribute("aria-label"), `Pi chip is a control: role=${chip.getAttribute("role")} tabindex=${chip.tabIndex}`);
				chip.click();
				await wait(300);
				check($("#onboarding").hidden, "a click on a Pi chat's chip opened the Setup view");
				activate(made);
				window.agentUi.sync(made);
			} else check(false, "no Pi chat to compare the chip with");
			// click: the Setup view opens, the first Claude Agent row is visible and holds the focus
			chip.click();
			check(await until(() => !$("#onboarding").hidden), "the chip did not open the Setup view");
			check(await until(() => !!document.activeElement?.closest?.(".sc-row"), 4000), `focus after the chip: ${document.activeElement?.tagName}.${document.activeElement?.className}`);
			await wait(300);
			const firstRow = document.querySelector('#ob-rows .ob-row[data-id="claude-key"]');
			const box = $("#ob-rows").getBoundingClientRect();
			const rr = firstRow?.getBoundingClientRect();
			check(rr && rr.height > 0 && rr.top >= box.top - 1 && rr.bottom <= box.bottom + 1, `the Claude Agent key row is not in view: ${JSON.stringify(rr)} in ${JSON.stringify(box)}`);
			await wait(1200); // the opening fade of the full-window view must be over before the first shot
			await shots("chip-opens-setup", undefined, "#onboarding");
			window.crustOnboarding.close({ restore: true });
			await wait(200);
			// the keyboard does the same
			chip.focus();
			chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			check(await until(() => !$("#onboarding").hidden), "Enter on the chip did not open the Setup view");
			window.crustOnboarding.close({ restore: false });
			await wait(200);
		}
	} catch (e) {
		problems.push(`threw ${e && e.message}`);
	} finally {
		try {
			if (made && chats.has(made.id)) await closeChat(made);
		} catch {}
	}
	console.error(`SELFTEST claude-setup: setup card (both steps: to do, working, done, failed + retry, Cancel), disabled message box, card leaves, pause card (Continue, Change limit), Setup panel rows before and after${problems.length ? " -> MISMATCH: " + problems.join("; ") : " -> OK"}`);
}, "claude-setup");
