// Run a Mendix app: the bar under the Viewer's address bar, its log drawer, the "Mendix: …" palette commands and
// the "mendix" self-test step. The work happens in mendix-main.js (docker build/run, state machine).
"use strict";

(() => {
	const bar = $("#mendix-bar");
	const drawer = $("#mendix-log");
	const MAX_LINES = 2000;
	let status = { state: "none" };
	let logLines = [];
	let logOpen = false;
	let more = false;
	let opened = false; // a start from this window: open the Viewer when it is running
	let prevState = "none";
	let lastSig = "";
	let labelEl = null;

	const STATE_LABEL = { idle: "Not running", checking: "Checking Docker…", building: "Building…", starting: "Starting…", stopping: "Stopping…", stopped: "Stopped", error: "Error" };
	const BUSY = new Set(["checking", "building", "starting", "stopping"]);

	function paintLabel(node) {
		const s = status;
		const ver = s.version ? `Mendix ${s.version.split(".").slice(0, 2).join(".")}` : "Mendix";
		if (s.state === "running") node.textContent = `${ver} · Running on :${s.port}`;
		else if (s.state === "error") node.textContent = `Error: ${(s.message || "").split("\n")[0]}`;
		else if (BUSY.has(s.state) && s.state !== "stopping") {
			const text = `${ver} · ${STATE_LABEL[s.state]}${s.step && s.state !== "checking" ? ` ${s.step}` : ""}`;
			startClock(node, s.since || Date.now(), (n, t) => (n.textContent = `${text} · ${t}`));
		} else node.textContent = `${ver} · ${STATE_LABEL[s.state] || ""}`;
		node.title = s.message || node.textContent;
	}

	function button(label, onClick, { cls = "btn tertiary", title } = {}) {
		const b = el("button", cls, label);
		b.type = "button";
		if (title) b.title = title;
		b.onclick = onClick;
		return b;
	}

	function render() {
		const s = status;
		bar.hidden = s.state === "none";
		if (bar.hidden) {
			lastSig = "";
			drawer.hidden = true;
			return;
		}
		// Same state: keep the buttons (a rebuilt button under the cursor loses the click), only update the label.
		const sig = [s.state, s.built, more, logOpen].join("|");
		if (sig === lastSig && labelEl?.isConnected) {
			paintLabel(labelEl);
			return;
		}
		lastSig = sig;
		const label = (labelEl = el("span", "md-label"));
		const dot = el("span", `md-dot md-${s.state}`);
		const row = [dot, label];
		const start = () => doStart(false);
		if (["idle", "stopped", "error"].includes(s.state)) {
			row.push(button("Start", start, { cls: "btn", title: "Build (the first time) and run the app" }));
			if (s.built) row.push(button("Rebuild", () => doStart(true), { title: "Compile the project again" }));
		} else if (s.state === "running") {
			row.push(button("Open", openApp, { cls: "btn", title: s.url }), button("Rebuild", () => doStart(true)), button("Stop", doStop));
		} else row.push(button("Stop", doStop, { title: s.state === "building" ? "Cancel the build" : "Stop" }));
		const logs = button("Logs", toggleLogs, { title: "Show the build and app log" });
		logs.setAttribute("aria-pressed", String(logOpen));
		const admin = button("Admin", copyAdmin, { title: `${s.adminUser} (click to copy the password)` });
		const moreBtn = button("⋯", () => ((more = !more), render()), { title: "More" });
		moreBtn.setAttribute("aria-expanded", String(more));
		row.push(logs, admin, moreBtn);
		if (more) row.push(button("Reset database…", resetDb, { title: "Delete this repo's Postgres data" }), button("Follow logs in Terminal", followInTerminal));
		bar.replaceChildren(...row);
		paintLabel(label);
		drawer.hidden = !logOpen;
	}

	async function doStart(rebuild) {
		opened = true;
		const r = await (rebuild ? crust.mendix.rebuild() : crust.mendix.start());
		if (r?.busy) toast("Already working on it.");
	}
	const doStop = () => crust.mendix.stop();
	function openApp() {
		if (!status.url) return;
		switchTab("browser");
		crust.browser.navigate(status.url);
	}
	async function copyAdmin() {
		const r = await crust.mendix.copyPassword();
		if (r?.ok) toast(`Admin password copied (user ${status.adminUser})`);
	}
	async function resetDb() {
		const ok = await showDialog({ method: "confirm", title: "Reset the Mendix database?", message: `Deletes the Postgres data for this repo (volume ${status.names?.volume}). The app restarts with an empty database.`, yesLabel: "Reset", danger: true });
		if (ok) crust.mendix.resetDb();
	}
	function followInTerminal() {
		if (status.names?.app) runInTerminal(`docker logs -f --tail 200 ${shellQuote(status.names.app)}`);
	}
	async function toggleLogs() {
		logOpen = !logOpen;
		if (logOpen) {
			logLines = await crust.mendix.logs();
			paintLog(true);
		}
		render();
	}
	function paintLog(all) {
		if (!logOpen) return;
		const atEnd = drawer.scrollTop + drawer.clientHeight >= drawer.scrollHeight - 8;
		let pre = drawer.firstChild;
		if (!pre) drawer.append((pre = el("pre")));
		if (all) pre.textContent = logLines.join("\n");
		if (atEnd || all) drawer.scrollTop = drawer.scrollHeight;
	}

	crust.mendix.onLog((m) => {
		if (m.reset) logLines = [];
		logLines.push(...m.lines);
		if (logLines.length > MAX_LINES) logLines.splice(0, logLines.length - MAX_LINES);
		if (logOpen) paintLog(true);
	});

	async function onStatus(s) {
		status = s;
		const was = prevState;
		prevState = s.state;
		render();
		if (s.state === "running" && was !== "running" && opened && !s.adopted) {
			opened = false;
			openApp();
			toast(`Mendix app running on :${s.port}. Admin: ${s.adminUser}`, "info", { label: "Copy password", onClick: copyAdmin });
			if (!info.selftest && !(await crust.app.isFocused())) {
				try {
					new Notification("Mendix app is running", { body: s.url });
				} catch {}
			}
		} else if (s.state === "error" && opened) {
			opened = false;
			if (activeTab === "browser" || !logOpen) {
				logOpen = true;
				crust.mendix.logs().then((l) => ((logLines = l), paintLog(true)));
				render();
			}
		}
	}
	crust.mendix.onStatus(onStatus);
	const detect = () => crust.mendix.detect().then(onStatus);
	detect();
	crust.repos.onChanged(detect);

	const prevActions = window.crustPaletteActions;
	window.crustPaletteActions = () => {
		const base = prevActions?.() || [];
		if (status.state === "none") return base;
		const run = (fn) => () => fn();
		return [
			...base,
			{ label: "Mendix: start app", desc: "build and run with Docker", run: run(() => doStart(false)) },
			{ label: "Mendix: stop app", desc: "stop the app container", run: run(doStop) },
			{ label: "Mendix: rebuild", desc: "compile the project again and restart", run: run(() => doStart(true)) },
			{ label: "Mendix: open in Viewer", desc: status.url || "when it runs", run: run(openApp) },
			{ label: "Mendix: show logs", desc: "build and app log", run: run(() => (switchTab("browser"), logOpen ? 0 : toggleLogs())) },
			{ label: "Mendix: copy admin password", desc: `user ${status.adminUser}`, run: run(copyAdmin) },
			{ label: "Mendix: follow logs in Terminal", desc: "docker logs -f", run: run(followInTerminal) },
			{ label: "Mendix: reset database…", desc: "delete this repo's Postgres data", run: run(resetDb) },
		];
	};

	selftestSteps.push(async ({ snap, wait }) => {
		const check = (name, ok, detail = "") => console.error(`SELFTEST mendix ${name}: ${detail} -> ${ok ? "OK" : "MISMATCH"}`);
		const until = async (fn, ms = 20000) => {
			const t0 = Date.now();
			while (Date.now() - t0 < ms) {
				if (fn()) return true;
				await wait(150);
			}
			return false;
		};
		const click = (label) => [...bar.querySelectorAll("button")].find((b) => b.textContent === label)?.click();
		switchTab("browser");
		await crust.mendix.selftestFake({});
		await onStatus(await crust.mendix.detect());
		await until(() => !bar.hidden, 3000);
		check("bar", !bar.hidden && status.state === "idle", `state=${status.state}`);
		click("Logs");
		click("Start");
		const ran = await until(() => status.state === "running");
		check("start", ran, `state=${status.state} ${status.message}`);
		await until(() => (liveBrowserUrl || "").startsWith(`http://localhost:${status.port}`), 5000);
		check("browser", (liveBrowserUrl || "").startsWith(`http://localhost:${status.port}`), `url=${liveBrowserUrl}`);
		check("log", logLines.length > 5, `${logLines.length} lines`);
		check("secret", !!status.adminPassword && !logLines.join("\n").includes(status.adminPassword), "password not in log");
		await wait(1200);
		await snap("mendix-running");
		click("Stop");
		check("stop", await until(() => status.state === "stopped", 8000), `state=${status.state}`);
		await crust.mendix.selftestFake({ version: "7.23.0.1234" });
		await onStatus(await crust.mendix.detect());
		click("Start");
		const unsupported = await until(() => status.state === "error", 8000);
		check("unsupported", unsupported && /isn't supported/.test(status.message), status.message);
		await wait(1200);
		await snap("mendix-error");
		await crust.mendix.selftestFake({ failBuild: true });
		await onStatus(await crust.mendix.detect());
		click("Start");
		check("failBuild", await until(() => status.state === "error", 8000), `state=${status.state} ${status.message}`);
		await crust.mendix.selftestFake({});
		await onStatus(await crust.mendix.detect());
		click("Start");
		check("building", await until(() => status.state === "building", 5000), `state=${status.state}`);
		const stopBtn = [...bar.querySelectorAll("button")].find((b) => b.textContent === "Stop");
		await wait(600); // status updates arrive while building; the Stop button must survive them
		check("stopKept", !!stopBtn && stopBtn.isConnected && status.state === "building", "Stop button kept during the build");
		click("Stop");
		check("stopBuild", await until(() => status.state === "stopped", 8000), `state=${status.state}`);
		await crust.mendix.selftestFake({}); // leaves no app running
		await crust.mendix.stop();
		logOpen = false;
		more = false;
		await crust.browser.navigate(info.devUrl);
	});
})();
