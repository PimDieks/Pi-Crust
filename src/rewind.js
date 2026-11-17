// Checkpoints in the chat: every message you send gets a snapshot of the files (checkpoints-main.js). Hover a message
// of yours to Edit it (fork the conversation before it, text back in the composer) or Rewind (restore the files and/or
// the conversation). Uses the hook bus from renderer.js.
"use strict";

(() => {
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const EDIT_ICON = ICON('<path d="M3 13l.6-2.8L10.8 3a1.4 1.4 0 0 1 2 2l-7.2 7.2L3 13z"/><path d="M9.5 4.5l2 2"/>');
	const REWIND_ICON = ICON('<path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6"/><path d="M6 3.5l-3 3 3 3"/>');

	const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
	async function hashOf(t) {
		const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(norm(t)));
		return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}
	const userNodes = (c) => [...c.el.querySelectorAll(".msg.user")];

	async function sessionFileOf(c) {
		if (c.sessionFile) return c.sessionFile;
		const st = await rpcTo(c, "get_state");
		return st.success ? st.data?.sessionFile || null : null;
	}

	// --- creating and finding checkpoints -----------------------------------------------------
	// The snapshot is taken in sendPrompt (renderer.js) BEFORE the prompt goes to Pi, so it can't contain Pi's edits for
	// this message. Each chat keeps a FIFO of them; the next live user message with the same text takes its checkpoint.
	window.rewindBeforeSend = async (c, text) => {
		const promise = (async () => {
			const r = await crust.checkpoints.create({ sessionFile: await sessionFileOf(c), text, chatId: c.id });
			return r.ok ? r.entry : null;
		})().catch(() => null);
		const q = (c._cpq ||= []);
		q.push({ key: norm(text), promise });
		if (q.length > 50) q.shift();
		await promise; // on failure the message is still sent, just without a checkpoint
	};
	onCrust("chat:cleared", (c) => {
		c._cpq = [];
	});

	onCrust("user:rendered", (c, node, message, history) => {
		node._raw = textOf(message.content);
		node._ts = message.timestamp;
		addBar(c, node);
		if (history) return;
		const q = c._cpq || [];
		const i = q.findIndex((x) => x.key === norm(node._raw));
		if (i < 0) return;
		const [item] = q.splice(i, 1);
		node._cpPromise = item.promise.then((e) => {
			if (e) node.dataset.cp = e.id;
			return e;
		});
	});

	// The checkpoint entry of a message, or null. Live messages know it; history is matched by text hash, from the end.
	async function checkpointOf(c, node) {
		if (node._cpPromise) {
			const e = await node._cpPromise;
			if (e) return (node._cp = e);
		}
		if (node._cp) return node._cp;
		const file = await sessionFileOf(c);
		if (!file) return null;
		const r = await crust.checkpoints.list({ sessionFile: file, chatId: c.id });
		if (!r.ok) return null;
		const h = await hashOf(node._raw);
		const entries = r.list.filter((e) => e.textHash === h);
		const same = [];
		for (const n of userNodes(c)) if ((n._hash ||= await hashOf(n._raw)) === h) same.push(n);
		const k = same.length - 1 - same.indexOf(node);
		const e = entries[entries.length - 1 - k] || null;
		if (e && k >= 0) node._cp = e;
		return e;
	}

	// Pi's entry id for this message: get_fork_messages lists the user messages in order; align from the end.
	async function forkEntryFor(c, node) {
		const r = await rpcTo(c, "get_fork_messages");
		if (!r.success) return { error: r.error || "Couldn't read the messages" };
		const list = r.data?.messages || [];
		const nodes = userNodes(c);
		const k = nodes.length - 1 - nodes.indexOf(node);
		const f = list[list.length - 1 - k];
		if (!f || norm(f.text) !== norm(node._raw)) return { error: "Couldn't match this message to Pi's history" };
		return { entryId: f.entryId };
	}

	// --- hover bar ----------------------------------------------------------------------------
	function addBar(c, node) {
		const bar = el("div", "user-actions");
		const mk = (cls, label, icon, fn) => {
			const b = el("button", `icon ${cls}`);
			b.type = "button";
			b.title = label;
			b.setAttribute("aria-label", label);
			b.innerHTML = icon;
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				fn().catch((err) => toast(`${label} failed: ${err.message}`, "error"));
			});
			return b;
		};
		bar.append(
			mk("msg-edit", "Edit and resend", EDIT_ICON, () => start(c, node, "edit")),
			mk("msg-rewind", "Rewind to before this message", REWIND_ICON, () => start(c, node, "rewind")),
		);
		node.append(bar);
	}

	// --- the dialog ---------------------------------------------------------------------------
	const STATUS = { A: "ADD", D: "DEL", M: "MOD" };
	const MAX_FILES = 8;

	function option(label, checked, disabled) {
		const lab = el("label", "rw-opt");
		const cb = el("input");
		cb.type = "checkbox";
		cb.checked = checked && !disabled;
		cb.disabled = !!disabled;
		const text = el("span", "", label);
		lab.append(cb, text);
		return { lab, cb, text };
	}

	function askRewind({ mode, node, files, hasCp }) {
		const edit = mode === "edit";
		return showDialog({
			method: "custom",
			title: edit ? "Edit and resend" : "Rewind to before this message",
			render(box, finish, actions) {
				box.append(el("p", "rw-quote", norm(node._raw).slice(0, 160) || "(image)"));
				const code = option(
					hasCp ? (files.length ? `${edit ? "Also restore" : "Restore"} the files (${files.length} changed since)` : "Files are already the same as then") : "No file checkpoint for this message",
					!edit && files.length > 0,
					!files.length,
				);
				box.append(code.lab);
				if (files.length) {
					const list = el("div", "rw-files");
					for (const f of files.slice(0, MAX_FILES)) {
						const row = el("div", "rw-file");
						const name = f.path.split("/").pop();
						const dir = f.path.slice(0, -name.length).replace(/\/$/, "");
						const p = el("span", "cpath");
						p.title = f.path;
						p.append(el("span", "cname", name), el("span", "cdir", dir));
						row.append(el("span", `st st-${STATUS[f.status] || "MOD"}`, STATUS[f.status] || "MOD"), p);
						list.append(row);
					}
					if (files.length > MAX_FILES) list.append(el("div", "muted", `and ${files.length - MAX_FILES} more`));
					box.append(list);
				}
				const conv = option("Conversation: continue from here, the message goes back to the composer", true, edit);
				if (!edit) box.append(conv.lab);
				const go = el("button", "", edit ? "Edit" : "Rewind");
				go.type = "button";
				const sync = () => (go.disabled = !(code.cb.checked || conv.cb.checked || edit));
				code.cb.onchange = conv.cb.onchange = sync;
				sync();
				go.onclick = () => finish({ value: { code: code.cb.checked, conv: conv.cb.checked || edit } });
				actions.append(go);
			},
		});
	}

	// --- doing it -----------------------------------------------------------------------------
	async function start(c, node, mode) {
		if (!chats.has(c.id)) return;
		const entry = await checkpointOf(c, node);
		let files = [];
		if (entry) {
			const p = await crust.checkpoints.preview(entry.id, c.id);
			if (p.ok) files = p.files;
		}
		let choice;
		if (mode === "edit" && !files.length) choice = { code: false, conv: true };
		else {
			const res = await askRewind({ mode, node, files, hasCp: !!entry });
			if (!res.value) return;
			choice = res.value;
		}
		await perform(c, node, entry, choice, mode);
	}

	// The last restore per working root, for the "Undo last restore" palette action.
	const lastUndo = new Map();
	const rootOf = (c) => c.cwd || info.repo;
	async function undoRestore(root, id, chatId) {
		const u = await crust.checkpoints.restore(id, chatId);
		if (u.ok && lastUndo.get(root) === id) lastUndo.delete(root);
		toast(u.ok ? "Restore undone" : u.error || "Couldn't undo the restore", u.ok ? "info" : "error");
		refreshChangesSoon();
		refreshTree();
	}

	async function perform(c, node, entry, { code, conv }, mode) {
		let fork = null;
		if (conv) {
			fork = await forkEntryFor(c, node);
			if (fork.error) return toast(fork.error, "error");
		}
		if (c.state.streaming && c !== active) await activate(c);
		if (!(await confirmStopIfWorking(mode === "edit" ? "edit this message" : "rewind"))) return;
		// stop() only asks Pi to abort: wait until the run really ended before touching files or the session.
		for (let i = 0; i < 150 && c.state.streaming; i++) await new Promise((r) => setTimeout(r, 100));
		if (c.state.streaming) return toast("Pi didn't stop in time; try again in a moment", "error");
		let undoId = null;
		let n = 0;
		if (code && entry) {
			const root = rootOf(c);
			const busy = [...chats.values()].filter((o) => o !== c && o.state.streaming && rootOf(o) === root);
			if (busy.length) {
				const ok = await showDialog({ method: "confirm", title: "Another chat is working here", message: `${busy.length === 1 ? "Another chat is" : `${busy.length} other chats are`} still writing files in this project. Restoring now may be overwritten or confuse it. Restore anyway?`, yesLabel: "Restore anyway" });
				if (!ok.confirmed) return;
			}
			const r = await crust.checkpoints.restore(entry.id, c.id);
			if (!r.ok) return toast(r.error || "Couldn't restore the files", "error");
			undoId = r.undoId;
			lastUndo.set(root, undoId);
			n = r.files.length;
			refreshChangesSoon();
			refreshTree();
		}
		const undo = undoId ? { label: "Undo restore", onClick: () => undoRestore(rootOf(c), undoId, c.id) } : undefined;
		if (!conv) return toast(`Restored ${n} file${n === 1 ? "" : "s"}`, "info", undo);

		const oldFile = await sessionFileOf(c);
		const f = await rpcTo(c, "fork", { entryId: fork.entryId });
		if (!f.success) return toast(f.error || "Fork failed", "error", undo);
		if (f.data?.cancelled) return toast("Cancelled by an extension", "warning", undo);
		const cutoff = (entry ? entry.at : node._ts || Date.now()) - 1;
		c.sessionFile = null; // showCurrentSession reads the new one
		await showCurrentSession(c);
		const newFile = await sessionFileOf(c);
		if (oldFile && newFile && oldFile !== newFile) await crust.checkpoints.copy(oldFile, newFile, cutoff, c.id);
		withChat(c, () => addNotice(mode === "edit" ? "Editing an earlier message" : "Rewound to an earlier message"));
		if (undo) toast(`Restored ${n} file${n === 1 ? "" : "s"}`, "info", undo);
		c._prefill = f.data?.text || node._raw;
		if (c === active) await applyPrefill(c);
	}
	// The text waits on the chat when you switched tabs meanwhile.
	async function applyPrefill(c) {
		const text = c._prefill;
		if (text == null) return;
		c._prefill = null;
		await prefill(text);
	}
	onCrust("chat:activated", (c) => {
		if (c._prefill != null) applyPrefill(c).catch(() => {});
	});

	// Pills and text of the old message back into the composer.
	async function prefill(text) {
		const input = $("#input");
		if (input.value.trim() || active.picks.length) {
			const ok = await showDialog({ method: "confirm", title: "Replace the draft?", message: "The composer has text. Replace it with the earlier message?", yesLabel: "Replace" });
			if (!ok.confirmed) return;
		}
		const { blocks, rest } = splitPicks(text);
		active.picks = blocks;
		renderPicks();
		input.value = rest;
		input.dispatchEvent(new Event("input"));
		input.focus();
	}

	// --- /rewind and the palette --------------------------------------------------------------
	async function pick() {
		const nodes = userNodes(active);
		if (!nodes.length) return toast("No messages to rewind to yet", "warning");
		const label = (n, i) => `${i + 1}. ${norm(n._raw).slice(0, 100) || "(image)"}`;
		const res = await showDialog({ method: "select", title: "Rewind to before which message?", options: nodes.map(label) });
		if (!res.value) return;
		const i = nodes.findIndex((n, k) => label(n, k) === res.value);
		if (i >= 0) await start(active, nodes[i], "rewind");
	}
	window.rewindPick = pick;

	// For the screenshot timeline: the user message a checkpoint belongs to (if still in this chat), and rewinding to before it.
	async function nodeForCheckpoint(c, cpId) {
		if (!cpId) return null;
		for (const n of userNodes(c)) {
			if (n.dataset.cp === cpId) return n;
			if (!n._cpPromise && (await checkpointOf(c, n))?.id === cpId) return n;
		}
		return null;
	}
	window.rewindNodeForCheckpoint = nodeForCheckpoint;
	window.rewindToCheckpoint = async (c, cpId) => {
		const n = await nodeForCheckpoint(c, cpId);
		if (!n) return toast("That message is no longer in this chat", "warning");
		await start(c, n, "rewind");
	};

	const prev = window.crustPaletteActions;
	window.crustPaletteActions = () => {
		const root = rootOf(active);
		const cid = active.id;
		const id = lastUndo.get(root);
		return [
			...(prev?.() || []),
			{ label: "Rewind to an earlier message…", desc: "files and/or conversation", run: pick },
			...(id ? [{ label: "Undo last restore", desc: "put the files back as they were before the rewind", run: () => undoRestore(root, id, cid) }] : []),
		];
	};

	// --- selftest -----------------------------------------------------------------------------
	// Only previews and cancels: restoring would rewrite the real working tree.
	selftestSteps.push(async ({ snap, wait }) => {
		const nodes = userNodes(active);
		const last = nodes[nodes.length - 1];
		if (!last) return console.error("SELFTEST rewind: no user message -> MISMATCH");
		const entry = await checkpointOf(active, last);
		const p = entry ? await crust.checkpoints.preview(entry.id, active.id) : null;
		console.error(`SELFTEST rewind: checkpoint ${entry ? entry.id : "none"}, preview ${p?.ok ? p.files.length + " files" : "failed"} -> ${entry && p?.ok ? "OK" : "MISMATCH"}`);
		last.querySelector(".user-actions").style.opacity = "1"; // stands in for :hover
		await wait(500);
		await snap("rewind-hover");
		last.querySelector(".user-actions").style.opacity = "";
		const fake = [
			{ status: "M", path: "src/renderer.js" },
			{ status: "A", path: "src/rewind.js" },
			{ status: "D", path: "docs/old/notes.md" },
		];
		const d = askRewind({ mode: "rewind", node: last, files: fake, hasCp: true });
		await wait(300);
		await snap("rewind-dialog");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`rewind-dialog-${currentTheme()}`);
		last.querySelector(".user-actions").style.opacity = "1";
		setTheme(was);
		await wait(400);
		$("#modal .modal-actions .secondary")?.click();
		await d;
		last.querySelector(".user-actions").style.opacity = "";
		const e = askRewind({ mode: "rewind", node: last, files: [], hasCp: false });
		await wait(200);
		await snap("rewind-dialog-nocp");
		$("#modal .modal-actions .secondary")?.click();
		await e;
	});
})();
