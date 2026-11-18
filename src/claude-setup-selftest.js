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
	const shots = async (name) => {
		const was = themeSetting();
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await wait(300);
			await snap(`claude-setup-${name}-${th}`);
		}
		setTheme(was);
		await wait(150);
	};
	if (!info.selftestClaudeFake) {
		console.error("SELFTEST claude-setup: needs PI_CRUST_SELFTEST_CLAUDE=fake and PI_CRUST_CLAUDE_SDK (stand-in) -> MISMATCH");
		return;
	}
	const card = () => document.querySelector(`.setup-card[data-chat="${made?.id}"]`);
	const stepOf = (k) => card()?.querySelector(`.sc-step[data-step="${k}"]`);
	const info1 = (k) => {
		const s = stepOf(k);
		return s ? { state: s.dataset.state, title: s.querySelector(".sc-title")?.textContent.replace(/^(To do|Working|Done|Failed)\. /, ""), size: s.querySelector(".sc-size")?.textContent || "", line: s.querySelector(".sc-line")?.textContent || "", buttons: [...s.querySelectorAll(".sc-actions button")].map((b) => b.textContent), alert: s.querySelector(".sc-line")?.getAttribute("role") === "alert" } : null;
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
		check(k && k.state === "todo" && k.title === "1 API key" && k.line === "Your own Anthropic key. Usage is billed to your Anthropic account." && k.buttons.join() === "Add key", `key step to do: ${JSON.stringify(k)}`);
		check(e && e.state === "todo" && e.title === "2 Engine" && /^about \d+ MB$/.test(e.size) && e.line === "Downloaded once, checked before use." && e.buttons.join() === WANT_DOWNLOAD, `engine step to do: ${JSON.stringify(e)}`);
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
		input.value = "";
		check(!/Starting/.test($("#status-line").textContent), `status line: "${$("#status-line").textContent}"`);
		await shots("todo");

		// 2. the Setup panel now lists the Claude Agent rows (not counted)
		await window.crustOnboarding.open("claude-setup");
		await wait(500);
		const rowsAfter = obRows();
		check(rowsAfter.slice(-2).join() === "claude-key,claude-engine" && rowsAfter.length === rowsBefore.length + 2, `Setup panel after: ${rowsAfter}`);
		const pillNow = $("#setup-pill").textContent;
		check(pillNow === pillBefore, `the Setup count changed: "${pillBefore}" -> "${pillNow}"`);
		check($("#onboarding").textContent.includes("Claude Agent key") && $("#onboarding").textContent.includes("Claude Agent engine"), "panel row label missing");
		await shots("panel-rows-todo");
		window.crustOnboarding.close({ restore: false });
		await wait(200);

		// 3. step 1: Add key opens a masked field inside the card (no dialog)
		btn("key", "add-key").click();
		await wait(150);
		const field = stepOf("key").querySelector(".sc-field input");
		check(field && field.type === "password" && field.autocomplete === "off" && vis(field) && !dialogOpen, "the key field is not masked or not in the card");
		await shots("key-field");
		// a wrong key, stored before the engine is there: checked after the download (step 5)
		await typeKey(BAD);
		check(field.value === "", "the key stayed in the field after saving");
		check(await until(() => info1("key")?.state === "done"), `key step after save: ${JSON.stringify(info1("key"))}`);
		check(/checked once the engine is downloaded/.test(info1("key").line) && info1("key").buttons.join() === "Change key,Remove key", `pending key: ${JSON.stringify(info1("key"))}`);
		const leak = JSON.stringify(ui.state()) + document.body.innerText + [...document.querySelectorAll("[title],[aria-label]")].map((n) => n.title + n.getAttribute("aria-label")).join();
		check(!leak.includes(BAD), "the key is in the state or on the page");
		await shots("key-done-pending");
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
		await shots("engine-downloading");
		btn("engine", "cancel-download").click();
		check(await until(() => info1("engine")?.state === "todo"), `Cancel: ${JSON.stringify(info1("engine"))}`);
		btn("engine", "download").click();
		await until(() => /Downloading/.test(info1("engine")?.line || ""));
		await fake({ engine: "fail" });
		check(await until(() => info1("engine")?.state === "failed"), "no failed state");
		e = info1("engine");
		check(/Not enough free disk space/.test(e.line) && e.alert && e.buttons.join() === "Try again", `engine failed: ${JSON.stringify(e)}`);
		await shots("engine-failed");
		btn("engine", "download").click(); // Try again
		await until(() => /Downloading/.test(info1("engine")?.line || ""));
		await fake({ hold: "keyCheck" });
		await fake({ engine: "finish" });
		check(await until(() => info1("engine")?.state === "done"), `engine done: ${JSON.stringify(info1("engine"))}`);
		check(/Engine ready/.test(info1("engine").line), "engine done line");
		// 5. the key stored before the engine is checked now: working, then the wrong key fails with a readable reason
		check(await until(() => info1("key")?.state === "working" && /Checking your key/.test(info1("key").line)), `key checking: ${JSON.stringify(info1("key"))}`);
		check(made.needsSetup && input.readOnly, "the message box opened while the key was being checked");
		await shots("key-working");
		await fake({ release: "keyCheck" });
		check(await until(() => info1("key")?.state === "failed"), `key failed: ${JSON.stringify(info1("key"))}`);
		k = info1("key");
		check(/did not accept this key/.test(k.line) && k.alert && k.buttons.join() === "Try again" && !k.line.includes(BAD), `failed key text: ${JSON.stringify(k)}`);
		check(info1("engine").state === "done" && made.needsSetup && !made.state.ready, "one failed step must keep the card and the disabled message box");
		await shots("key-failed");
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
		await shots("both-done");
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
		await shots("panel-rows-done");
		row("claude-key").querySelector('[data-action="change-key"]').click();
		await wait(150);
		check(!!row("claude-key").querySelector('.sc-field input[type="password"]') && !dialogOpen, "Change key in the panel has no inline field");
		row("claude-key").querySelector('[data-action="cancel-key"]').click();
		row("claude-key").querySelector('[data-action="remove-key"]').click();
		check(await until(() => row("claude-key")?.classList.contains("todo") || /Add key/.test(row("claude-key")?.textContent || "")), "Remove key in the panel did not remove the key");
		window.crustOnboarding.close({ restore: false });
		await wait(200);
		await fake({ key: "reset" });
		await crust.claude.saveKey(GOOD); // the chat below needs no setup again
		await until(() => ui.state()?.ready);

		// 8. the pause card (the record the adapter sends at the spend limit)
		const rec = { type: "claude_paused", reason: "budget", message: "Stopped: the spending limit ($5.00) was reached. About $5.02 spent.", totalCostUsd: 5.02, limitUsd: 5, maxTurns: 100, sessionId: "stand-in-session", canContinue: true, continueLabel: "Continue" };
		withChat(made, () => handleRecord(rec));
		await wait(300);
		const pc = () => made.el.querySelector(".pause-card");
		check(pc() && made.el.lastElementChild === pc(), "the pause card is not at the end of the conversation");
		check(pc()?.querySelector(".pc-text")?.textContent === "This chat has used about $5.02. Continue for up to another $5.00?", `pause text: ${pc()?.querySelector(".pc-text")?.textContent}`);
		check([...pc().querySelectorAll("button")].map((b) => b.textContent).join() === "Continue,Change limit", "pause buttons");
		check(input.readOnly && input.placeholder === "Choose Continue to send a message" && send.dataset.reason === "Choose Continue to send a message", `pause gate: ${input.readOnly} "${input.placeholder}"`);
		await shots("pause");
		// Change limit: an invalid amount is refused, a valid one is a setting and continues
		pc().querySelector('[data-action="change-limit"]').click();
		await wait(150);
		const lim = pc().querySelector('input[type="number"]');
		check(lim && lim.value === "5", "the limit field does not start at the current limit");
		await shots("pause-limit");
		lim.value = "0.1";
		pc().querySelector("form").requestSubmit();
		check(await until(() => pc()?.querySelector(".pc-error")), "an invalid limit was accepted");
		pc().querySelector('input[type="number"]').value = "7.5";
		pc().querySelector("form").requestSubmit();
		check(await until(() => !pc() && !made.pause), "Save and continue did not close the pause card");
		check((await crust.claude.state()).limitUsd === 7.5, `limit setting: ${(await crust.claude.state()).limitUsd}`);
		check(await until(() => made.state.ready && !input.readOnly, 10000), "the chat did not come back after Change limit");
		// Continue with the same limit
		withChat(made, () => handleRecord({ ...rec, totalCostUsd: 7.51, limitUsd: 7.5 }));
		await wait(200);
		check(pc()?.querySelector(".pc-text")?.textContent === "This chat has used about $7.51. Continue for up to another $7.50?", `second pause text: ${pc()?.querySelector(".pc-text")?.textContent}`);
		pc().querySelector('[data-action="continue"]').click();
		check(await until(() => !pc() && !made.pause), "Continue did not close the pause card");
		check(await until(() => made.state.ready && !input.readOnly && input.placeholder.startsWith("Ask Claude Agent"), 10000), "the chat did not come back after Continue");
	} catch (e) {
		problems.push(`threw ${e && e.message}`);
	} finally {
		try {
			if (made && chats.has(made.id)) await closeChat(made);
		} catch {}
	}
	console.error(`SELFTEST claude-setup: setup card (both steps: to do, working, done, failed + retry, Cancel), disabled message box, card leaves, pause card (Continue, Change limit), Setup panel rows before and after${problems.length ? " -> MISMATCH: " + problems.join("; ") : " -> OK"}`);
}, "claude-setup");
