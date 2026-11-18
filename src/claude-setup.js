// Claude Agent: the setup card at the top of a new chat, the pause card at the end of a conversation, and the Claude Agent rows of the Setup panel.
// No dialog: everything sits in the chat (in the page flow) or in the Setup panel's list. The key is typed in a masked field inside the card, sent to the
// main process once and cleared at once; this file never keeps it, never logs it, and the state it gets back holds no key.
//  - Setup card (a chat whose agent is not set up: main sends pi:started with needsSetup): step 1 "API key" (Add key), step 2 "Engine" (size, Download).
//    A step is to do, working, done or failed (the readable reason and a retry). The message box is disabled until both are done; then the card goes
//    away and main starts the chat. The engine downloads only after the click on Download, with the one-time token of the plan.
//  - Pause card (the claude_paused record): what the chat has used, Continue and Change limit. The message box is disabled until a choice is made.
//  - Setup panel: two rows (key, engine), only once a Claude Agent chat has been started on this machine. They are not part of "Setup: x of y".
// Self-test: claude-setup-selftest.js. Run: npm run selftest -- claude-setup
"use strict";

(() => {
	const REASON_SETUP = "Finish setup to send a message";
	const REASON_PAUSE = "Choose Continue to send a message";
	const DEFAULT_LIMIT = 5;
	const KEY_HINT = "Your own Anthropic key. Usage is billed to your Anthropic account.";
	const ENGINE_HINT = "Downloaded once, checked before use.";
	const usd = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;
	const mb = (b) => `${Math.round((Number(b) || 0) / 1e6)} MB`;

	let S = null; // the last setup state from main: { key, engine, ready, started, limitUsd } (never a key)
	const surfaces = new Set(); // every card and panel row that shows a step: { kind, local, render }
	const cards = new Map(); // chatId -> { chat, el, sf: {key, engine}, timer }

	// --- one step, drawn the same in the card and in the Setup panel ------------------------------------------------
	// Returns { state, mark, parts } where parts are the three cells: mark, text (title, line, field, bar) and actions.
	function stepCells(kind, sf, names) {
		const st = S || { key: { state: "todo" }, engine: { state: "todo" } };
		const mark = el("span", "ob-mark sc-mark");
		mark.setAttribute("aria-hidden", "true");
		const text = el("div", "ob-text");
		const actions = el("div", "sc-actions");
		const title = el("span", "ob-label sc-title");
		const line = el("div", "ob-line sc-line");
		const btn = (label, onClick, { primary = false, id } = {}) => {
			const b = el("button", primary ? "btn" : "btn secondary", label);
			b.type = "button";
			if (id) b.dataset.action = id;
			b.onclick = onClick;
			actions.append(b);
			return b;
		};
		let state;
		let word;
		let sizeNote = null;
		let bar = null;
		let field = null;

		if (kind === "key") {
			const k = st.key;
			const busy = sf.keyBusy || k.state === "checking";
			const failed = !busy && (sf.keyError || k.state === "failed");
			title.append(names.key);
			if (busy) {
				state = "working";
				line.textContent = "Checking your key…";
			} else if (sf.keyOpen) {
				state = failed ? "failed" : k.state === "done" ? "done" : "todo";
				line.textContent = k.state === "done" ? "Enter the new key. The old one stays until the new one is accepted." : KEY_HINT;
				field = keyField(sf);
			} else if (failed) {
				state = "failed";
				line.textContent = sf.keyError || k.reason;
				line.setAttribute("role", "alert");
				btn("Try again", () => ((sf.keyOpen = true), (sf.keyError = null), sf.render(true)), { id: "add-key" });
			} else if (k.state === "done") {
				state = "done";
				line.textContent = k.source === "env" ? "Using the ANTHROPIC_API_KEY on this computer." : k.pendingCheck ? "Key saved. It is checked once the engine is downloaded." : "Key saved on this computer, checked.";
				btn("Change key", () => ((sf.keyOpen = true), sf.render(true)), { id: "change-key" });
				if (k.source === "stored" || k.pendingCheck) btn("Remove key", () => removeKey(sf), { id: "remove-key" });
			} else {
				state = "todo";
				line.textContent = KEY_HINT;
				btn("Add key", () => ((sf.keyOpen = true), sf.render(true)), { primary: true, id: "add-key" });
			}
		} else {
			const e = st.engine;
			title.append(names.engine);
			if (e.sizeText) sizeNote = el("span", "sc-size", e.sizeText);
			if (e.state === "downloading") {
				state = "working";
				const pct = Math.max(0, Math.min(100, Number(e.percent) || 0));
				line.textContent = `Downloading… ${pct}% (${mb(e.received)} of ${mb(e.total)})`;
				line.dataset.progress = String(pct);
				bar = el("div", "sc-bar");
				bar.setAttribute("role", "progressbar");
				bar.setAttribute("aria-label", "Engine download");
				bar.setAttribute("aria-valuemin", "0");
				bar.setAttribute("aria-valuemax", "100");
				bar.setAttribute("aria-valuenow", String(pct));
				const fill = el("span");
				fill.style.width = `${pct}%`;
				bar.append(fill);
				btn("Cancel", () => crust.claude.engineCancel(), { id: "cancel-download" });
			} else if (sf.engineBusy) {
				state = "working";
				line.textContent = "Starting the download…";
			} else if (sf.engineErr || e.state === "failed") {
				state = "failed";
				line.textContent = sf.engineErr || e.reason;
				line.setAttribute("role", "alert");
				btn("Try again", () => startDownload(sf), { id: "download" });
			} else if (e.state === "done") {
				state = "done";
				line.textContent = `Engine ready${e.version ? ` (version ${e.version})` : ""}.`;
			} else {
				state = "todo";
				line.textContent = ENGINE_HINT;
				btn("Download", () => startDownload(sf), { primary: true, id: "download" });
			}
		}
		word = { todo: "To do", working: "Working", done: "Done", failed: "Failed" }[state];
		const glyph = state === "done" ? "✓" : state === "failed" ? "!" : state === "working" ? "" : names.todoMark;
		mark.textContent = glyph;
		if (state === "working") mark.classList.add("sc-spin");
		const sr = el("span", "fp-sr", `${word}. `);
		title.prepend(sr);
		const head = el("div", "sc-head");
		head.append(title);
		if (sizeNote) head.append(sizeNote);
		text.append(head, line);
		if (bar) text.append(bar);
		if (field) text.append(field);
		if (state === "working") text.setAttribute("aria-busy", "true");
		return { state, mark, text, actions };
	}

	// The masked field for the key, inside the step. Enter saves, Escape closes. The value leaves this field the moment it is saved.
	function keyField(sf) {
		const wrap = el("form", "sc-field");
		wrap.setAttribute("aria-label", "Anthropic API key");
		const input = el("input");
		input.type = "password";
		input.autocomplete = "off";
		input.spellcheck = false;
		input.placeholder = "Paste your key";
		input.setAttribute("aria-label", "Anthropic API key");
		input.setAttribute("autocapitalize", "off");
		const save = el("button", "btn", "Save key");
		save.type = "submit";
		save.dataset.action = "save-key";
		const cancel = el("button", "btn secondary", "Cancel");
		cancel.type = "button";
		cancel.dataset.action = "cancel-key";
		cancel.onclick = () => ((sf.keyOpen = false), sf.render());
		wrap.addEventListener("submit", (e) => {
			e.preventDefault();
			saveKey(sf, input);
		});
		wrap.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				cancel.click();
			}
		});
		wrap.append(input, save, cancel);
		return wrap;
	}

	async function saveKey(sf, input) {
		let value = input.value;
		input.value = ""; // out of the field before anything else
		if (!value.trim()) {
			value = "";
			sf.keyError = "Enter your key first.";
			sf.keyOpen = false;
			return sf.render();
		}
		sf.keyOpen = false;
		sf.keyBusy = true;
		sf.keyError = null;
		sf.render();
		let r;
		try {
			r = await crust.claude.saveKey(value);
		} catch {
			r = { ok: false, error: "The key could not be saved." };
		}
		value = "";
		sf.keyBusy = false;
		sf.keyError = r && r.ok ? null : (r && r.error) || "The key could not be saved.";
		sf.render();
		refreshAll();
	}
	async function removeKey(sf) {
		const r = await crust.claude.removeKey();
		if (!r.ok) sf.keyError = r.error || "The key could not be removed.";
		sf.render();
	}
	// Download: the plan first (main issues a one-time token for it), then the download with that token. Main refuses a download without it.
	async function startDownload(sf) {
		sf.engineBusy = true;
		sf.engineErr = null;
		sf.render();
		try {
			const plan = await crust.claude.enginePlan();
			if (!plan || !plan.ok) {
				sf.engineBusy = false;
				if (!plan || !plan.installed) sf.engineErr = (plan && plan.error) || "The download could not start.";
				return sf.render();
			}
			crust.claude.engineDownload(plan.token).then(
				(r) => {
					sf.engineBusy = false;
					if (r && !r.ok && r.code !== "cancelled") sf.engineErr = r.error || "The download failed.";
					sf.render();
				},
				() => ((sf.engineBusy = false), (sf.engineErr = "The download failed."), sf.render()),
			);
		} catch {
			sf.engineBusy = false;
			sf.engineErr = "The download could not start.";
			sf.render();
		}
	}

	// --- the setup card ---------------------------------------------------------------------------------------------
	function buildCard(chat) {
		const root = el("section", "setup-card");
		root.setAttribute("role", "region");
		root.setAttribute("aria-label", `${agentLabel(chat)} setup`);
		root.dataset.chat = chat.id;
		const head = el("h3", "", `Set up ${agentLabel(chat)}`);
		const intro = el("p", "sc-intro", "Two steps before the first message. Nothing is sent anywhere until you finish them.");
		const steps = el("div", "sc-steps");
		const card = { chat, el: root, sf: {}, timer: null };
		root.append(head, intro, steps);
		const mk = (kind, num) => {
			const sf = { kind, keyOpen: false, keyBusy: false, keyError: null, engineBusy: false, engineErr: null };
			const host = el("div", "sc-step");
			host.dataset.step = kind;
			sf.render = (focusField) => {
				const had = host.contains(document.activeElement) ? document.activeElement.dataset?.action || document.activeElement.tagName : null;
				const c = stepCells(kind, sf, { key: `${num} API key`, engine: `${num} Engine`, todoMark: String(num) });
				host.dataset.state = c.state;
				host.replaceChildren(c.mark, c.text, c.actions);
				if (focusField) host.querySelector(".sc-field input")?.focus();
				else if (had && had !== "BODY") host.querySelector(`[data-action="${had}"]`)?.focus();
			};
			surfaces.add(sf);
			steps.append(host);
			card.sf[kind] = sf;
			sf.render();
		};
		mk("key", 1);
		mk("engine", 2);
		return card;
	}

	function showCard(chat) {
		let card = cards.get(chat.id);
		if (card && card.el.isConnected) return card;
		card = buildCard(chat);
		cards.set(chat.id, card);
		chat.el.prepend(card.el);
		return card;
	}
	function removeCard(chat) {
		const card = cards.get(chat.id);
		if (!card) return;
		clearTimeout(card.timer);
		for (const sf of Object.values(card.sf)) surfaces.delete(sf);
		card.el.remove();
		cards.delete(chat.id);
	}

	// Every surface draws again from the new state. A step whose look did not change keeps its nodes (a typed key stays in its field).
	function refreshAll() {
		for (const sf of surfaces) {
			if (S && S.engine.state !== "todo") sf.engineBusy = false;
			if (S && S.key.state === "done") sf.keyError = null;
			// progress: update the bar in place, so a step in the middle of a click is not rebuilt ten times a second
			sf.render();
		}
		for (const card of cards.values()) {
			if (S && S.ready) leaveSoon(card);
			else if (S && !S.ready && card.timer) {
				clearTimeout(card.timer);
				card.timer = null;
			}
		}
	}
	// Both steps are done: show it for a moment, then the card goes away (main has started the chat by then).
	function leaveSoon(card) {
		if (card.timer) return;
		card.timer = setTimeout(() => {
			card.chat.needsSetup = false;
			removeCard(card.chat);
			syncComposer(card.chat);
			window.renderStatus?.();
			window.dispatchEvent(new CustomEvent("claude:setup-done", { detail: { chatId: card.chat.id } }));
		}, 900);
	}

	// --- the message box: disabled with a reason ---------------------------------------------------------------------
	const gateReason = (c) => (!c ? "" : c.needsSetup ? REASON_SETUP : c.pause ? REASON_PAUSE : "");
	let syncing = false;
	function syncComposer(c = active) {
		if (!c || c !== active) return;
		const input = $("#input");
		const send = $("#send");
		const why = gateReason(c);
		if (why) {
			input.readOnly = true;
			input.dataset.gate = "1";
			input.placeholder = why; // the visible reason
			input.title = why;
			input.setAttribute("aria-disabled", "true");
			input.setAttribute("aria-description", why);
			send.setAttribute("aria-disabled", "true");
			send.classList.add("is-disabled");
			send.dataset.reason = why;
			send.title = why;
			send.setAttribute("aria-description", why);
		} else if (input.dataset.gate) {
			delete input.dataset.gate;
			input.readOnly = false;
			input.removeAttribute("aria-disabled");
			input.removeAttribute("aria-description");
			input.removeAttribute("title");
			send.removeAttribute("aria-disabled");
			send.classList.remove("is-disabled");
			delete send.dataset.reason;
			send.removeAttribute("aria-description");
			send.title = "";
			if (!syncing) {
				syncing = true;
				window.agentUi?.sync(c); // brings the placeholder back
				syncing = false;
			}
		}
	}

	// --- the pause card ----------------------------------------------------------------------------------------------
	function pauseCard(chat, rec) {
		dropPause(chat);
		const budget = rec.reason === "budget";
		const node = el("section", "pause-card");
		node.setAttribute("role", "region");
		node.setAttribute("aria-label", "Paused");
		const p = { rec, el: node, limit: Number.isFinite(Number(rec.limitUsd)) && Number(rec.limitUsd) > 0 ? Number(rec.limitUsd) : DEFAULT_LIMIT, editing: false, error: null };
		chat.pause = p;
		const draw = () => {
			const text = el("p", "pc-text");
			if (budget) text.textContent = `This chat has used about ${usd(rec.totalCostUsd)}. Continue for up to another ${usd(p.limit)}?`;
			else text.textContent = `This chat reached its limit of ${rec.maxTurns || "its"} steps. Continue?`;
			const row = el("div", "sc-actions pc-actions");
			const cont = el("button", "btn", "Continue");
			cont.type = "button";
			cont.dataset.action = "continue";
			cont.onclick = () => resume(chat);
			if (!rec.canContinue) {
				cont.disabled = true;
				text.textContent += " This chat cannot be continued: start a new one.";
			}
			row.append(cont);
			if (budget && rec.canContinue) {
				const change = el("button", "btn secondary", "Change limit");
				change.type = "button";
				change.dataset.action = "change-limit";
				change.setAttribute("aria-expanded", String(p.editing));
				change.onclick = () => ((p.editing = !p.editing), (p.error = null), draw());
				row.append(change);
			}
			const kids = [text, row];
			if (p.editing) {
				const f = el("form", "sc-field pc-limit");
				f.noValidate = true; // our own message for an amount that is out of range, not the browser's bubble
				const label = el("label", "pc-label", "Spend limit per run");
				const num = el("input");
				num.type = "number";
				num.min = "0.5";
				num.max = "1000";
				num.step = "0.5";
				num.value = String(p.limit);
				num.id = `pc-limit-${chat.id}`;
				label.htmlFor = num.id;
				const save = el("button", "btn", "Save and continue");
				save.type = "submit";
				save.dataset.action = "save-limit";
				f.append(label, num, save);
				f.onsubmit = async (e) => {
					e.preventDefault();
					const r = await crust.claude.setLimit(Number(num.value));
					if (!r.ok) {
						p.error = r.error;
						return draw();
					}
					p.limit = r.limitUsd;
					resume(chat);
				};
				kids.push(f);
				if (p.error) {
					const err = el("div", "ob-line pc-error", p.error);
					err.setAttribute("role", "alert");
					kids.push(err);
				}
			}
			node.replaceChildren(...kids);
			if (p.editing) node.querySelector("input")?.focus();
		};
		p.draw = draw;
		draw();
		chat.el.append(node);
		if (chat === active) chat.el.scrollTop = chat.el.scrollHeight;
		syncComposer(chat);
	}
	function dropPause(chat) {
		if (chat.pause) chat.pause.el.remove();
		chat.pause = null;
	}
	// Continue: a new process picks the conversation up again (the session id from the record) under a new limit that counts from zero.
	function resume(chat) {
		const sessionId = chat.pause && chat.pause.rec.sessionId;
		dropPause(chat);
		syncComposer(chat);
		crust.pi.restart(chat.id, sessionId || undefined);
	}

	// --- the Setup panel's rows --------------------------------------------------------------------------------------
	let panel = null;
	function panelRows() {
		if (!S || !S.started) return [];
		if (!panel) {
			panel = [];
			for (const [kind, label] of [["key", "Claude Agent key"], ["engine", "Claude Agent engine"]]) {
				const li = el("li", "ob-row sc-row");
				li.dataset.id = `claude-${kind}`;
				const sf = { kind, keyOpen: false, keyBusy: false, keyError: null, engineBusy: false, engineErr: null };
				sf.render = (focusField) => {
					const c = stepCells(kind, sf, { key: label, engine: label, todoMark: "○" });
					li.className = `ob-row sc-row ${c.state === "done" ? "ready" : c.state}`;
					const opt = el("span", "ob-optional", "Optional");
					c.text.querySelector(".sc-title").append(opt);
					li.replaceChildren(c.mark, c.text, c.actions);
					if (focusField) li.querySelector(".sc-field input")?.focus();
				};
				surfaces.add(sf);
				panel.push(li);
				sf.render();
			}
		}
		return panel;
	}

	// --- wiring ------------------------------------------------------------------------------------------------------
	crust.claude.onSetup((s) => {
		S = s;
		refreshAll();
	});
	crust.claude.state().then((s) => {
		S = s;
		refreshAll();
	});
	// pi:started with needsSetup: this chat shows its card; without it (the chat started) there is none.
	crust.pi.onStarted(({ chatId, needsSetup }) => {
		const c = chats.get(chatId);
		if (!c) return;
		if (needsSetup) {
			c.needsSetup = true;
			showCard(c);
		} else if (c.needsSetup) {
			const card = cards.get(c.id);
			if (card) leaveSoon(card); // started: the card shows both steps done for a moment, then goes
			else c.needsSetup = false;
		}
		syncComposer(c);
		window.renderStatus?.();
	});

	window.claudeSetupUi = {
		gateReason,
		syncComposer,
		pauseCard,
		panelRows,
		state: () => S,
		cardOf: (chat) => cards.get(chat.id) || null,
		// Self-test (layers step): the two cards on the active chat, whatever its agent, and away again.
		testOpen: (kind, chat = active) => (kind === "setup" ? showCard(chat) : pauseCard(chat, { type: "claude_paused", reason: "budget", totalCostUsd: 5.01, limitUsd: 5, canContinue: true, sessionId: "layers-test" })),
		testClose: (kind, chat = active) => (kind === "setup" ? removeCard(chat) : (dropPause(chat), syncComposer(chat))),
		usd,
	};
})();
