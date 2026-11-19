// Self-test step `viewer-agent`: the agent's tool show_in_viewer, from a chat to the Viewer and back (src/viewer-agent-main.js, src/viewer-agent.js,
// src/pi-viewer-tool.js, src/agents/claude/viewer-tool.js). Offscreen, no prompt, fresh data folders, no real Pi, no model, no key:
//   - Pi is the scripted stand-in scripts/viewer-agent-fake-pi.js. It plays a prompt "show: a | b" as tool calls and runs the REAL tool module and the REAL
//     shared permission decision, with a real extension_ui_request round trip to the app.
//   - Claude Agent is the stand-in SDK (scripts/claude-sdk-stand-in.mjs) with the fake key store and engine; its script makes the tool calls, each one
//     goes through the real PreToolUse hook and canUseTool, and the real handler of the app's in-process tool runs.
// The step drives the real UI (send, the tool cards, the Viewer tab bar and row) and the real IPC and tabs. The runner (scripts/viewer-agent-selftest.js)
// makes the throwaway repo, the outside folder and the scripts, and reads the stand-in SDK's gate log afterwards.
// Run: node scripts/viewer-agent-selftest.js [--shots <folder>] [--break <name>]
// Screenshots (light and dark): PI_CRUST_VA_SHOTDIR, named va-<what>-<theme>.png.
// Deliberate breaks (PI_CRUST_SELFTEST_VIEWER_BREAK=<name>), each of which must make the step report MISMATCH:
//   agent-host   a web address on any host is accepted      agent-path   a path is not checked against the project
//   agent-focus  the new page becomes the active tab        agent-reuse  a page already open gets a second tab
//   agent-limit  at 8 pages the active tab is replaced      agent-rate   the per-turn limit of new tabs is ignored
// Not covered here: a real Pi (the tool as the real Pi loads and validates it, the real extension protocol) and a real Claude engine; both need a real
// chat, which spends tokens (Pim's call). Nothing here shows a worktree chat (node test: scripts/viewer-agent.test.js).
"use strict";

selftestSteps.push(async ({ wait }) => {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push({ name, ok: !!ok });
		console.error(`SELFTEST viewer-agent ${name}: ${ok ? "OK" : "MISMATCH" + (detail === undefined ? "" : " (" + String(detail).slice(0, 400) + ")")}`);
	};
	const until = async (fn, ms = 8000, step = 50) => {
		for (let t = 0; t < ms; t += step) {
			try {
				if (await fn()) return true;
			} catch { /* not yet */ }
			await wait(step);
		}
		try { return !!(await fn()); } catch { return false; }
	};
	if (!info.selftestClaudeFake || !info.repo) {
		console.error("SELFTEST viewer-agent: needs the runner (scripts/viewer-agent-selftest.js: stand-in Pi and SDK) -> MISMATCH");
		return;
	}
	const B = crust.browser;
	const T = (op, extra = {}) => crust.selftest.viewerAgent({ op, ...extra });
	const R = {
		outside: "Only files inside this project can be shown here.",
		dot: "Files and folders that start with a dot are never shown here.",
		kind: "Only web pages (HTML), images and PDFs can be shown here.",
		missing: "No such file in this project.",
		scheme: "Only web addresses (http, https) and files in this project can be shown here.",
		limit: "8 pages is the most. Close one first.",
		host: "Only localhost addresses (localhost, 127.0.0.1 or [::1]) can be shown here.",
		rate: "Several new pages were already opened in this turn. Ask the person which one to look at.",
	};
	const PERM = /same permission as reading/;
	const badge = () => $("#viewer-badge");
	const tabs = async () => (await B.tabs());
	const cards = () => [...active.el.querySelectorAll(".tool")].filter((c) => c._toolName === "show_in_viewer" || c._toolName === "mcp__pi-crust__show_in_viewer");
	const cardInfo = (c) => ({ name: c.querySelector(".tname")?.textContent, arg: c.querySelector(".targ")?.textContent, err: c.classList.contains("err"), ok: c.classList.contains("ok"), text: c.querySelector("pre")?.textContent || "" });
	const askShown = () => !!$("#ask") && !$("#ask").hidden && $("#ask").getClientRects().length > 0;
	const send = async (text) => {
		$("#input").value = text;
		$("#input").focus();
		await submit();
	};
	// One turn: send, wait for it to finish and for `n` new tool cards to have a result.
	const turn = async (text, n, label) => {
		const before = cards().length;
		await send(text);
		const done = await until(() => cards().length >= before + n && cards().slice(before).every((c) => c.classList.contains("ok") || c.classList.contains("err")) && !active.turn, 20000, 50);
		check(`${label}: the turn finished with ${n} tool card(s)`, done, `${cards().length - before} cards, turn ${!!active.turn}`);
		return cards().slice(before).map(cardInfo);
	};
	const setModeTo = async (m) => {
		await setMode(m);
		return until(() => $("#perm-mode").dataset.mode === m, 8000);
	};
	const shot = async (what) => {
		const was = themeSetting();
		const out = [];
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await wait(350);
			out.push((await T("shot", { name: `va-${what}-${th}` })).ok);
		}
		setTheme(was);
		await wait(200);
		return out.every(Boolean);
	};
	const closeTabsDownTo = async (n) => {
		for (;;) {
			const l = await tabs();
			if (l.tabs.length <= n) return;
			await B.closeTab(l.tabs[l.tabs.length - 1].id);
		}
	};
	const closeMine = async (c) => {
		try {
			if (c && chats.has(c.id)) {
				const gone = closeChat(c);
				if (await until(() => vis($("#modal-backdrop")), 1500)) [...document.querySelectorAll("#modal .modal-actions button")].find((b) => b.textContent === "Close chat")?.click();
				await gone;
			}
		} catch { /* best effort */ }
	};
	const vis = (n) => !!n && n.isConnected && !n.hidden && n.getClientRects().length > 0;

	let S;
	let pi = null;
	let cl = null;
	const wasSelftest = info.selftest;
	const brk = info.selftestViewerBreak || "";
	try {
		await crust.health.stubSet({});
		S = await T("start");
		check("the project is the run's repo", S.root && S.root.toLowerCase() === info.repo.toLowerCase(), `${S.root} vs ${info.repo}`);
		// -------- Pi --------------------------------------------------------------------------------------------------------------------------
		await newChat(null, "Pi shows pages");
		pi = active;
		check("the Pi stand-in chat started", await until(() => pi.state.ready && !$("#input").readOnly, 20000));
		check("the permission selector follows the stand-in's status", await until(() => ["ask-commands", "plan", "ask-edits", "trusted"].includes($("#perm-mode").dataset.mode), 8000), $("#perm-mode").dataset.mode);
		await closeTabsDownTo(1);
		const first = (await tabs()).activeId;
		switchTab("editor");
		await wait(200);

		// 1. A file: a new tab in the background, the badge, the card, the focus.
		let r = await turn("show: docs/pricing.html", 1, "pi file");
		let l = await tabs();
		const shown = l.tabs.find((t) => /pricing\.html$/.test(t.address));
		check("pi file: one new tab", l.tabs.length === 2 && !!shown, JSON.stringify(l.tabs.map((t) => t.address)));
		check("pi file: the active tab did not change", l.activeId === first, `${l.activeId} vs ${first}`);
		check("pi file: the main tab in view did not change", activeTab === "editor");
		check("pi file: the focus stayed in the chat", document.activeElement === $("#input") || document.activeElement?.closest?.("#input-area, .composer, #chat-panel") !== null, document.activeElement && (document.activeElement.id || document.activeElement.tagName));
		check("pi file: the new tab is marked updated, the active one is not", !!shown && shown.updated === true && !l.tabs.find((t) => t.id === first).updated);
		const vs = await T("visible");
		check("pi file: no native view is visible while another app tab is in front", vs.visible.length === 0, JSON.stringify(vs.visible));
		check("pi file: the Viewer tab has a badge of 1", badge().textContent === "1" && badge().getClientRects().length > 0 && /1 new page/.test(badge().closest("button").getAttribute("aria-label") || ""), `${badge().textContent} / ${badge().closest("button").getAttribute("aria-label")}`);
		check("pi file: the tool card is named Viewer and names the file", r[0].name === "Viewer" && r[0].arg === "docs/pricing.html" && r[0].ok, JSON.stringify(r[0]));
		check("pi file: the tool's result names the file", /docs\/pricing\.html/.test(r[0].text) && /new background tab/.test(r[0].text), r[0].text);
		check("pi file: no question was asked", !askShown());
		const link = cards()[cards().length - 1].querySelector(".targ");
		check("pi file: the file name on the card is a link", link.classList.contains("tview") && link.getAttribute("role") === "button");
		if (!(await shot("badge"))) console.error("SELFTEST viewer-agent screenshots: badge not saved (PI_CRUST_VA_SHOTDIR not set?)");
		if (!(await shot("toolcard"))) console.error("SELFTEST viewer-agent screenshots: toolcard not saved");

		// 2. Clicking the card switches to that tab; the badge and the mark clear.
		link.click();
		check("pi card click: the Viewer is in front", await until(() => activeTab === "browser", 4000));
		l = await tabs();
		check("pi card click: the tab that shows the file is the active one", l.activeId === shown.id, `${l.activeId} vs ${shown.id}`);
		check("pi card click: the badge is gone", await until(() => badge().textContent === "" && badge().getClientRects().length === 0, 2000), badge().textContent);
		check("pi card click: the mark is gone", !l.tabs.find((t) => t.id === shown.id).updated && !document.querySelector("#vt-list .vt-item.updated"));
		await shot("tabrow");

		// 3. The same file again: no second tab; the tab that shows it is marked updated (it is not the active one now), and it gets the badge again.
		await B.activateTab(first);
		switchTab("editor");
		await wait(200);
		r = await turn("show: ./docs/../docs/pricing.html", 1, "pi reuse");
		l = await tabs();
		check("pi reuse: still two tabs", l.tabs.length === 2, l.tabs.length);
		check("pi reuse: the tab is marked updated again, the active tab is unchanged", l.tabs.find((t) => t.id === shown.id).updated === true && l.activeId === first);
		check("pi reuse: the result says so", /Already open/.test(r[0].text) && r[0].ok, r[0].text);
		check("pi reuse: the badge is back", badge().textContent === "1", badge().textContent);
		switchTab("browser");
		await until(() => badge().textContent === "");
		check("pi reuse: showing the Viewer clears the badge", badge().textContent === "");
		switchTab("editor");

		// 4. A localhost address in Plan: allowed, a new background tab.
		check("pi plan: switched to Plan", await setModeTo("plan"));
		r = await turn(`show: http://127.0.0.1:${S.port}/`, 1, "pi localhost in Plan");
		l = await tabs();
		check("pi plan: a localhost address opened in a new tab", l.tabs.length === 3 && !!l.tabs.find((t) => t.address.startsWith(`http://127.0.0.1:${S.port}`)) && r[0].ok, r[0].text);
		check("pi plan: the active tab is still the first", l.activeId === first);
		r = await turn("show: img/logo.svg", 1, "pi file in Plan");
		check("pi plan: a project file is allowed where a read is", r[0].ok && (await tabs()).tabs.length === 4, r[0].text);

		// 5. Refusals come back as the tool's result, in the address bar's words. Nothing opens, nothing is asked.
		const UNC = "\\\\server\\share\\a.html"; // two backslashes, then server\share\a.html
		const bad = [
			["../outside/secret.html", R.outside],
			[S.outside, R.outside],
			[".env", R.dot],
			["notes.txt", R.kind],
			["nope.html", R.missing],
			["http://example.com/", R.host],
			["http://localhost.evil.test:80/", R.host],
			["http://localhost@evil.test/", R.host],
			["file:///C:/Windows/win.ini", R.scheme],
			["pi-project://p-0000000000000000/index.html", R.scheme],
			[UNC, PERM],
		];
		const nBefore = (await tabs()).tabs.length;
		r = await turn(`show: ${bad.map((b) => b[0]).join(" | ")}`, bad.length, "pi refusals (Plan)");
		bad.forEach(([t, why], i) => check(`pi refusal ${JSON.stringify(t).slice(0, 40)}`, r[i] && r[i].err && (why instanceof RegExp ? why.test(r[i].text) : r[i].text === why), r[i] && `${r[i].err} ${r[i].text}`));
		check("pi refusals: no tab opened", (await tabs()).tabs.length === nBefore);
		check("pi refusals: no question was asked", !askShown());
		check("pi refusals: the badge did not grow", badge().textContent === "2" || badge().textContent === "1" || badge().textContent === "3", badge().textContent);
		for (const m of ["ask-commands", "ask-edits"]) {
			check(`pi ${m}: switched`, await setModeTo(m));
			r = await turn(`show: ${UNC}`, 1, `pi UNC in ${m}`);
			check(`pi ${m}: a network path is refused with the permission reason, never asked`, r[0].err && PERM.test(r[0].text) && !askShown(), r[0].text);
		}
		check("pi trusted: switched", await setModeTo("trusted"));
		r = await turn(`show: ${UNC}`, 1, "pi UNC in Trusted");
		check("pi trusted: the permission lets it through, the app still refuses it", r[0].err && r[0].text === R.outside, r[0].text);
		check("pi: Trusted does not widen the rules of the app", (await turn("show: .env | http://example.com/", 2, "pi Trusted refusals")).every((c, i) => c.err && c.text === [R.dot, R.host][i]));

		// 6. The rate: four new pages in one turn, the fourth is refused; a repeat is free; the next turn starts again.
		check("pi: back to Ask before commands", await setModeTo("ask-commands"));
		await closeTabsDownTo(1);
		r = await turn("show: many/page01.html | many/page02.html | many/page03.html | many/page04.html | many/page01.html", 5, "pi rate");
		check("pi rate: three new pages, the fourth refused with its reason, a repeat reuses", r.map((c) => c.ok).join() === "true,true,true,false,true" && r[3].text === R.rate, r.map((c) => c.ok + ":" + c.text.slice(0, 30)).join(" | "));
		check("pi rate: four tabs in all", (await tabs()).tabs.length === 4);
		r = await turn("show: many/page04.html", 1, "pi next turn");
		check("pi rate: the next turn opens a new page again", r[0].ok && !r[0].text.includes("Already") && (await tabs()).tabs.length === 5, r[0].text);

		// 7. The limit: 8 pages is the most, with the Viewer's own sentence; a page already open is still reachable.
		r = await turn("show: many/page05.html | many/page06.html | many/page07.html", 3, "pi to eight");
		check("pi limit: eight tabs", (await tabs()).tabs.length === 8 && r.every((c) => c.ok), r.map((c) => c.text.slice(0, 40)).join(" | "));
		const before8 = (await tabs());
		r = await turn("show: many/page08.html", 1, "pi at the limit");
		check("pi limit: the ninth page is refused with the Viewer's sentence", r[0].err && r[0].text === R.limit, r[0].text);
		check("pi limit: still eight tabs, the active tab was not replaced", (await tabs()).tabs.length === 8 && (await tabs()).activeId === before8.activeId && (await tabs()).tabs.every((t, i) => t.address === before8.tabs[i].address));
		r = await turn("show: many/page02.html", 1, "pi reuse at the limit");
		check("pi limit: a page that is open is still reachable", r[0].ok && /Already open/.test(r[0].text), r[0].text);
		await closeMine(pi);
		pi = null;

		// -------- Claude Agent ------------------------------------------------------------------------------------------------------------------
		await closeTabsDownTo(1);
		switchTab("editor");
		await newChat(null, "Claude shows pages", { agent: "claude" });
		cl = active;
		check("the Claude chat needs its setup", await until(() => cl.needsSetup));
		await crust.claude.fakeSet({ engine: "ready" });
		await crust.claude.saveKey("sk-ant-test-good-0000");
		check("the Claude chat started", await until(() => cl.state.ready && !cl.needsSetup && !$("#input").readOnly, 20000));
		check("claude: first mode", await until(() => $("#perm-mode").dataset.mode === "ask-commands", 8000), $("#perm-mode").dataset.mode);
		switchTab("browser"); // the person looks at the Viewer: the badge of the Pi pages goes, so the count below starts at 0
		await until(() => badge().textContent === "");
		switchTab("editor");
		const cFirst = (await tabs()).activeId;
		// the script (runner): img/logo.svg, 127.0.0.1:9, ../outside/secret.html, UNC, then in Plan: doc.pdf
		r = await turn("Show me the logo and the dev server.", 4, "claude turn 1");
		l = await tabs();
		check("claude: two new background tabs, the active tab unchanged", l.tabs.length === 3 && l.activeId === cFirst, `${l.tabs.length} tabs`);
		check("claude: the cards are named Viewer and name the targets", r.map((c) => c.name + ":" + c.arg).join("|") === ["img/logo.svg", "http://127.0.0.1:9/", "../outside/secret.html", UNC].map((x) => "Viewer:" + x).join("|"), r.map((c) => c.name + ":" + c.arg).join("|"));
		check("claude: file and address shown", r[0].ok && /img\/logo\.svg/.test(r[0].text) && r[1].ok, `${r[0].text} / ${r[1].text}`);
		check("claude: a path outside is refused by the app with the bar's words", r[2].err && r[2].text === R.outside, r[2].text);
		check("claude: a network path is refused by the gate with the permission reason, no question", r[3].err && PERM.test(r[3].text) && !askShown(), r[3].text);
		check("claude: the badge shows the two new pages", badge().textContent === "2", badge().textContent);
		cards()[cards().length - 4].querySelector(".targ").click();
		check("claude card click: the Viewer is in front on that tab", await until(async () => { const x = await tabs(); return activeTab === "browser" && !!x.tabs.find((t) => t.id === x.activeId && t.address.endsWith("logo.svg")); }, 4000));
		check("claude card click: the badge went", await until(() => badge().textContent === "", 2000));
		switchTab("editor");
		check("claude: switched to Plan", await setModeTo("plan"));
		r = await turn("Now the brochure, in Plan.", 1, "claude Plan");
		check("claude Plan: a project file is shown where a read is allowed", r[0].ok && (await tabs()).tabs.length === 4, r[0].text);
		await shot("claude-toolcard");
		await closeMine(cl);
		cl = null;
		for (const th of ["light"]) setTheme(th);
	} catch (e) {
		check("no exception", false, e && e.stack ? e.stack : e);
	} finally {
		info.selftest = wasSelftest;
		await closeMine(pi);
		await closeMine(cl);
		await closeTabsDownTo(1).catch(() => {});
		await T("stop").catch(() => {});
	}
	const bad = checks.filter((c) => !c.ok).length;
	console.error(`SELFTEST viewer-agent: ${checks.length} checks, ${bad ? bad + " MISMATCH" : "all OK"}`);
}, "viewer-agent");
