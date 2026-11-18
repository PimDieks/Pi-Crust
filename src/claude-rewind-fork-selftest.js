// Self-test step `claude-rewind-fork`: a Claude Agent chat's Rewind (the same snapshots as a Pi chat's, plus the conversation going back in the
// same tab) and Fork (a new tab named "Fork of <title>"). Offscreen, no prompt, the stand-in SDK, the fake key store and engine, a temporary git
// repo and a temporary user-data folder: no real key, engine, model or repo is touched. Screenshots in light and dark of the rewind offer, the
// result and the forked tab.
// Run it with: node scripts/claude-rewind-fork-selftest.js [--shots <folder>]   (sets up the repo, script and environment, and checks the SDK log)
// Negative control: PI_CRUST_SELFTEST_CLAUDE_BREAK=1 makes one expectation wrong on purpose and the step must report MISMATCH.
"use strict";

selftestSteps.push(async ({ snap, wait }) => {
	const problems = [];
	const check = (ok, what) => ok || problems.push(what);
	const vis = (n) => !!n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
	const until = async (fn, ms = 10000) => {
		for (let t = 0; t < ms; t += 100) {
			try {
				if (fn()) return true;
			} catch {}
			await wait(100);
		}
		return false;
	};
	if (!info.selftestClaudeFake) {
		console.error("SELFTEST claude-rewind-fork: needs PI_CRUST_SELFTEST_CLAUDE=fake and PI_CRUST_CLAUDE_SDK (stand-in) -> MISMATCH");
		return;
	}
	const GOOD = "sk-ant-test-good-0000";
	const MSG1 = "Read notes.txt and tell me what it says.";
	const MSG2 = "Now make a file with a shell command and change notes.txt again.";
	const shots = async (name) => {
		const was = themeSetting();
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await wait(350);
			await snap(`claude-rewind-fork-${name}-${th}`);
		}
		setTheme(was);
		await wait(200);
	};
	const users = (c) => [...c.el.querySelectorAll(".msg.user")];
	const read = async (f) => {
		const r = await crust.fs.read(f);
		return r && typeof r.content === "string" ? r.content : null;
	};
	const settled = (c, n) => !c.turn && users(c).length >= n && c.el.querySelectorAll(".msg.assistant-turn").length >= n;
	const send = async (c, text) => {
		const n = users(c).length + 1;
		$("#input").value = text;
		await submit();
		return until(() => settled(c, n), 15000);
	};
	const answerDialog = async (label) => {
		const b = [...document.querySelectorAll("#modal .modal-actions button, #modal .options button")].find((x) => x.textContent === label);
		b?.click();
		return !!b;
	};
	let made = null;
	let fork = null;
	try {
		// 0. a Claude Agent chat that is set up (fake key and engine) and has two turns, each with its own snapshot
		await crust.health.stubSet({});
		await newChat(null, "Rewind test", { agent: "claude" });
		made = active;
		check(await until(() => made.needsSetup), "no setup card");
		await crust.claude.fakeSet({ engine: "ready" });
		await crust.claude.saveKey(GOOD);
		check(await until(() => made.state.ready && !made.needsSetup && !$("#input").readOnly, 15000), "the Claude chat did not start, or its setup card is still there");
		check(made.agent?.capabilities?.conversationRewind === true && made.agent?.capabilities?.fork === true && made.agent?.capabilities?.clone === false, `capabilities: ${JSON.stringify(made.agent?.capabilities)}`);
		check(await send(made, MSG1), "turn 1 did not finish");
		check(await until(() => !!users(made)[0]?.dataset.cp), "the first message has no snapshot");
		await crust.fs.write("notes.txt", "base\none\n"); // what the agent's Edit did in turn 1
		check(await send(made, MSG2), "turn 2 did not finish");
		check(await until(() => !!users(made)[1]?.dataset.cp), "the second message has no snapshot");
		// what the agent did in turn 2: a file made by a shell command, and an edit (written here: the stand-in runs no tools)
		await crust.fs.write("made-by-shell.txt", "from a shell command\n");
		await crust.fs.write("notes.txt", "base\none\ntwo\n");
		const uuids = users(made).map((n) => n._uuid);
		check(uuids.length === 2 && uuids.every((u) => /^[0-9a-f-]{36}$/.test(u || "")) && uuids[0] !== uuids[1], `the messages have no uuids: ${uuids}`);
		check(typeof made.sessionFile === "string" && made.sessionFile.length > 0, `the chat has no session id: ${made.sessionFile}`);
		await wait(300);

		// 1. Fork from the end: a new tab named "Fork of <title>", a Claude Agent chat, with what is so far; the original stays
		const tabsBefore = chats.size;
		const forkDone = forkChat();
		check(await until(() => document.querySelector("#modal .options button")), "no fork dialog");
		const forkOptions = [...document.querySelectorAll("#modal .options button")].map((b) => b.textContent);
		check(forkOptions[0] === "End of the chat: keep everything so far" && forkOptions.length === 3, `fork options: ${forkOptions}`);
		check(/new tab/.test($("#modal").textContent), "the fork dialog does not say it opens a new tab");
		await snap("claude-rewind-fork-fork-dialog");
		await answerDialog(forkOptions[0]);
		await forkDone;
		check(await until(() => chats.size === tabsBefore + 1 && active !== made), "no new tab");
		fork = active;
		check(fork && fork.agent?.id === "claude", `the fork is a ${fork?.agent?.id} chat`);
		const parentName = made.name || made.label;
		check(parentName === MSG1 && fork.label === `Fork of ${MSG1}` && chatLabel(fork) === `Fork of ${MSG1}`.slice(0, 40), `the fork's tab is "${chatLabel(fork)}" (label "${fork.label}"), the chat is "${parentName}"`);
		check(await until(() => fork.state.ready, 15000), "the fork did not start");
		check(await until(() => users(fork).length === 2, 8000), `the fork shows ${users(fork).length} messages, not the 2 so far`);
		check(users(made).length === 2 && made.el.querySelectorAll(".msg.assistant-turn").length >= 2, "the original chat changed");
		check(document.querySelectorAll(".chat-tab .ct-agent").length === 2, "the fork's tab has no Claude Agent mark");

		check(!$("#input").value, "the message box of a fork from the end is not empty");
		await shots("forked-tab");
		const tabText = [...document.querySelectorAll(".chat-tab .ct-label")].map((n) => n.textContent);
		check(tabText.includes(chatLabel(fork)) && tabText.length === 3, `tabs: ${tabText}`);

		// 2. Back in the first chat: the rewind offer for message 2 (files and conversation, with the note about the saved conversation)
		activate(made);
		await wait(300);
		const node2 = users(made)[1];
		node2.querySelector(".user-actions").style.opacity = "1"; // stands in for :hover
		node2.querySelector(".msg-rewind").click();
		check(await until(() => document.querySelector("#modal .rw-opt")), "no rewind dialog");
		await wait(500);
		const optTexts = [...document.querySelectorAll("#modal .rw-opt")].map((n) => n.textContent);
		const boxes = [...document.querySelectorAll("#modal .rw-opt input")];
		check(/Restore the files \(2 changed since\)/.test(optTexts[0] || ""), `files option: ${optTexts[0]}`);
		check(/Conversation: continue from here/.test(optTexts[1] || ""), `conversation option: ${optTexts[1]}`);
		check(boxes.length === 2 && boxes.every((b) => b.checked && !b.disabled), "the files and conversation options are not both on and enabled");
		const rows = [...document.querySelectorAll("#modal .rw-file")].map((n) => n.textContent.replace(/\s+/g, " ").trim());
		check(rows.length === 2 && rows.some((r) => /made-by-shell\.txt/.test(r) && /DEL/.test(r)) && rows.some((r) => /notes\.txt/.test(r) && /MOD/.test(r)), `files listed: ${JSON.stringify(rows)}`);
		const note = document.querySelector("#modal .rw-note")?.textContent || "";
		check(/only in this tab until you send your next message/.test(note) && /reopens as it was before the rewind/.test(note), `the note about the saved conversation: "${note}"`);
		check(!/\bPi\b/.test(note.replace(/Pi Crust/g, "")), "the note says Pi");
		check(vis(document.querySelector("#modal .rw-note")) && document.elementsFromPoint(...(() => { const r = document.querySelector("#modal .rw-note").getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })())[0].closest(".rw-note"), "the note is covered");
		await shots("rewind-offer");
		node2.querySelector(".user-actions").style.opacity = "";

		// 3. Rewind: the files go back to before message 2, the conversation to the end of turn 1, in the same tab, the message back in the box
		const go = [...document.querySelectorAll("#modal .modal-actions button")].find((b) => b.textContent === "Rewind");
		check(!!go && !go.disabled, "no Rewind button");
		go?.click();
		check(await until(() => made.el.querySelector(".msg.notice")?.textContent.includes("Rewound"), 12000), "no 'Rewound' notice");
		await wait(400);
		check(users(made).length === 1 && users(made)[0].textContent.includes(MSG1), `the chat shows ${users(made).length} messages after the rewind`);
		check((await read("notes.txt")) === "base\none\n", `notes.txt after the rewind: ${JSON.stringify(await read("notes.txt"))}`);
		check((await crust.fs.stat("made-by-shell.txt")).exists === false, "the file the shell command made is still there");
		check(chats.has(made.id) && active === made && made.state.ready && !made.dead, "the chat was replaced or stopped by the rewind");
		check($("#input").value === MSG2, `the message box after the rewind: "${$("#input").value}"`);
		const said = made.el.querySelector(".msg.notice")?.textContent || "";
		check(/only in this tab until you send your next message/.test(said), `the notice after the rewind: "${said}"`);
		check(await until(() => document.querySelector("#toasts .toast")?.textContent.includes("Restored")), "no 'Restored' toast with Undo");
		check(fork.label === `Fork of ${MSG1}` && users(fork).length === 2, "the fork changed with the rewind");
		await shots("rewind-result");
		check(!document.querySelector("#modal-backdrop:not([hidden])"), "a dialog is still open");
		// the original has the other tab's copy in the history picker's list under its own name; nothing else to check here
		if (info.selftestClaudeBreak) check(false, "negative control: this expectation is wrong on purpose");
	} catch (e) {
		problems.push(`threw ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e}`);
	} finally {
		try {
			for (const c of [fork, made]) if (c && chats.has(c.id)) await closeChat(c);
		} catch {}
	}
	console.error(`SELFTEST claude-rewind-fork: Claude Agent chat with two turns, fork from the end in a new tab ("Fork of ..."), the rewind offer (files and conversation, saved-conversation note), the rewind (files back, conversation back in the same tab, message in the box), light and dark${problems.length ? " -> MISMATCH: " + problems.join("; ") : " -> OK"}`);
}, "claude-rewind-fork");
