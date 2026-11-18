// The Pi Crust update card, in its own corner at the bottom left of the window (#app-update-host), apart from the
// notifications above the chat (#toasts). update-main.js checks
// Pi Crust's own git clone on start and every hour. Nothing quits by itself:
//   available -> Update (prepares in the background: pull, and for the installed app build the installer)
//   ready     -> Restart now (asks first when chats are still working) or Later (the installed app installs on quit)
// Later / Dismiss hides the card until something new happens.
// Installed release builds (update-main.js, release-updater.js) use the same card with release statuses: available (version),
// downloading (percent), ready, restarting, error (kind, message), offline, uptodate. Clone installs keep the git texts.
(() => {
	if (!window.crust?.appUpdate) return;
	const host = el("div");
	host.id = "app-update-host";
	document.body.append(host);

	const card = el("div", "toast app-update");
	card.setAttribute("role", "status");
	let dismissed = null; // key of the status the user put away
	let last = { state: "none" };

	const svg = (d) => {
		const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		s.setAttribute("viewBox", "0 0 16 16");
		s.setAttribute("aria-hidden", "true");
		s.innerHTML = d;
		return s;
	};
	const ARROW = '<path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
	const SPIN = '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
	const CHECK = '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
	const OFFLINE = '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 8h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
	const keyOf = (s) => (s.state === "available" ? `available:${s.version || s.count}:${!!s.blocked}` : s.state === "error" ? `error:${s.message}` : s.state);
	let hideTimer = null;

	function button(label, cls, onClick) {
		const b = el("button", `btn ${cls}`, label);
		b.type = "button";
		b.onclick = onClick;
		return b;
	}
	const later = (label = "Later") =>
		button(label, "naked", () => {
			dismissed = keyOf(last);
			render(last);
		});

	async function restartNow(btn) {
		const working = document.querySelectorAll(".chat-tab.busy").length;
		if (working) {
			const ok = await showDialog({
				method: "confirm",
				title: working === 1 ? "A chat is still working" : `${working} chats are still working`,
				message: "Restarting stops them. Your chats reopen after the restart, but replies in progress are cut off.",
				yesLabel: "Restart anyway",
				cancelLabel: "Wait",
			});
			if (!ok.confirmed) return;
		}
		btn.disabled = true;
		crust.appUpdate.restart();
	}

	function render(s) {
		last = s || { state: "none" };
		clearTimeout(hideTimer);
		const show = ["available", "updating", "downloading", "ready", "error", "restarting", "offline", "uptodate"].includes(last.state) && keyOf(last) !== dismissed;
		if (!show) return card.remove();
		card.className = `toast app-update au-${last.state}`;
		card.removeAttribute("title");
		const body = el("div", "au-body");
		const actions = el("div", "au-actions");
		const notes = () => button("Release notes", "naked", () => crust.appUpdate.openNotes?.());
		let icon = ARROW;
		if (last.state === "available") {
			body.append(
				el("span", "au-title", "Pi Crust update available"),
				el("span", "au-sub", last.blocked || (last.version ? `Version ${last.version} is ready to download. You choose when to restart.` : `${last.count} new commit${last.count === 1 ? "" : "s"}. Prepared in the background; you choose when to restart.`)),
			);
			if (!last.version) card.title = (last.blockedDetail ? `${last.blockedDetail}\n\n` : "") + last.commits.join("\n") + (last.count > last.commits.length ? "\n…" : "");
			const up = button("Update", "", () => {
				up.disabled = true;
				(last.version && crust.appUpdate.download ? crust.appUpdate.download() : crust.appUpdate.run());
			});
			up.disabled = !!last.blocked;
			if (last.blockedDetail) up.title = last.blockedDetail;
			actions.append(up);
			if (last.blocked) {
				const again = button("Check again", "secondary", () => {
					again.disabled = true;
					crust.appUpdate.check().then(render, () => (again.disabled = false));
				});
				actions.append(again);
			}
			if (last.version) actions.append(notes());
			actions.append(later());
		} else if (last.state === "updating" || last.state === "downloading") {
			icon = SPIN;
			const pct = Math.max(0, Math.min(100, Math.round(last.percent || 0)));
			body.append(el("span", "au-title", "Preparing the update…"));
			if (last.state === "downloading") {
				body.append(el("span", "au-sub", `Downloading ${last.version}: ${pct}%\nYou can keep working.`));
				const bar = el("div", "au-progress");
				bar.setAttribute("role", "progressbar");
				bar.setAttribute("aria-valuenow", String(pct));
				bar.append(el("div", "au-progress-fill"));
				bar.firstChild.style.width = `${pct}%`;
				body.append(bar);
			} else body.append(el("span", "au-sub", `${last.step || ""}\nYou can keep working.`));
			actions.append(later("Hide"));
		} else if (last.state === "ready") {
			icon = CHECK;
			body.append(
				el("span", "au-title", "Update ready"),
				el("span", "au-sub", last.installed || last.version ? "Restart Pi Crust to use it, or it installs when you quit." : "Restart Pi Crust to use it, or it's used the next time you start it."),
			);
			const r = button("Restart now", "", () => restartNow(r));
			actions.append(r);
			if (last.version) actions.append(notes());
			actions.append(later());
		} else if (last.state === "restarting") {
			icon = SPIN;
			body.append(el("span", "au-title", "Restarting Pi Crust…"));
		} else if (last.state === "error") {
			body.append(el("span", "au-title", "Update failed"), el("span", "au-sub", last.message || ""));
			card.title = last.message || "";
			if (last.kind) {
				const back = button("Go back to a previous version", "naked au-link", () => crust.appUpdate.openNotes?.());
				body.append(back);
			}
			const retry = button("Retry", "secondary", () => {
				retry.disabled = true;
				// after a failed download: download again; after a failed check: check again and show what it finds (never jump to downloading)
				if (last.phase === "download") Promise.resolve(crust.appUpdate.download ? crust.appUpdate.download() : crust.appUpdate.run()).then((st) => st && render(st));
				else crust.appUpdate.check().then(render);
			});
			actions.append(retry);
			if (last.kind) {
				const copy = button("Copy details", "secondary", () => {
					Promise.resolve(crust.appUpdate.copyDetails?.()).then(() => {
						copy.textContent = "Copied";
						setTimeout(() => (copy.textContent = "Copy details"), 2000);
					});
				});
				actions.append(copy);
			}
			actions.append(later("Dismiss"));
		} else if (last.state === "offline") {
			icon = OFFLINE;
			body.append(el("span", "au-title", "Couldn't check for updates"), el("span", "au-sub", "You're offline. Pi Crust will try again later."));
			const again = button("Check again", "secondary", () => {
				again.disabled = true;
				crust.appUpdate.check().then(render, () => (again.disabled = false));
			});
			actions.append(again, later("Dismiss"));
		} else if (last.state === "uptodate") {
			icon = CHECK;
			body.append(el("span", "au-title", "Pi Crust is up to date"), el("span", "au-sub", `You have ${last.version}.`));
			hideTimer = setTimeout(() => card.remove(), 4000); // goes away by itself
		}
		if (actions.childElementCount) body.append(actions);
		card.replaceChildren(svg(icon), body);
		if (card.parentNode !== host) host.prepend(card);
	}

	crust.appUpdate.onStatus(render);
	crust.appUpdate.status().then(render);

	// Checks now (the timer is off in the self-test). Behind its upstream it shows the card; otherwise nothing.
	// Update isn't pressed: it would pull into this clone.
	selftestSteps.push(async ({ snap, wait }) => {
		const s = await crust.appUpdate.check();
		await wait(400);
		const shown = card.isConnected;
		const ok = s.state === "available" ? shown && !!card.querySelector(".btn") : !shown;
		console.error(`SELFTEST app update: state=${s.state} count=${s.count ?? 0} blocked=${!!s.blocked} card=${shown ? JSON.stringify(card.innerText.replace(/\s+/g, " ")) : "hidden"} -> ${ok ? "OK" : "MISMATCH"}`);
		// The ready state, drawn from a fake status (nothing is restarted): check the card sits in the bottom-left corner.
		render({ state: "ready", installed: true });
		await wait(400);
		const c = card.getBoundingClientRect();
		const placed = c.left <= 32 && innerHeight - c.bottom <= 32 && c.right <= innerWidth / 2;
		console.error(`SELFTEST app update card placement: card=${Math.round(c.left)},${Math.round(c.top)}-${Math.round(c.right)},${Math.round(c.bottom)} window=${innerWidth}x${innerHeight} -> ${placed ? "OK" : "MISMATCH"}`);
		toast("A normal notification stays above the chat", "info");
		await wait(400);
		await snap("app-update");
		render(s);
	});

	// The blocked card, drawn from a fake status: "Check again" is there, Update is disabled, and pressing it calls check().
	// crust.appUpdate may be frozen by the preload bridge; then the press is proven by the button going disabled instead.
	selftestSteps.push(async ({ wait }) => {
		const before = last;
		dismissed = null;
		render({ state: "available", count: 2, commits: ["abc1234 one", "def5678 two"], blocked: "You have local changes", blockedDetail: "Commit or stash them first." });
		await wait(200);
		const again = [...card.querySelectorAll(".btn")].find((b) => b.textContent === "Check again");
		const up = [...card.querySelectorAll(".btn")].find((b) => b.textContent === "Update");
		let calls = 0;
		let stubbed = false;
		const real = crust.appUpdate.check;
		try {
			crust.appUpdate.check = () => (calls++, Promise.resolve({ state: "none" }));
			stubbed = crust.appUpdate.check !== real;
		} catch {}
		again?.click();
		const pressed = stubbed ? calls === 1 : !!again?.disabled;
		await wait(200);
		const ok = !!again && !!up?.disabled && pressed;
		console.error(`SELFTEST app update blocked card: checkAgain=${!!again} updateDisabled=${!!up?.disabled} ${stubbed ? `checkCalls=${calls}` : "check not stubbable, button disabled on press=" + pressed} -> ${ok ? "OK" : "MISMATCH"}`);
		if (stubbed) crust.appUpdate.check = real;
		render(before);
	});

	// Every state of the release-update card, drawn from stubbed statuses (nothing is checked, downloaded or restarted), in the dark and
	// the light theme: text, buttons, placement and "nothing cut off" per state, and one screenshot each.
	// Run alone with: npm run selftest -- app-update-cards
	selftestSteps.push(async ({ snap, wait }) => {
		const FAIL = {
			download: "Couldn't download the update. Check your connection and try again.",
			damaged: "The download was damaged, so it was not installed. This version still works.",
			blocked: "Windows or your antivirus blocked the update file.",
			locked: "Couldn't replace Pi Crust because a file is in use. Close other Pi Crust windows and retry.",
			signature: "The update is not signed by Nullvorm, so it was not installed.",
			unknown: "The update stopped. Use Copy details if you ask for help.",
		};
		const failed = (kind) => ({ name: `failed-${kind}`, status: { state: "error", kind, message: FAIL[kind], details: "x" }, title: "Update failed", sub: FAIL[kind], buttons: ["Go back to a previous version", "Retry", "Copy details", "Dismiss"] });
		const states = [
			{ name: "available", status: { state: "available", version: "0.2.1", notesUrl: "https://example.invalid/" }, title: "Pi Crust update available", sub: "Version 0.2.1 is ready to download. You choose when to restart.", buttons: ["Update", "Release notes", "Later"] },
			{ name: "downloading", status: { state: "downloading", version: "0.2.1", percent: 38 }, title: "Preparing the update…", sub: "Downloading 0.2.1: 38%\nYou can keep working.", buttons: ["Hide"], bar: 38 },
			{ name: "ready", status: { state: "ready", version: "0.2.1", notesUrl: "https://example.invalid/" }, title: "Update ready", sub: "Restart Pi Crust to use it, or it installs when you quit.", buttons: ["Restart now", "Release notes", "Later"] },
			{ name: "restarting", status: { state: "restarting" }, title: "Restarting Pi Crust…", sub: "", buttons: [] },
			...Object.keys(FAIL).map(failed),
			{ name: "offline", status: { state: "offline" }, title: "Couldn't check for updates", sub: "You're offline. Pi Crust will try again later.", buttons: ["Check again", "Dismiss"] },
			{ name: "uptodate", status: { state: "uptodate", version: "0.2.1" }, title: "Pi Crust is up to date", sub: "You have 0.2.1.", buttons: [] },
		];
		const before = last;
		const was = themeSetting();
		const norm = (t) => t.replace(/\s+/g, " ").trim();
		for (const theme of ["dark", "light"]) {
			setTheme(theme);
			await wait(450);
			for (const st of states) {
				dismissed = null;
				render(st.status);
				await wait(150);
				const c = card.getBoundingClientRect();
				const title = card.querySelector(".au-title")?.textContent || "";
				const sub = card.querySelector(".au-sub")?.textContent || "";
				const buttons = [...card.querySelectorAll(".btn:not(.au-link)")].map((b) => b.textContent);
				const subEl = card.querySelector(".au-sub");
				const cut = !!subEl && subEl.scrollHeight > subEl.clientHeight + 1; // clamped text
				const inside = [...card.querySelectorAll(".btn, .au-title, .au-sub, .au-progress")].every((n) => {
					const r = n.getBoundingClientRect();
					return r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.bottom <= c.bottom + 0.5;
				});
				const barPct = card.querySelector(".au-progress-fill") ? Math.round(card.querySelector(".au-progress-fill").getBoundingClientRect().width / card.querySelector(".au-progress").getBoundingClientRect().width * 100) : null;
				const placed = card.isConnected && c.left <= 32 && innerHeight - c.bottom <= 32 && c.right <= innerWidth / 2;
				const textOk = title === st.title && norm(sub) === norm(st.sub);
				const btnOk = JSON.stringify(buttons) === JSON.stringify(st.buttons.filter((b) => b !== "Go back to a previous version"));
				const backOk = st.buttons.includes("Go back to a previous version") === !!card.querySelector(".au-link");
				const barOk = st.bar == null ? barPct == null : barPct === st.bar;
				const ok = textOk && btnOk && backOk && barOk && placed && inside && !cut;
				console.error(
					`SELFTEST app update card ${theme}/${st.name}: title=${JSON.stringify(title)} sub=${JSON.stringify(norm(sub))} buttons=${JSON.stringify(buttons)} back=${!!card.querySelector(".au-link")} bar=${barPct} rect=${Math.round(c.left)},${Math.round(c.top)},${Math.round(c.right)},${Math.round(c.bottom)} dpr=${devicePixelRatio} text=${textOk} buttonsOk=${btnOk} bar=${barOk} placed=${placed} inside=${inside} cut=${cut} -> ${ok ? "OK" : "MISMATCH"}`,
				);
				await wait(500); // an offscreen window paints late: without this the capture shows the previous state
				await snap(`au-cards-${theme}-${st.name}`); // first capture of an offscreen window is the previous frame,
				await wait(300);
				await snap(`au-cards-${theme}-${st.name}`); // so take it twice: the second one overwrites the first and is current
			}
		}
		setTheme(was);
		dismissed = null;
		render(before);
	}, "app-update-cards");
})();
