// What a chat's agent means for the UI (phase 7, T7 part A): the chip in the chat header, the mark on tabs, the mode list, and the
// controls the agent cannot use. Everything here reads the chat's capability data (`chat.agent.capabilities`, sent by main with
// pi:started from the adapter), never the agent's name. A capability that is missing (a restored chat that has not started yet)
// gates nothing: only an explicit `false` disables a control.
// Run alone with: npm run selftest -- agents
"use strict";

(() => {
	const DEFAULT_AGENT = "pi"; // tabs get a mark only for a chat of another agent: Pi tabs look as before
	const input = $("#input");
	const modeSel = $("#perm-mode");
	const chip = $("#agent-chip");
	const line = $("#reason-line");
	const placeholder0 = input.placeholder; // "Ask Pi…  (Enter to send, ...)"
	const modeOptions0 = [...modeSel.options].filter((o) => o.value).map((o) => ({ id: o.value, label: o.textContent }));

	const capsOf = (c) => (c && c.agent && c.agent.capabilities && typeof c.agent.capabilities === "object" ? c.agent.capabilities : {});
	const labelOf = (c) => (c && c.agent && c.agent.label) || "Pi";
	// true / false, or undefined when the chat has no capability data for it (nothing is gated then)
	const can = (key, c = active) => {
		const v = capsOf(c)[key];
		return typeof v === "boolean" ? v : undefined;
	};

	// Why a control is off, in a few words. {a} is the agent's label.
	const REASONS = {
		steering: "{a} runs your message after the current step.",
		fork: "Forking a chat is not available for {a} chats yet.",
		clone: "Cloning a chat is not available for {a} chats yet.",
		exportHtml: "Export as HTML is not available for {a} chats.",
		compact: "{a} compacts long chats by itself.",
		sessionStats: "Session statistics are not available for {a} chats.",
		sessionName: "Naming a chat is not available for {a} chats.",
	};
	// Built-in slash commands that need a capability.
	const SLASH = { fork: "fork", clone: "clone", export: "exportHtml", compact: "compact", session: "sessionStats", name: "sessionName" };

	const reason = (key, c = active) => (REASONS[key] || "Not available for {a} chats.").replace("{a}", labelOf(c));
	const slashReason = (name, c = active) => {
		const key = SLASH[name];
		return key && can(key, c) === false ? reason(key, c) : "";
	};
	const blocked = (key, c = active) => toast(reason(key, c), "warning");

	// Disabled, but still focusable and still explaining itself: aria-disabled (not `disabled`, which cannot take focus), the reason as
	// hover text and as the accessible description, and no click. The reason line under the chat shows it on focus.
	function describe(node, text) {
		node.setAttribute("aria-description", text);
	}
	function gate(node, key, c = active) {
		if (can(key, c) !== false) return node;
		const why = reason(key, c);
		node.setAttribute("aria-disabled", "true");
		node.classList.add("is-disabled");
		node.title = why;
		node.dataset.reason = why;
		describe(node, why);
		node.addEventListener(
			"click",
			(e) => {
				e.preventDefault();
				e.stopImmediatePropagation();
			},
			true,
		);
		return node;
	}
	// The reason of a disabled control, in the flow under the chat (it never covers anything). It shows only while the control is hovered or
	// has focus, and only while that control still exists: one that is replaced or removed (the steer button when the queue empties) takes it along.
	let hovered = null;
	const live = (n) => (n && n.isConnected && n.closest?.("[data-reason]") ? n.closest("[data-reason]") : null);
	function showReason() {
		// Only a control that is hovered or focused right now, or a menu row that is highlighted right now: nothing else keeps the line.
		const n = live(document.activeElement) || live(hovered) || live(document.querySelector("#slash-menu:not([hidden]) .pal-item.active"));
		const text = n ? n.dataset.reason : "";
		if (line.textContent !== (text || "")) line.textContent = text || ""; // only when it changes: the observer below watches this subtree
		if (line.hidden !== !text) line.hidden = !text;
	}
	document.addEventListener("focusin", showReason);
	document.addEventListener("focusout", () => setTimeout(showReason, 0));
	document.addEventListener("mouseover", (e) => {
		hovered = e.target?.closest?.("[data-reason]") || null;
		showReason();
	});
	document.addEventListener("mouseout", () => {
		hovered = null;
		showReason();
	});
	new MutationObserver(showReason).observe($("#queue"), { childList: true, subtree: true });
	new MutationObserver(showReason).observe($("#composer"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
	// An offscreen window sends no focus events, and typing moves focus without one: look again whenever the user types.
	for (const ev of ["input", "keydown", "keyup"]) document.addEventListener(ev, () => setTimeout(showReason, 0), true);

	const isDefault = (c = active) => !(c && c.agent && c.agent.id && c.agent.id !== DEFAULT_AGENT);
	// A chat of another agent that has not started (no key or engine yet): nothing can run, so no mode is enforced for a true reason.
	const notStarted = (c = active) => !isDefault(c) && !(c.state && c.state.ready);
	const modeNotActive = (c = active) => (isDefault(c) ? "" : notStarted(c) ? `Nothing can run yet: ${labelOf(c)} has not started (it needs its key and engine first)` : `${labelOf(c)} has not reported its permission mode yet, so nothing is shown as enforced`);
	const MODE_PLACEHOLDER = modeSel.options[0].textContent; // "Not enforced"
	// The selector's own "no mode" text and its reason, for the active chat. Uses the disabled-with-reason pattern (title, description, reason line).
	function syncModePlaceholder(c = active) {
		modeSel.options[0].textContent = notStarted(c) ? "Can't run yet" : MODE_PLACEHOLDER;
		if (modeSel.disabled && !modeSel.dataset.mode) {
			const why = modeNotActive(c);
			if (why) {
				modeSel.title = why;
				modeSel.dataset.reason = why;
				describe(modeSel, why);
			} else delete modeSel.dataset.reason;
		} else delete modeSel.dataset.reason;
	}
	// Pi's commands (the TUI-only ones, /reload, extensions) do not exist for another agent; each chat keeps the command list its own agent reported.
	const cmdStash = new Map();
	let cmdOwner = null;
	function syncCommands(c) {
		if (!c || (cmdOwner && cmdOwner.id === c.id)) return;
		if (cmdOwner) cmdStash.set(cmdOwner.id, commandList);
		const sameKind = !cmdOwner || isDefault(cmdOwner) === isDefault(c);
		commandList = cmdStash.get(c.id) || (sameKind ? commandList : []);
		cmdOwner = c;
	}

	// The mode list comes from the agent. An agent that gives none keeps the standard four (Pi's own list).
	function syncModes(c) {
		const list = capsOf(c).permissionModes;
		const want = Array.isArray(list) && list.length ? list.map((m) => ({ id: m.id, label: m.label })) : modeOptions0;
		const have = [...modeSel.options].filter((o) => o.value).map((o) => ({ id: o.value, label: o.textContent }));
		if (JSON.stringify(want) === JSON.stringify(have)) return;
		const first = modeSel.options[0]; // the "Not enforced" placeholder
		modeSel.replaceChildren(first, ...want.map((m) => Object.assign(el("option", "", m.label), { value: m.id })));
	}

	function sync(c = active) {
		if (!c) return;
		chip.textContent = labelOf(c);
		chip.dataset.agent = (c.agent && c.agent.id) || DEFAULT_AGENT;
		const other = !!(c.agent && c.agent.id && c.agent.id !== DEFAULT_AGENT);
		// A Claude Agent chat's chip is also the way to its key, engine and spend limit (the Setup pill is about Pi and hides once Pi is set up).
		// A Pi chat's chip stays a plain label.
		if (other) {
			chip.setAttribute("role", "button");
			chip.tabIndex = 0;
			chip.setAttribute("aria-label", `${labelOf(c)}: open setup for its key, engine and spend limit`);
			chip.title = `This chat runs on ${labelOf(c)}. Click to open its setup (key, engine, spend limit).`;
		} else {
			chip.removeAttribute("role");
			chip.removeAttribute("tabindex");
			chip.removeAttribute("aria-label");
			chip.title = `This chat runs on ${labelOf(c)}`;
		}
		input.placeholder = c.agent && c.agent.id && c.agent.id !== DEFAULT_AGENT ? placeholder0.replace(/^Ask Pi/, `Ask ${labelOf(c)}`) : placeholder0;
		syncModes(c);
		syncCommands(c);
		$("#ask").setAttribute("aria-label", `${labelOf(c)} asks`);
		syncModePlaceholder(c);
		window.claudeSetupUi?.syncComposer(c); // setup or pause: the message box disabled with its reason
		showReason();
	}

	function tabMark(c) {
		if (!c || !c.agent || !c.agent.id || c.agent.id === DEFAULT_AGENT) return null;
		const m = el("span", "ct-agent");
		m.setAttribute("role", "img");
		m.setAttribute("aria-label", c.agent.label);
		m.title = c.agent.label;
		m.innerHTML = '<svg viewBox="0 0 8 8" aria-hidden="true" fill="currentColor"><path d="M4 0.6L7.4 4 4 7.4 0.6 4z"/></svg>'; // a small filled diamond, drawn (no font glyph)
		return m;
	}

	const openAgentSetup = () => {
		if (chip.getAttribute("role") !== "button") return;
		window.dispatchEvent(new CustomEvent("crust:open-setup", { detail: { source: "agent-chip", rows: "claude" } }));
	};
	chip.addEventListener("click", openAgentSetup);
	chip.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		openAgentSetup();
	});

	window.agentUi = { isDefault, syncModePlaceholder, label: labelOf, can, reason, slashReason, blocked, gate, describe, modeNotActive, sync, tabMark };

	// --- self-test: the agents step --------------------------------------------------------------------------------------------------
	// A Pi chat's header and controls, a Claude Agent chat's chip, tab mark and disabled controls with their reasons, and the open
	// new-chat menu; screenshots in light and dark. No prompt is sent. The Claude Agent chat does not need to become ready: everything
	// here follows from the capability data that arrives when the chat starts.
	selftestSteps.push(async ({ snap, wait }) => {
		const problems = [];
		const check = (ok, what) => ok || problems.push(what);
		const vis = (n) => !!n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
		const slashNames = () => [...$("#slash-menu").querySelectorAll(".pal-item")].map((r) => ({ name: r.querySelector(".slash-name")?.textContent, off: r.getAttribute("aria-disabled") === "true", title: r.title, desc: r.querySelector(".desc")?.textContent, badge: r.querySelector(".slash-badge")?.textContent }));
		const typeInto = (t) => {
			input.focus();
			input.value = t;
			input.setSelectionRange(t.length, t.length);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		};
		const shots = async (name) => {
			const was = themeSetting();
			for (const th of ["light", "dark"]) {
				setTheme(th);
				await wait(350);
				await snap(`agents-${name}-${th}-v2`);
			}
			setTheme(was);
			await wait(200);
		};
		const piChat = active;
			const tabsRow = async (name) => {
				// the tab row alone, at 2x, in both themes
				const was = themeSetting();
				for (const th of ["light", "dark"]) {
					setTheme(th);
					await wait(350);
					const r = $("#chat-tabs").getBoundingClientRect();
					await crust.selftest.capture(`agents-${name}-${th}-v2`, { x: r.left, y: r.top - 2, width: r.width, height: r.height + 4, scale: 2 });
				}
				setTheme(was);
				await wait(200);
			};
			const piModeText = modeSel.options[0].textContent;
			const piPlaceholder = input.placeholder;
		const REASON_OF = { steering: "Claude Agent runs your message after the current step." };
		let made = null;
		try {
			// 1. a Pi chat
			check(piChat && piChat.agent && piChat.agent.id === "pi", "the first chat is not a Pi chat");
			sync(piChat);
			check(chip.textContent === "Pi" && vis(chip), `Pi chip reads "${chip.textContent}"`);
			check(!document.querySelector(".chat-tab .ct-agent"), "a Pi tab has an agent mark");
			check([...modeSel.options].filter((o) => o.value).map((o) => o.value).join() === "plan,ask-edits,ask-commands,trusted", "Pi mode list is not the four modes");
			check(!document.querySelector("[aria-disabled=true]"), "a Pi chat has a disabled control");
			check(agentLabel(piChat) === "Pi" && input.placeholder === "Ask Pi…  (Enter to send, Shift+Enter for a new line)" && $("#ask").getAttribute("aria-label") === "Pi asks", "a Pi chat's texts changed");
			check(piModeText === "Not enforced", `Pi mode placeholder "${piModeText}"`);
			check(vis(line) === false, "the reason line shows in a Pi chat");
			// stand-ins for commands a Pi chat has: Pi extensions must not follow the user into a Claude Agent chat
			commandList = [{ name: "advisor", description: "Advisor tool", source: "extension" }, { name: "crust-mode", description: "Set the permission mode", source: "extension" }];
			typeInto("/");
			await wait(250);
			const piSlash = slashNames();
			check(["fork", "clone", "export", "compact"].every((n) => piSlash.find((r) => r.name === `/${n}`) && !piSlash.find((r) => r.name === `/${n}`).off), "a slash command is disabled in a Pi chat");
			check(piSlash.some((r) => r.name === "/bug" && /terminal Pi only/.test(r.desc || "")), "a Pi chat lost its terminal-only commands");
			typeInto("");
			check(!document.querySelector("#queue .q-steer"), "a steer control exists with nothing queued");
			piChat.state.queue = { steering: [], followUp: ["queued note"] };
			renderQueue();
			const piSteer = document.querySelector("#queue .q-steer");
			check(piSteer && piSteer.getAttribute("aria-disabled") !== "true", "Steer is disabled in a Pi chat");
			piChat.state.queue = { steering: [], followUp: [] };
			renderQueue();
			await shots("pi-chat");

			// 2. a Claude Agent chat
			await newChat(null, "agent test", { agent: "claude" });
			made = active;
			for (let i = 0; i < 40 && !(made && made.agent && made.agent.capabilities && "steering" in made.agent.capabilities && made.agent.label === "Claude Agent"); i++) await wait(250);
			check(made && made !== piChat && made.agent && made.agent.id === "claude", "no Claude Agent chat was made");
			check(made && made.agent && made.agent.capabilities && "steering" in made.agent.capabilities, "the chat has no capability data");
			sync(made);
			renderTabs();
			check(chip.textContent === "Claude Agent" && vis(chip), `Claude chip reads "${chip.textContent}"`);
			// The repo's own commit subjects (the test repo is the app's checkout) are the project's text, not the app's: left out.
			const graph = document.querySelector("#graph");
			const shown = graph ? graph.style.display : "";
			if (graph) graph.style.display = "none";
			const screenText = document.body.innerText;
			if (graph) graph.style.display = shown;
			check(!/claude code/i.test(screenText), "the words Claude Code are on screen: " + (screenText.match(/.{0,60}claude code.{0,60}/i) || [""])[0]);
				// 2. every text that names this chat's agent uses its label
				check(agentLabel({ agent: { id: "claude", label: "claude" } }) === "Claude Agent", "an unstarted Claude chat's label is the raw id");
				check(!/Starting/.test($("#status-line").textContent) && !/Pi/.test($("#status-line").textContent), `status line: "${$("#status-line").textContent}"`);
				check($("#ask").getAttribute("aria-label") === "Claude Agent asks", "the ask region still says Pi");
				const paneText = $("#chat-pane").innerText + " " + [...$("#chat-pane").querySelectorAll("[title],[aria-label],[placeholder]")].map((n) => [n.title, n.getAttribute("aria-label"), n.getAttribute("placeholder")].join(" ")).join(" ");
				const piWords = (paneText.match(/.{0,20}Pi.{0,20}/g) || []).filter((t) => !/Pi Crust/.test(t));
				check(piWords.length === 0, `"Pi" in a Claude Agent chat: ${piWords.join(" | ")}`);
				check(!/Pi/.test(String(window.agentUi.modeNotActive(made))), "the mode reason says Pi");
				// 1. the tab mark: a small drawn diamond before the title, quiet, centred on the title's text
				const mk = document.querySelector(".chat-tab .ct-agent");
				if (mk) {
					const lab = mk.parentElement.querySelector(".ct-label");
					const mr = mk.getBoundingClientRect();
					const lr = lab.getBoundingClientRect();
					const range = document.createRange();
					range.selectNodeContents(lab);
					const tr = range.getBoundingClientRect(); // the text itself, not the label box
					check(mk.textContent === "" && mk.querySelector("svg path") && !mk.querySelector("text"), "the tab mark is not a drawn shape");
					check(mr.width > 0 && mr.width <= 8 && mr.height <= 8 && Math.abs(mr.width - mr.height) < 0.5, `tab mark size ${mr.width}x${mr.height}`);
					check(mk.compareDocumentPosition(lab) & Node.DOCUMENT_POSITION_FOLLOWING && mr.right <= lr.left + 0.5, "the tab mark is not before the title");
					check(Math.abs((mr.top + mr.bottom) / 2 - (tr.top + tr.bottom) / 2) <= 1.5, `tab mark centre ${(mr.top + mr.bottom) / 2} vs text centre ${(tr.top + tr.bottom) / 2}`);
					check(getComputedStyle(mk).color !== getComputedStyle(chip).color && getComputedStyle(mk).color === getComputedStyle(document.querySelector(".chat-tab:not([aria-selected=true])") || mk).color, "the tab mark is not the quiet colour");
					const box = mk.getBoundingClientRect();
					check(!document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).some((n) => n.matches?.(".toast,.wt-menu")), "something covers the tab mark");
				}
				check(!vis(line), "the reason line shows in an idle, empty Claude Agent chat");
				check(!document.querySelector("#queue .q-steer"), "a steer control exists with nothing queued");
				await tabsRow("tab-row");
			const marks = [...document.querySelectorAll(".chat-tab .ct-agent")];
			check(marks.length === 1 && marks[0].getAttribute("aria-label") === "Claude Agent" && marks[0].closest(".chat-tab")?.getAttribute("aria-selected") === "true", `tab marks: ${marks.length}`);
			check(input.placeholder === "Finish setup to send a message" && input.readOnly, `the message box of a chat not yet set up: "${input.placeholder}"`);
			check(!made.state.ready, "the Claude chat is ready: the not-started checks below do not apply");
			const modes = [...modeSel.options].filter((o) => o.value).map((o) => o.value).join();
			check(modes === "plan,ask-edits,ask-commands,trusted", `Claude mode list: ${modes}`);
			check(modeSel.disabled && modeSel.title.startsWith("Nothing can run yet") && modeSel.dataset.reason === modeSel.title && modeSel.getAttribute("aria-description") === modeSel.title, `mode selector reason: ${modeSel.title}`);
			check(modeSel.selectedOptions[0].textContent === "Can't run yet" && !/Not enforced/.test(modeSel.selectedOptions[0].textContent), `mode selector shows "${modeSel.selectedOptions[0].textContent}"`);
			// the disabled controls and their reasons
			made.state.queue = { steering: [], followUp: ["queued note"] };
			renderQueue();
			const steer = document.querySelector("#queue .q-steer");
			check(steer && steer.getAttribute("aria-disabled") === "true" && steer.title === REASON_OF.steering && steer.getAttribute("aria-description") === REASON_OF.steering, `Steer: ${steer?.title}`);
			steer?.focus();
			steer?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); // an offscreen window is never the focused one, so the browser may not send it
			await wait(100);
			check(vis(line) && line.textContent === REASON_OF.steering, "focus on Steer shows no reason");
			// 3. a reason shows only while its control is hovered or focused, and goes with the control
			steer?.blur();
			steer?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); // as above: an offscreen window may not send it
			await wait(60);
			check(!vis(line), "the reason stays after focus left Steer");
			steer?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			check(vis(line) && line.textContent === REASON_OF.steering, "hovering Steer shows no reason");
			await shots("hover-reason");
			steer?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
			check(!vis(line), "the reason stays after the pointer left Steer");
			steer?.focus();
			steer?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
			check(vis(line), "focus on Steer shows no reason (again)");
			steer?.click();
			// 4. the commands this chat's agent reported (what get_commands answers once it runs), next to the app's own
			commandList = [{ name: "review", description: "Review the changes", source: "claude" }];
			typeInto("/");
			await wait(250);
			const rows = slashNames();
			const want = { "/clone": "Cloning a chat is not available for Claude Agent chats yet.", "/export": "Export as HTML is not available for Claude Agent chats.", "/compact": "Claude Agent compacts long chats by itself.", "/session": "Session statistics are not available for Claude Agent chats.", "/name": "Naming a chat is not available for Claude Agent chats." };
			const forkRow = rows.find((x) => x.name === "/fork");
			check(forkRow && !forkRow.off, `/fork in a Claude Agent chat: ${forkRow ? forkRow.title : "missing"}`); // phase 7: fork is available (a new tab)
			for (const [n, why] of Object.entries(want)) {
				const r = rows.find((x) => x.name === n);
				check(r && r.off && r.title === why && r.desc === why, `${n}: ${r ? `${r.off} ${r.title}` : "missing"}`);
			}
			check(rows.filter((r) => r.off).length === Object.keys(want).length, `disabled slash rows: ${rows.filter((r) => r.off).map((r) => r.name)}`);
			const names = rows.map((r) => r.name);
			const piOnly = ["/advisor", "/crust-mode", "/bug", "/changelog", "/hotkeys", "/reload", "/settings", "/login", "/logout", "/tree", "/share", "/trust"];
			check(!piOnly.some((n) => names.includes(n)), `Pi-only commands in a Claude Agent chat: ${piOnly.filter((n) => names.includes(n))}`);
			check(!rows.some((r) => /terminal Pi only|extension/i.test(r.desc || "") || r.badge === "extension"), "a Pi command or extension row is listed");
			check(rows.every((r) => r.badge === "crust" || r.badge === "claude"), `slash badges: ${[...new Set(rows.map((r) => r.badge))]}`);
			const review = rows.find((r) => r.name === "/review");
			check(review && !review.off && review.badge === "claude", "the command the adapter reported is not listed");
			check(["/model", "/copy", "/new", "/setup"].every((n) => names.includes(n)), "an app command that works for Claude Agent is missing");
			const enabled = rows.find((r) => r.name === "/model");
			check(enabled && !enabled.off, "/model is disabled");
			// (a) with the menu open and nothing hovered, the reason line is empty
			check(!vis(line) && line.textContent === "", `reason line with the slash menu open: "${line.textContent}"`);
			// (b) the first highlighted row is the first available one; the arrow keys skip disabled rows
			const hiName = () => document.querySelector("#slash-menu .pal-item.active .slash-name")?.textContent;
			const key = (k) => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
			const firstOn = rows.find((r) => !r.off)?.name;
			const lastOn = [...rows].reverse().find((r) => !r.off)?.name;
			check(rows[0].off && hiName() === firstOn && document.querySelector("#slash-menu .pal-item.active")?.getAttribute("aria-disabled") !== "true", `highlighted: ${hiName()}, first available: ${firstOn}`);
			key("ArrowUp");
			check(hiName() === lastOn, `ArrowUp from the first available row went to ${hiName()}, not ${lastOn}`);
			key("ArrowDown");
			check(hiName() === firstOn, `ArrowDown went to ${hiName()}, not ${firstOn}`);
			for (let i = 0; i < rows.length + 2; i++) {
				key("ArrowDown");
				if (document.querySelector("#slash-menu .pal-item.active")?.getAttribute("aria-disabled") === "true") {
					check(false, `an arrow key highlighted the disabled row ${hiName()}`);
					break;
				}
			}
			// (c) the disabled mode selector looks the same in both themes: faded, no dashed outline
			{
				const was = themeSetting();
				for (const th of ["light", "dark"]) {
					setTheme(th);
					await wait(250);
					const cs = getComputedStyle(modeSel);
					check(modeSel.disabled && cs.borderTopStyle !== "dashed" && Math.abs(Number(cs.opacity) - 0.45) < 0.02, `disabled mode selector (${th}): border ${cs.borderTopStyle}, opacity ${cs.opacity}`);
				}
				setTheme(was);
				await wait(200);
			}
			// the gap between the open slash menu (and the @ menu) and the message box: at least 6px
			{
				const was = themeSetting();
				const gapOf = (menu) => $("#composer").getBoundingClientRect().top - menu.getBoundingClientRect().bottom;
				const sm = $("#slash-menu");
				check(vis(sm) && gapOf(sm) >= 6, `gap between the slash menu and the message box: ${gapOf(sm)}px`);
				for (const th of ["light", "dark"]) {
					setTheme(th);
					await wait(300);
					const m = sm.getBoundingClientRect();
					const c = $("#composer").getBoundingClientRect();
					await crust.selftest.capture(`slash-gap-${th}`, { x: Math.max(0, c.left - 4), y: Math.max(0, m.bottom - 56), width: Math.min(c.width + 8, 560), height: c.top - m.bottom + 56 + 44, scale: 2 });
				}
				setTheme(was);
				await wait(200);
				typeInto("@");
				await wait(500);
				const mm = document.querySelector(".mention-menu");
				if (vis(mm)) check(gapOf(mm) >= 6, `gap between the @ menu and the message box: ${gapOf(mm)}px`);
				typeInto("/");
				await wait(250);
			}
			console.error(`SELFTEST agents disabled: ${[...Object.entries(want), ["Steer (queue)", REASON_OF.steering], ["Mode selector until the agent reports", modeSel.title]].map(([k, v]) => `${k} = ${v}`).join(" | ")}`);
			// the model popover has no Pi-only panels
			openContextPanel();
			await wait(500);
			check(!$("#ctx-panel").querySelector(".subs-list") && !/Subscriptions/.test($("#ctx-panel").textContent), "the Subscriptions panel is present for Claude Agent");
			const copilotSeg = document.querySelector('#ctx-meter [data-seg="copilot"]');
			check(!copilotSeg || copilotSeg.hidden, "the Copilot meter is shown for Claude Agent");
			closeContextPanel();
			typeInto("/");
			await wait(250);
			await shots("claude-chat");
			await shots("slash-menu");
			typeInto("");
			steer?.focus();
			made.state.queue = { steering: [], followUp: [] };
			renderQueue();
			await wait(60);
			check(!document.querySelector("#queue .q-steer") && !vis(line), "the reason is still shown after the message left the queue");

			// 3. the new-chat menu
			const btn = $("#new-chat-menu");
			btn.click();
			await wait(300);
			const menu = document.querySelector(".wt-menu:not(.view-menu):not(.remote-menu)");
			const items = menu ? [...menu.querySelectorAll("[role=menuitem]")].map((b) => b.querySelector(".label")?.textContent) : [];
			check(items.slice(0, 2).join() === "Pi,Claude Agent", `menu items: ${items}`);
			check(btn.getAttribute("aria-expanded") === "true" && menu && getComputedStyle(menu).zIndex === getComputedStyle(document.documentElement).getPropertyValue("--layer-popover").trim(), "the menu is not on the popover layer");
			check(document.activeElement === menu?.querySelector("[role=menuitem]"), "the first item has no focus");
			document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
			check(document.activeElement?.querySelector(".label")?.textContent === "Claude Agent", "ArrowDown did not move to Claude Agent");
			await shots("new-chat-menu");
			dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await wait(150);
			check(!document.querySelector(".wt-menu") && btn.getAttribute("aria-expanded") === "false" && document.activeElement === btn, "Escape did not close the menu and return focus");
			btn.click();
			await wait(200);
			document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			await wait(150);
			check(!document.querySelector(".wt-menu"), "a click outside did not close the menu");
			// the plain button still starts a Pi chat
			const before = chats.size;
			$("#new-chat").click();
			for (let i = 0; i < 40 && chats.size === before; i++) await wait(250);
			const fresh = active;
			check(chats.size === before + 1 && fresh.agent?.id === "pi", `the plain New chat made a ${fresh?.agent?.id} chat`);
			sync(fresh);
			check(chip.textContent === "Pi", "the chip did not go back to Pi");
			if (fresh && fresh !== made) await closeChat(fresh);
		} catch (e) {
			problems.push(`threw ${e && e.message}`);
		} finally {
			if (made && chats.has(made.id)) await closeChat(made);
			if (piChat && chats.has(piChat.id)) activate(piChat);
		}
		console.error(`SELFTEST agents: Pi chat (chip, no mark, 4 modes, nothing disabled), Claude Agent chat (chip, mark, 4 modes, disabled controls with reasons, no Pi-only panels), new-chat menu${problems.length ? " -> MISMATCH: " + problems.join("; ") : " -> OK"}`);
	}, "agents");
})();
