// Setup health: self-test steps only (the UI that shows the rows is the welcome view, later).
//  - `health`:          drives the main-process health check through stub states (PI_CRUST_HEALTH_STUB=<json>, selftest only)
//                       and compares every row's state, words and button with the table in the phase 5 plan.
//  - `onboarding-exit`: a chat whose Pi is really missing (PI_CRUST_SELFTEST_NO_PI=1, selftest only): see the step below.
// Run: PI_CRUST_HEALTH_STUB={} PI_CRUST_SELFTEST_OFFSCREEN=1 PI_CRUST_SELFTEST_NOPROMPT=1 npm run selftest -- health
(() => {
	const rowsOf = (r) => r.rows.map((x) => `${x.id}|${x.state}|${x.line}|${x.action ? x.action.label : "-"}`);
	// [name, stub, figma asked?, expected rows]. The words are written out here on purpose: they are not taken from health-logic.js.
	const CASES = [
		[
			"nothing-ready",
			{ pi: "missing", node: "missing", auth: "none", git: "missing", project: "none", figma: "not_reachable" },
			[
				"pi|todo|Pi isn't installed on this computer. Pi Crust can install it for you.|Install Pi",
				"auth|todo|Install Pi first, then sign in.|-",
				"git|todo|Git isn't installed. Pi Crust needs it to show your changes and to undo.|Install Git",
				"project|todo|Pick the folder you want to work on.|Choose folder",
				"figma|todo|Figma isn't connected. You can do this later.|Set up Figma",
			],
			{ ready: false, counts: "0/4", needs: "node,git,pi" },
		],
		[
			"all-ready",
			{ figma: "ready" },
			[
				"pi|ready|Pi 1.4.0 is installed.|-",
				"auth|ready|Signed in to Claude.|-",
				"git|ready|Git 2.47.1 is installed.|-",
				"project|ready|Working in /stub/site.|-",
				"figma|ready|Figma is ready.|-",
			],
			{ ready: true, counts: "4/4", needs: "" },
		],
		[
			"old-pi-no-auth-check",
			{ pi: "old", auth: "unknown", figma: "problem" },
			[
				"pi|todo|This Pi is too old (0.73.1). Install the current one.|Update Pi",
				"auth|unknown|Pi Crust can't check sign-in with this version of Pi.|Check again",
				"git|ready|Git 2.47.1 is installed.|-",
				"project|ready|Working in /stub/site.|-",
				"figma|unknown|Can't tell. Open Figma desktop and check again.|Check again",
			],
			{ ready: false, counts: "2/4", needs: "pi" },
		],
		[
			"env-key-and-plain-folder",
			{ auth: "env", project: "notgit" },
			[
				"pi|ready|Pi 1.4.0 is installed.|-",
				"auth|ready|Using an API key from your computer's settings.|-",
				"git|ready|Git 2.47.1 is installed.|-",
				"project|todo|That folder isn't a Git project yet. Make it one?|Make it a Git project",
				"figma|unknown|Not checked yet. You can set up Figma later in the Design tab.|Set up Figma",
			],
			{ ready: false, counts: "3/4", needs: "" },
		],
		[
			"cant-tell",
			{ pi: "unknown", git: "unknown", project: "unknown", auth: "none" },
			[
				"pi|unknown|Pi is installed, but Pi Crust can't read its version.|Check again",
				"auth|todo|Not signed in. Choose the account you already pay for.|Sign in",
				"git|unknown|Can't tell if Git is installed.|Check again",
				"project|unknown|Can't tell if that folder is a Git project.|Check again",
				"figma|unknown|Not checked yet. You can set up Figma later in the Design tab.|Set up Figma",
			],
			{ ready: false, counts: "0/4", needs: "" },
		],
	];

	selftestSteps.push(async () => {
		if (!crust.health || !crust.health.stubSet) return console.error("SELFTEST health: no stub hook -> MISMATCH");
		// Without PI_CRUST_HEALTH_STUB main has no stubSet handler: invoking it rejects. Say so loudly when this step was asked for.
		try {
			await crust.health.stubSet({});
		} catch {
			return console.error(`SELFTEST health: ${info?.selftestOnly?.includes("health") ? "needs PI_CRUST_HEALTH_STUB={} in the environment -> MISMATCH" : "skipped (needs PI_CRUST_HEALTH_STUB)"}`);
		}
		for (const [name, stub, want, extra] of CASES) {
			await crust.health.stubSet(stub);
			const r = await crust.health.check({ figma: !!stub.figma });
			const got = rowsOf(r);
			const rowsOk = got.length === want.length && got.every((g, i) => g === want[i]);
			const gotExtra = { ready: r.ready, counts: `${r.counts.done}/${r.counts.total}`, needs: r.needs.join(",") };
			const extraOk = JSON.stringify(gotExtra) === JSON.stringify(extra);
			console.error(`SELFTEST health ${name}: ready=${r.ready} ${gotExtra.counts} needs=[${gotExtra.needs}] -> ${rowsOk && extraOk ? "OK" : "MISMATCH"}`);
			if (!rowsOk) got.forEach((g, i) => g !== want[i] && console.error(`  row ${i}: got "${g}" want "${want[i]}"`));
		}
		// Pi shows up while the app runs: the stub flips, a recheck sees it, no restart.
		await crust.health.stubSet({ pi: "missing" });
		const before = (await crust.health.check()).rows[0].state;
		await crust.health.stubSet({});
		const after = (await crust.health.recheck()).rows[0].state;
		console.error(`SELFTEST health flip: ${before} -> ${after} -> ${before === "todo" && after === "ready" ? "OK" : "MISMATCH"}`);
		// Onboarding state stays in memory under the stub (the real settings.json is untouched).
		const o1 = await crust.health.onboarding();
		const set = await crust.health.onboardingSet("skippedAt");
		const o2 = await crust.health.onboarding();
		const bad = await crust.health.onboardingSet("../x");
		const cleared = await crust.health.onboardingSet("skippedAt", null);
		console.error(`SELFTEST health onboarding: ${JSON.stringify(Object.keys(o1))} -> ${JSON.stringify(Object.keys(o2))} bad=${bad.ok} cleared=${Object.keys(cleared.onboarding).length} -> ${!o1.skippedAt && set.ok && typeof o2.skippedAt === "number" && bad.ok === false && Object.keys(cleared.onboarding).length === 0 ? "OK" : "MISMATCH"}`);
	}, "health");

	// The real detectors on this machine, no stub (run it without PI_CRUST_HEALTH_STUB): prints what was found. Sign-in comes
	// from `pi auth check` through subscriptions-main, so a wired-up check shows a definite answer, not "can't tell", with a current Pi.
	selftestSteps.push(async () => {
		const r = await crust.health.check();
		const a = r.rows.find((x) => x.id === "auth");
		const wired = r.facts.pi.state !== "ok" || a.state !== "unknown";
		console.error(`SELFTEST health-real: ${r.rows.map((x) => `${x.id}=${x.state}`).join(" ")} pi=${r.facts.pi.version} node=${r.facts.node.version} git=${r.facts.git.version} auth="${a.line}" -> ${r.rows.length === 5 && wired ? "OK" : "MISMATCH"}`);
	}, "health-real");

	// Install through the real IPC, stubbed machine (PI_CRUST_HEALTH_STUB={}). A selftest always runs the script in dry-run mode, so
	// nothing is installed; the point here is the list for the confirm, the streamed events and that the machine is unchanged.
	selftestSteps.push(async () => {
		try {
			await crust.health.stubSet({});
		} catch {
			return console.error("SELFTEST health-install: needs PI_CRUST_HEALTH_STUB={} in the environment -> MISMATCH");
		}
		const events = [];
		crust.health.onInstallProgress((e) => events.push(e.kind + (e.id ? ":" + e.id : "")));
		await crust.health.stubSet({ pi: "missing", node: "old", git: "missing" });
		const p = await crust.health.installPlan();
		const planOk = p.needs.join() === "node,git,pi" && p.plan.ok && p.plan.lines.length === 3 && /Git, from the winget package Git.Git|Git, from the Homebrew formula git/.test(p.plan.text) && /Nothing else on this computer is changed./.test(p.plan.text);
		console.error(`SELFTEST health-install plan: needs=[${p.needs}] lines=${p.plan.lines.length} -> ${planOk ? "OK" : "MISMATCH"}`);
		const only = await crust.health.installPlan({ only: ["git"] });
		console.error(`SELFTEST health-install only git: needs=[${only.needs}] steps=${only.plan.steps.map((s) => s.id)} -> ${only.needs.join() === "git" && only.plan.steps.length === 1 ? "OK" : "MISMATCH"}`);
		const r = await crust.health.install({ only: ["pi", "git"] });
		const would = (r.lines || []).filter((l) => l.startsWith("WOULD ")).length;
		const stillMissing = r.health.rows[0].state === "todo"; // a dry run installed nothing, so Pi is still missing
		console.error(`SELFTEST health-install dry run: ok=${r.ok} dryRun=${r.dryRun} would=${would} events=[${events.join(" ")}] piStillMissing=${stillMissing} -> ${r.ok && r.dryRun && would === 2 && stillMissing && events[0] === "start" && events.at(-1) === "end" ? "OK" : "MISMATCH"}`);
		await crust.health.stubSet({});
		const none = await crust.health.installPlan();
		const nothing = await crust.health.install();
		console.error(`SELFTEST health-install nothing missing: plan.ok=${none.plan.ok} install.ok=${nothing.ok} "${nothing.error}" -> ${!none.plan.ok && !nothing.ok && nothing.error === "Nothing to install." ? "OK" : "MISMATCH"}`);
	}, "health-install");

	// A chat whose Pi is really missing. Run with PI_CRUST_SELFTEST_NO_PI=1: main skips the search and spawns a program that
	// doesn't exist, so the error is the real ENOENT from the real spawn. Without the variable this is the control run:
	// Pi starts and there must be no error box and no "Open setup" button. Either way "ENOENT" must not reach the screen.
	selftestSteps.push(async ({ snap, wait }) => {
		const noPi = !!info?.selftestNoPi;
		let opened = null;
		window.addEventListener("crust:open-setup", (e) => (opened = e.detail));
		for (let t = 0; t < 15000 && !(active.dead || active.state.ready); t += 100) await wait(100);
		const body = () => document.body.innerText;
		const errBoxes = () => [...document.querySelectorAll(".msg.error")];
		const btn = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent === label && b.offsetParent);
		const clean = !/ENOENT|spawn pi/i.test(body());
		if (!noPi) {
			const ok = active.state.ready && !active.dead && !errBoxes().length && !btn("Open setup") && clean;
			console.error(`SELFTEST onboarding-exit control: ready=${active.state.ready} errorBoxes=${errBoxes().length} openSetup=${!!btn("Open setup")} enoentOnScreen=${!clean} -> ${ok ? "OK" : "MISMATCH"}`);
			return;
		}
		const box = errBoxes().find((b) => b.textContent.startsWith("Pi isn't installed yet. Open setup to install it."));
		console.error(`SELFTEST onboarding-exit message: dead=${active.dead} box="${box ? box.textContent : errBoxes().map((b) => b.textContent).join(" | ")}" enoentOnScreen=${!clean} -> ${active.dead && box && clean ? "OK" : "MISMATCH"}`);
		await snap("onboarding-exit-message");
		btn("Open setup")?.click();
		console.error(`SELFTEST onboarding-exit button: event=${JSON.stringify(opened)} -> ${opened && opened.source === "pi-missing" && opened.chatId === active.id ? "OK" : "MISMATCH"}`);
		// typing into the dead chat: a toast that points at setup, not "Pi is still starting…"
		opened = null;
		notReadyToast();
		const toastEl = [...document.querySelectorAll(".toast")].find((t) => t.textContent.startsWith("Pi isn't running. Open setup."));
		toastEl?.querySelector("button")?.click();
		console.error(`SELFTEST onboarding-exit toast: "${toastEl ? toastEl.textContent : ""}" event=${opened && opened.source} -> ${toastEl && opened && opened.source === "toast" ? "OK" : "MISMATCH"}`);
		// Restart Pi with Pi still missing: the same message again (one new box), no crash, no ENOENT text.
		const n = errBoxes().length;
		await crust.pi.restart(active.id);
		for (let t = 0; t < 8000 && errBoxes().length === n; t += 100) await wait(100);
		const again = errBoxes().length === n + 1 && errBoxes().at(-1).textContent.startsWith("Pi isn't installed yet.") && !/ENOENT|spawn pi/i.test(body());
		console.error(`SELFTEST onboarding-exit restart: boxes ${n} -> ${errBoxes().length} -> ${again ? "OK" : "MISMATCH"}`);
	}, "onboarding-exit");
})();
