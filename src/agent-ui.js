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
	// The reason of a focused disabled control, in the flow under the chat (it never covers anything).
	function showReason(text) {
		line.textContent = text || "";
		line.hidden = !text;
	}
	document.addEventListener("focusin", (e) => showReason(e.target?.closest?.("[data-reason]")?.dataset.reason));
	document.addEventListener("focusout", () => showReason(""));

	const modeNotActive = (c = active) => (c && c.agent && c.agent.id && c.agent.id !== DEFAULT_AGENT ? `${labelOf(c)} has not reported its permission mode yet, so nothing is shown as enforced` : "");

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
		chip.title = `This chat runs on ${labelOf(c)}`;
		input.placeholder = c.agent && c.agent.id && c.agent.id !== DEFAULT_AGENT ? placeholder0.replace(/^Ask Pi/, `Ask ${labelOf(c)}`) : placeholder0;
		syncModes(c);
		showReason("");
	}

	function tabMark(c) {
		if (!c || !c.agent || !c.agent.id || c.agent.id === DEFAULT_AGENT) return null;
		const m = el("span", "ct-agent");
		m.setAttribute("role", "img");
		m.setAttribute("aria-label", c.agent.label);
		m.title = c.agent.label;
		m.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" fill="currentColor"><path d="M6 0.8l1.1 3.6 3.6 1.1-3.6 1.1L6 10.2 4.9 6.6 1.3 5.5l3.6-1.1z"/></svg>';
		return m;
	}

	window.agentUi = { can, reason, slashReason, blocked, gate, describe, modeNotActive, sync, tabMark };

	// --- self-test: the agents step --------------------------------------------------------------------------------------------------
	// A Pi chat's header and controls, a Claude Agent chat's chip, tab mark and disabled controls with their reasons, and the open
	// new-chat menu; screenshots in light and dark. No prompt is sent. The Claude Agent chat does not need to become ready: everything
	// here follows from the capability data that arrives when the chat starts.
	selftestSteps.push(async ({ snap, wait }) => {
		const problems = [];
		const check = (ok, what) => ok || problems.push(what);
		const vis = (n) => !!n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
		const slashNames = () => [...$("#slash-menu").querySelectorAll(".pal-item")].map((r) => ({ name: r.querySelector(".slash-name")?.textContent, off: r.getAttribute("aria-disabled") === "true", title: r.title, desc: r.querySelector(".desc")?.textContent }));
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
				await snap(`agents-${name}-${th}`);
			}
			setTheme(was);
			await wait(200);
		};
		const piChat = active;
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
			typeInto("/");
			await wait(250);
			const piSlash = slashNames();
			check(["fork", "clone", "export", "compact"].every((n) => piSlash.find((r) => r.name === `/${n}`) && !piSlash.find((r) => r.name === `/${n}`).off), "a slash command is disabled in a Pi chat");
			typeInto("");
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
			check(!/claude code/i.test(document.body.innerText), "the words Claude Code are on screen");
			const marks = [...document.querySelectorAll(".chat-tab .ct-agent")];
			check(marks.length === 1 && marks[0].getAttribute("aria-label") === "Claude Agent" && marks[0].closest(".chat-tab")?.getAttribute("aria-selected") === "true", `tab marks: ${marks.length}`);
			check(input.placeholder.startsWith("Ask Claude Agent"), "the placeholder still says Pi");
			const modes = [...modeSel.options].filter((o) => o.value).map((o) => o.value).join();
			check(modes === "plan,ask-edits,ask-commands,trusted", `Claude mode list: ${modes}`);
			check(modeSel.disabled && modeSel.title.startsWith("Claude Agent"), `mode selector reason: ${modeSel.title}`);
			// the disabled controls and their reasons
			made.state.queue = { steering: [], followUp: ["queued note"] };
			renderQueue();
			const steer = document.querySelector("#queue .q-steer");
			check(steer && steer.getAttribute("aria-disabled") === "true" && steer.title === REASON_OF.steering && steer.getAttribute("aria-description") === REASON_OF.steering, `Steer: ${steer?.title}`);
			steer?.focus();
			steer?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); // an offscreen window is never the focused one, so the browser may not send it
			await wait(100);
			check(vis(line) && line.textContent === REASON_OF.steering, "focus on Steer shows no reason");
			steer?.click();
			typeInto("/");
			await wait(250);
			const rows = slashNames();
			const want = { "/fork": "Forking a chat is not available for Claude Agent chats yet.", "/clone": "Cloning a chat is not available for Claude Agent chats yet.", "/export": "Export as HTML is not available for Claude Agent chats.", "/compact": "Claude Agent compacts long chats by itself.", "/session": "Session statistics are not available for Claude Agent chats.", "/name": "Naming a chat is not available for Claude Agent chats." };
			for (const [n, why] of Object.entries(want)) {
				const r = rows.find((x) => x.name === n);
				check(r && r.off && r.title === why && r.desc === why, `${n}: ${r ? `${r.off} ${r.title}` : "missing"}`);
			}
			check(rows.filter((r) => r.off).length === Object.keys(want).length, `disabled slash rows: ${rows.filter((r) => r.off).map((r) => r.name)}`);
			const enabled = rows.find((r) => r.name === "/model");
			check(enabled && !enabled.off, "/model is disabled");
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
			typeInto("");
			made.state.queue = { steering: [], followUp: [] };
			renderQueue();

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
