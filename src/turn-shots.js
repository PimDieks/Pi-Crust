// Before/after screenshots per turn: when Pi starts a turn we capture the dev browser, when the turn ends and it edited
// files we capture it again (after the reload) and put a before/after card in the chat. Shots are stored by snap-main.js
// and tagged with the chat's session file and the checkpoint of the prompt, so the timeline (timeline.js) can list them.
// Uses the hook bus from renderer.js; compare-view.js draws the comparison.
"use strict";

(() => {
	const KEY = "turnShots";
	const enabled = () => localStorage.getItem(KEY) !== "off";
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const EXPAND_ICON = ICON('<path d="M9.5 3H13v3.5M6.5 13H3V9.5M13 3L9 7M3 13l4-4"/>');
	const EDIT_TOOLS = new Set(["edit", "write"]);

	// Image data URLs by shot id: small LRUs, the full-size ones are big. Missing shots (null) are never cached.
	const thumbs = new Map();
	const fulls = new Map();
	function shotSrc(entry, thumb) {
		const cache = thumb ? thumbs : fulls;
		const max = thumb ? 60 : 4;
		if (cache.has(entry.id)) {
			const p = cache.get(entry.id);
			cache.delete(entry.id); // move to the newest end
			cache.set(entry.id, p);
			return p;
		}
		const p = crust.snap.get(entry.id, thumb).then((src) => {
			if (!src && cache.get(entry.id) === p) cache.delete(entry.id);
			return src;
		});
		cache.set(entry.id, p);
		while (cache.size > max) cache.delete(cache.keys().next().value);
		return p;
	}

	async function sessionFileOf(c) {
		if (c.sessionFile) return c.sessionFile;
		const st = await rpcTo(c, "get_state");
		return st.success ? st.data?.sessionFile || null : null;
	}

	// The user message that started this turn: the first one rendered after the turn started (see user:rendered below).
	async function promptOf(node) {
		if (!node) return { text: "", cpId: null };
		let cpId = node.dataset.cp || null;
		if (!cpId && node._cpPromise) cpId = (await node._cpPromise)?.id || null;
		return { text: String(node._raw || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200), cpId };
	}

	// --- capturing ------------------------------------------------------------------------------
	onCrust("turn:start", (c) => {
		c._shots = { edits: 0, node: null, before: enabled() ? crust.snap.live({ skipEmpty: true }).catch(() => null) : null };
	});
	onCrust("user:rendered", (c, node, _m, history) => {
		if (!history && c._shots && !c._shots.node) c._shots.node = node;
	});
	// A "before" shot that won't be part of a pair is deleted, so it doesn't sit untagged in the store until pruned.
	const discard = async (before) => {
		try {
			const b = await before;
			if (b?.ok) await crust.snap.delete(b.entry.id);
		} catch {}
	};
	onCrust("tool:end", (c, t) => {
		if (!t.history && !t.isError && EDIT_TOOLS.has(String(t.toolName).toLowerCase()) && c._shots) c._shots.edits++;
	});
	onCrust("turn:settled", async (c) => {
		const s = c._shots;
		c._shots = null;
		if (!s?.before) return;
		if (!s.edits || !enabled()) return discard(s.before);
		try {
			const before = await s.before;
			if (!before?.ok) return;
			// No card when the page is blank, failed to load or looks the same as before: nothing was produced to show.
			const after = await crust.snap.live({ settleMs: 600, waitLoadMs: 1500, skipEmpty: true, unlessSameAs: before.entry.id });
			if (!after?.ok) return discard(before);
			const [sessionFile, p] = await Promise.all([sessionFileOf(c), promptOf(s.node)]);
			const base = { sessionFile, cpId: p.cpId, prompt: p.text };
			await crust.snap.tag(before.entry.id, { ...base, role: "before" });
			const tagged = await crust.snap.tag(after.entry.id, { ...base, role: "after", beforeId: before.entry.id });
			if (!chats.has(c.id)) return;
			const pair = { before: before.entry, after: tagged || after.entry, prompt: p.text, cpId: p.cpId };
			addShotCard(c, pair);
			emitCrust("shot:added", c, pair);
		} catch (e) {
			console.error("turn shots failed", e);
		}
	});

	// --- the chat card (tool-card look) ---------------------------------------------------------
	function addShotCard(c, pair) {
		const d = el("details", "tool shot-card ok");
		d.open = true;
		d.dataset.shot = pair.after.id;
		const s = el("summary");
		const open = el("button", "icon shot-open");
		open.type = "button";
		open.title = "Open large";
		open.setAttribute("aria-label", "Open the before/after comparison large");
		open.innerHTML = EXPAND_ICON;
		open.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			openShotCompare(pair);
		};
		const where = pair.after.url ? pair.after.url.replace(/^https?:\/\//, "") : "";
		const target = el("span", "targ", where);
		target.title = pair.after.url || "";
		s.append(el("span", "dot"), el("span", "tname", "Before / after"), target, el("span", "tmeta", `${pair.after.w}×${pair.after.h}`), open);
		const body = el("div", "shot-body");
		d.append(s, body);
		withChat(c, () => {
			messages.append(d);
			scroll();
		});
		Promise.all([shotSrc(pair.before, true), shotSrc(pair.after, true)]).then(([a, b]) => {
			if (!a || !b) return body.append(el("div", "muted", "The screenshots are no longer available"));
			body.append(createCompare(a, b));
		});
		return d;
	}

	// --- large view -----------------------------------------------------------------------------
	function openShotCompare(pair, extra) {
		const modal = $("#modal");
		const res = showDialog({
			method: "custom",
			title: "Before / after",
			cancelLabel: "Close",
			render(box, finish, actions) {
				modal.classList.add("wide");
				if (pair.prompt) box.append(el("p", "shot-prompt", pair.prompt));
				const holder = el("div", "shot-large");
				box.append(holder);
				Promise.all([shotSrc(pair.before), shotSrc(pair.after)]).then(([a, b]) => holder.append(a && b ? createCompare(a, b) : el("div", "muted", "The screenshots are no longer available")));
				extra?.(actions, finish);
			},
		});
		res.then(() => modal.classList.remove("wide"));
		return res;
	}

	const prev = window.crustPaletteActions;
	window.crustPaletteActions = () => [
		...(prev?.() || []),
		{
			label: `Before/after screenshots: ${enabled() ? "on" : "off"}`,
			desc: "click to toggle",
			run: () => {
				localStorage.setItem(KEY, enabled() ? "off" : "on");
				toast(`Before/after screenshots ${enabled() ? "on" : "off"}`);
			},
		},
	];

	window.crustShots = { shotSrc, addShotCard, openShotCompare, sessionFileOf };
})();
