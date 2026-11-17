// The Pi Crust update card, in its own corner at the bottom left of the window (#app-update-host), apart from the
// notifications above the chat (#toasts). update-main.js checks
// Pi Crust's own git clone on start and every hour. Nothing quits by itself:
//   available -> Update (prepares in the background: pull, and for the installed app build the installer)
//   ready     -> Restart now (asks first when chats are still working) or Later (the installed app installs on quit)
// Later / Dismiss hides the card until something new happens.
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
	const keyOf = (s) => (s.state === "available" ? `available:${s.count}:${!!s.blocked}` : s.state === "error" ? `error:${s.message}` : s.state);

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
		const show = ["available", "updating", "ready", "error", "restarting"].includes(last.state) && keyOf(last) !== dismissed;
		if (!show) return card.remove();
		card.className = `toast app-update au-${last.state}`;
		card.removeAttribute("title");
		const body = el("div", "au-body");
		const actions = el("div", "au-actions");
		let icon = ARROW;
		if (last.state === "available") {
			body.append(el("span", "au-title", "Pi Crust update available"), el("span", "au-sub", last.blocked || `${last.count} new commit${last.count === 1 ? "" : "s"}. Prepared in the background; you choose when to restart.`));
			card.title = (last.blockedDetail ? `${last.blockedDetail}\n\n` : "") + last.commits.join("\n") + (last.count > last.commits.length ? "\n…" : "");
			const up = button("Update", "", () => {
				up.disabled = true;
				crust.appUpdate.run();
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
			actions.append(later());
		} else if (last.state === "updating") {
			icon = SPIN;
			body.append(el("span", "au-title", "Preparing the update…"), el("span", "au-sub", `${last.step || ""}\nYou can keep working.`));
			actions.append(later("Hide"));
		} else if (last.state === "ready") {
			icon = CHECK;
			body.append(
				el("span", "au-title", "Update ready"),
				el("span", "au-sub", last.installed ? "Restart Pi Crust to use it, or it installs when you quit." : "Restart Pi Crust to use it, or it's used the next time you start it."),
			);
			const r = button("Restart now", "", () => restartNow(r));
			actions.append(r, later());
		} else if (last.state === "restarting") {
			icon = SPIN;
			body.append(el("span", "au-title", "Restarting Pi Crust…"));
		} else if (last.state === "error") {
			body.append(el("span", "au-title", "Update failed"), el("span", "au-sub", last.message || ""));
			card.title = last.message || "";
			const retry = button("Retry", "secondary", () => {
				retry.disabled = true;
				crust.appUpdate.check().then((st) => (st.state === "available" && !st.blocked ? crust.appUpdate.run() : render(st)));
			});
			actions.append(retry, later("Dismiss"));
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
})();
