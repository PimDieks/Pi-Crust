// Worktree per chat: "New chat in worktree…" (chevron next to ＋, palette) creates a git worktree on a new branch and opens a
// chat whose Pi works there, so chats can edit in parallel without touching each other or your main checkout.
// Tabs of such chats show a branch badge; closing one asks whether to remove the worktree (the branch is always kept).
// Main-process side: worktree-main.js. Changes / git bar follow the active chat's worktree (changes.js).
"use strict";

(() => {
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const BRANCH_ICON = ICON('<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5v6M11 7.5c0 2.5-6 1.5-6 3.5"/>');
	const shq = shellQuote;
	const pad = (n) => String(n).padStart(2, "0");
	const defaultBranch = () => {
		const d = new Date();
		return `pi/${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
	};

	// The badge on a chat tab.
	window.worktreeBadge = (c) => {
		if (!c.cwd) return null;
		const b = el("span", "ct-wt");
		const short = (c.branch || "worktree").split("/").pop();
		const icon = el("span", "ct-wt-icon");
		icon.innerHTML = BRANCH_ICON;
		b.append(icon, el("span", "ct-branch", short));
		b.title = `Worktree on branch ${c.branch || ""}\n${c.cwd}`;
		return b;
	};

	async function newWorktreeChat() {
		if (!info.repo) return toast("Open a repo first", "warning");
		const res = await showDialog({
			method: "input",
			title: "New chat in a worktree",
			message: "Pi works in its own checkout on a new branch, so your main checkout and other chats stay untouched. Branch name:",
			prefill: defaultBranch(),
			placeholder: "pi/my-change",
		});
		const branch = res.value?.trim();
		if (!branch) return;
		const r = await crust.worktree.create({ branch });
		if (!r.ok) return toast(r.error || "Couldn't create the worktree", "error");
		await newChat(null, "", { cwd: r.cwd, branch: r.branch });
		toast(`Worktree on ${r.branch} ready`, "info", r.installCmd ? { label: "Install dependencies", onClick: () => runInTerminal(shellAnd(`cd ${shq(r.cwd)}`, r.installCmd)) } : undefined);
	}

	// Closing a worktree chat: null = keep the worktree, { force } = remove it (the branch stays either way).
	window.worktreeAskRemove = async (c) => {
		if ([...chats.values()].some((x) => x !== c && x.cwd === c.cwd)) return null; // another tab still works there
		const st = await crust.worktree.status(c.cwd);
		if (!st.ok || !st.managed) return null; // already gone, or not one Pi Crust made: never offered for removal
		const res = await showDialog({
			method: "confirm",
			title: st.dirty ? "Force-remove the worktree?" : "Remove the worktree?",
			message: st.dirty
				? `The branch “${c.branch}” stays, but this worktree has ${st.changes} uncommitted change${st.changes === 1 ? "" : "s"} that would be lost.`
				: `The branch “${c.branch}” stays; only the checkout folder is removed.`,
			yesLabel: st.dirty ? "Force remove" : "Remove",
			noLabel: "Keep",
			danger: st.dirty,
		});
		return res.confirmed ? { force: st.dirty } : null;
	};
	async function removeAt(cwd, branch, force) {
		const r = await crust.worktree.remove({ cwd, force });
		if (!r.ok && r.dirty && !force) {
			// It got changes after we asked (or the first check was a race): ask again, now with Force.
			const res = await showDialog({
				method: "confirm",
				title: "Force-remove the worktree?",
				message: `The branch “${branch}” stays, but this worktree has uncommitted changes that would be lost.`,
				yesLabel: "Force remove",
				noLabel: "Keep",
				danger: true,
			});
			if (res.confirmed) return removeAt(cwd, branch, true);
			return toast("Worktree kept", "info");
		}
		if (!r.ok) return toast(r.error || "Couldn't remove the worktree", "error");
		toast(`Worktree removed. The branch ${r.branch || branch} is kept.`, "info");
	}
	window.worktreeRemove = (c, { force }) => removeAt(c.cwd, c.branch, !!force);

	// Palette "Worktrees…": the worktrees Pi Crust made, to remove them (the branch is kept).
	async function manageWorktrees() {
		const list = (await crust.worktree.list()).filter((w) => w.managed);
		if (!list.length) return toast("No Pi Crust worktrees", "info");
		const label = (w) => `${w.branch || "(detached)"} — ${w.path.replace(/^.*[\\/]worktrees[\\/]/, "…/")}`;
		const res = await showDialog({ method: "select", title: "Remove which worktree?", options: list.map(label) });
		const w = res.value && list.find((x) => label(x) === res.value);
		if (!w) return;
		if ([...chats.values()].some((x) => x.cwd === w.path)) return toast("A chat is still working there; close it first", "warning");
		const st = await crust.worktree.status(w.path);
		if (!st.ok || !st.managed) return toast(st.error || "Couldn't check the worktree", "error");
		const ask = await showDialog({
			method: "confirm",
			title: st.dirty ? "Force-remove the worktree?" : "Remove the worktree?",
			message: st.dirty ? `The branch “${w.branch}” stays, but ${st.changes} uncommitted change${st.changes === 1 ? "" : "s"} would be lost.` : `The branch “${w.branch}” stays; only the checkout folder is removed.`,
			yesLabel: st.dirty ? "Force remove" : "Remove",
			noLabel: "Keep",
			danger: st.dirty,
		});
		if (ask.confirmed) await removeAt(w.path, w.branch, st.dirty);
	}

	// --- the chevron menu next to ＋ -------------------------------------------------------------
	const btn = $("#new-chat-menu");
	let menu = null;
	function closeMenu() {
		if (!menu) return;
		menu.remove();
		menu = null;
		btn.setAttribute("aria-expanded", "false");
		removeEventListener("pointerdown", onOutside, true);
		removeEventListener("keydown", onKey, true);
	}
	const onOutside = (e) => {
		if (menu && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu();
	};
	const onKey = (e) => {
		if (!menu) return;
		const rows = [...menu.querySelectorAll(".pal-item")];
		const i = rows.indexOf(document.activeElement);
		if (e.key === "Tab") closeMenu(); // focus moves on naturally
		else if (e.key === "Escape") {
			e.stopPropagation();
			closeMenu();
			btn.focus();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
		}
	};
	function openMenu() {
		closeMenu();
		menu = el("div", "slash-menu wt-menu");
		menu.setAttribute("role", "menu");
		const item = (label, desc, run) => {
			const row = el("button", "pal-item");
			row.type = "button";
			row.setAttribute("role", "menuitem");
			row.append(el("span", "label", label), el("span", "desc", desc));
			row.onclick = () => {
				closeMenu();
				run();
			};
			return row;
		};
		menu.append(item("New chat", keyLabel("⌘N"), () => newChat()), item("New chat in worktree…", "own branch and folder", newWorktreeChat));
		document.body.append(menu);
		const r = btn.getBoundingClientRect();
		menu.style.top = `${r.bottom + 4}px`;
		menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
		btn.setAttribute("aria-expanded", "true");
		addEventListener("pointerdown", onOutside, true);
		addEventListener("keydown", onKey, true);
		menu.querySelector(".pal-item").focus();
	}
	btn.addEventListener("click", () => (menu ? closeMenu() : openMenu()));

	const prev = window.crustPaletteActions;
	window.crustPaletteActions = () => [...(prev?.() || []), { label: "New chat in worktree…", desc: "own branch and folder", run: newWorktreeChat }, { label: "Worktrees…", desc: "list and remove the ones Pi Crust made", run: manageWorktrees }];
	window.newWorktreeChat = newWorktreeChat;

	// --- self-test: create a worktree in this repo, chat in it, check, remove it (in finally) ------
	selftestSteps.push(async ({ snap, wait }) => {
		if (!info.repo) return;
		const branch = `pi/selftest-${Date.now().toString(36)}`;
		let made = null;
		try {
			switchTab("changes");
			made = await crust.worktree.create({ branch });
			console.error(`SELFTEST worktree create: ${made.ok ? made.cwd.replace(/^.*[\\/]worktrees[\\/]/, ".../worktrees/") : made.error} -> ${made.ok ? "OK" : "MISMATCH"}`);
			if (!made.ok) return;
			const mainFirst = active;
			await newChat(null, "worktree test", { cwd: made.cwd, branch });
			const c = active;
			for (let i = 0; i < 120 && !c.state.ready; i++) await wait(500);
			const inf = await crust.worktree.selftestInfo(c.id);
			const norm = (p) => (isWin ? p.replace(/\\/g, "/").toLowerCase() : p.replace(/^\/private/, ""));
			const same = (a, b) => a && b && norm(a) === norm(b);
			console.error(`SELFTEST worktree chat: ready=${c.state.ready} cwd=${same(inf?.cwd, made.cwd)} process cwd=${inf?.procCwd ? same(inf.procCwd, made.cwd) : "unknown"} badge=${!!document.querySelector(".chat-tab .ct-wt")} -> ${c.state.ready && same(inf?.cwd, made.cwd) && (!inf.procCwd || same(inf.procCwd, made.cwd)) && document.querySelector(".chat-tab .ct-wt") ? "OK" : "MISMATCH"}`);
			await snap("worktree-tab");
			await crust.worktree.selftestWrite(made.cwd, "selftest-worktree.txt", "hello\n");
			await loadChanges();
			await wait(500);
			const inWt = changes.some((x) => x.path === "selftest-worktree.txt");
			const mainSt = await crust.fs.gitStatus(true);
			console.error(`SELFTEST worktree changes: in worktree=${inWt} in main=${"selftest-worktree.txt" in mainSt.files} banner=${!!document.querySelector(".changes-banner")} -> ${inWt && !("selftest-worktree.txt" in mainSt.files) && document.querySelector(".changes-banner") ? "OK" : "MISMATCH"}`);
			await snap("worktree-changes");
			const was = themeSetting();
			setTheme(currentTheme() === "dark" ? "light" : "dark");
			await wait(500);
			await snap(`worktree-changes-${currentTheme()}`);
			setTheme(was);
			await wait(300);
			// the chevron menu
			btn.click();
			await wait(300);
			const mr = menu?.getBoundingClientRect();
			const shown = !!mr && mr.width > 0 && mr.height > 0 && mr.right <= innerWidth && mr.bottom <= innerHeight && getComputedStyle(menu).opacity !== "0";
			console.error(`SELFTEST worktree menu: ${menu ? menu.querySelectorAll(".pal-item").length : 0} items, rect=${mr ? [mr.x, mr.y, mr.width, mr.height].map(Math.round) : "none"} shown=${shown} -> ${menu?.querySelectorAll(".pal-item").length === 2 && shown ? "OK" : "MISMATCH"}`);
			await snap("worktree-menu");
			closeMenu();
			// the main chat sees the main checkout again
			activate(mainFirst);
			await wait(800);
			console.error(`SELFTEST worktree switch back: file in main changes=${changes.some((x) => x.path === "selftest-worktree.txt")} banner=${!!document.querySelector(".changes-banner")} -> ${!changes.some((x) => x.path === "selftest-worktree.txt") && !document.querySelector(".changes-banner") ? "OK" : "MISMATCH"}`);
			// closing the worktree chat asks about the worktree (dirty: Force remove)
			activate(c);
			await wait(500);
			const closing = closeChat(c);
			for (let i = 0; i < 20 && !document.querySelector("#modal-backdrop:not([hidden]) .modal-actions"); i++) await wait(250);
			const title = document.querySelector("#modal h2")?.textContent;
			await snap("worktree-remove");
			document.querySelector("#modal .modal-actions button:last-child")?.click();
			await closing;
			for (let i = 0; i < 40 && (await crust.worktree.selftestExists(made.cwd)); i++) await wait(250);
			const gone = !(await crust.worktree.selftestExists(made.cwd));
			console.error(`SELFTEST worktree remove: dialog "${title}" folder removed=${gone} -> ${title === "Force-remove the worktree?" && gone ? "OK" : "MISMATCH"}`);
		} catch (e) {
			console.error("SELFTEST worktree failed", e);
		} finally {
			if (made?.ok) {
				if (await crust.worktree.selftestExists(made.cwd)) await crust.worktree.remove({ cwd: made.cwd, force: true });
				const del = await crust.worktree.selftestDeleteBranch(branch);
				console.error(`SELFTEST worktree cleanup: branch ${branch} deleted=${del.ok}, folder gone=${!(await crust.worktree.selftestExists(made.cwd))}`);
			}
		}
	});
})();
