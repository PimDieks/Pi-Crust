"use strict";
// The install scripts are only ever run here with their dry-run switch: this test never installs anything.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const H = require("../src/health-install");

const ROOT = path.join(__dirname, "..");
const COMBOS = [["node"], ["git"], ["pi"], ["node", "git"], ["node", "pi"], ["git", "pi"], ["node", "git", "pi"]];
const canRun = (cmd, args) => {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
	return !r.error && r.status === 0;
};
const HAVE_PS = process.platform === "win32" && canRun("powershell.exe", ["-NoProfile", "-Command", "exit 0"]);
const HAVE_SH = canRun("bash", ["-c", "exit 0"]);

const dry = (platform, ids) => {
	const { cmd, args } = H.scriptCommand(ids, platform, true, ROOT);
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
	return { code: r.status, lines: String(r.stdout || "").split(/\r?\n/).filter(Boolean), stderr: String(r.stderr || "") };
};

for (const [platform, have] of [["win32", HAVE_PS], ["darwin", HAVE_SH]]) {
	for (const ids of COMBOS) {
		test(`${platform} dry run for ${ids.join(",")} prints exactly the planned steps`, { skip: !have && "shell not available here" }, () => {
			const plan = H.installPlan(ids, platform);
			const r = dry(platform, ids);
			assert.equal(r.code, 0, r.stderr);
			assert.ok(r.lines.length > 0, "a script that prints nothing fails");
			assert.deepEqual(r.lines.slice(0, -1), plan.steps.map((s) => `WOULD ${s.id}: ${s.command}`));
			assert.match(r.lines.at(-1), /^RESULT dry-run/);
			// the confirm lists the same steps the dry run lists
			for (const s of plan.steps) assert.ok(plan.text.includes(s.title) && plan.text.includes(s.from), `${s.id} is in the confirm text`);
			assert.equal(plan.steps.length, ids.length);
		});
	}
	test(`${platform} script refuses a bad or empty list and plans nothing`, { skip: !have && "shell not available here" }, () => {
		const bad = H.scriptCommand(["pi"], platform, true, ROOT);
		for (const needs of ["", "foo", "pi,rm"]) {
			const args = bad.args.map((a) => (a === "pi" ? needs : a));
			const r = spawnSync(bad.cmd, args, { encoding: "utf8", timeout: 30_000 });
			assert.equal(r.status, 2, `needs "${needs}"`);
			assert.ok(!/WOULD/.test(r.stdout), "nothing planned");
			assert.match(r.stdout, /^FAIL args/m);
		}
	});
}

test("the confirm text names what and from where, and only what is needed", () => {
	const p = H.installPlan(["pi", "git"], "win32");
	assert.deepEqual(p.steps.map((s) => s.id), ["git", "pi"], "install order, not request order");
	assert.match(p.text, /Git, from the winget package Git\.Git/);
	assert.match(p.text, /@earendil-works\/pi-coding-agent/);
	assert.ok(!/Node/.test(p.text));
	assert.match(p.text, /Windows may ask you to confirm/);
	assert.ok(!/Windows may ask/.test(H.installPlan(["pi"], "darwin").text));
});

test("installPlan: nothing to install, unknown ids, unsupported system", () => {
	assert.equal(H.installPlan([], "win32").ok, false);
	assert.equal(H.installPlan(["rm -rf"], "win32").ok, false, "unknown ids are dropped, nothing is left");
	const linux = H.installPlan(["pi"], "linux");
	assert.equal(linux.ok, false);
	assert.ok(linux.manual.some((l) => /npm install -g @earendil-works\/pi-coding-agent/.test(l)));
});

// --- the runner, with a stubbed spawn ---------------------------------------------------------------------------
function fakeSpawn(output, code, { error } = {}) {
	const calls = [];
	const spawn = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.stdout.setEncoding = proc.stderr.setEncoding = () => {};
		setImmediate(() => {
			if (error) return proc.emit("error", error);
			proc.stdout.emit("data", output);
			proc.emit("close", code);
		});
		return proc;
	};
	return { spawn, calls };
}

test("runner: success streams the events in order and reports ok", async () => {
	const f = fakeSpawn("STEP git: Git\nsome winget text\nDONE git\nSTEP pi: Pi, the coding agent\nDONE pi\nRESULT ok\n", 0);
	const events = [];
	const r = await H.runInstall({ needs: ["pi", "git"], platform: "win32", spawn: f.spawn, onEvent: (e) => events.push(`${e.kind}${e.id ? ":" + e.id : ""}`) });
	assert.equal(r.ok, true);
	assert.deepEqual(events, ["start", "step:git", "text:git", "done:git", "step:pi", "done:pi", "result:pi", "end"]);
	assert.equal(f.calls[0].cmd, "powershell.exe");
	assert.ok(f.calls[0].args.includes("git,pi") && !f.calls[0].args.includes("-DryRun"));
});

test("runner: dry run passes the switch on", async () => {
	const f = fakeSpawn("WOULD pi: x\nRESULT dry-run (nothing was changed)\n", 0);
	const r = await H.runInstall({ needs: ["pi"], platform: "win32", dryRun: true, spawn: f.spawn });
	assert.equal(r.ok, true);
	assert.equal(r.dryRun, true);
	assert.ok(f.calls[0].args.includes("-DryRun"));
	const m = fakeSpawn("RESULT dry-run\n", 0);
	await H.runInstall({ needs: ["pi"], platform: "darwin", dryRun: true, spawn: m.spawn });
	assert.equal(m.calls[0].cmd, "bash");
	assert.ok(m.calls[0].args.includes("--dry-run"));
});

test("runner: a failing step is an error with the step named, never ok", async () => {
	const f = fakeSpawn("STEP node: Node.js (current LTS)\nsome output\nFAIL node: exit 1603\n", 1);
	const r = await H.runInstall({ needs: ["node", "pi"], platform: "win32", spawn: f.spawn });
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, "node");
	assert.equal(r.error, "Installing Node.js (current LTS) didn't work: exit 1603.");
	assert.match(r.details, /some output/);
	assert.ok(r.manual.length > 1);
});

test("runner: exit 0 without the closing RESULT line is a failure (a silent script must not look like success)", async () => {
	for (const out of ["", "DONE pi\n"]) {
		const r = await H.runInstall({ needs: ["pi"], platform: "win32", spawn: fakeSpawn(out, 0).spawn });
		assert.equal(r.ok, false);
		assert.match(r.error, /stopped without saying it finished/);
	}
});

test("runner: a non-zero exit without a FAIL line is still an error", async () => {
	const r = await H.runInstall({ needs: ["pi"], platform: "win32", spawn: fakeSpawn("", 7).spawn });
	assert.equal(r.ok, false);
	assert.equal(r.error, "The installer stopped (exit code 7).");
});

test("runner: exit 3 means blocked and carries the manual steps", async () => {
	const f = fakeSpawn("STEP node: Node.js (current LTS)\nFAIL node: winget (the Windows package manager) was not found on this computer\n", 3);
	const r = await H.runInstall({ needs: ["node", "pi"], platform: "win32", spawn: f.spawn });
	assert.equal(r.blocked, true);
	assert.equal(r.ok, false);
	assert.match(r.error, /winget/);
	assert.ok(r.manual.some((l) => /nodejs\.org/.test(l)) && r.manual.some((l) => /npm install -g @earendil-works/.test(l)));
});

test("runner: the program can't be started", async () => {
	const err = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
	const r = await H.runInstall({ needs: ["pi"], platform: "win32", spawn: fakeSpawn("", 0, { error: err }).spawn });
	assert.equal(r.ok, false);
	assert.match(r.error, /Couldn't start the installer/);
});

test("runner: only known ids ever reach the script", async () => {
	const f = fakeSpawn("RESULT ok\n", 0);
	await H.runInstall({ needs: ["pi", "evil; rm -rf /", "git"], platform: "win32", spawn: f.spawn });
	assert.ok(f.calls[0].args.includes("git,pi"));
	assert.ok(!f.calls[0].args.some((a) => /evil/.test(a)));
	const none = await H.runInstall({ needs: ["evil"], platform: "win32", spawn: f.spawn });
	assert.equal(none.ok, false);
	assert.equal(f.calls.length, 1, "nothing was started");
});

test("a real dry run through the runner on this machine changes nothing and reports ok", { skip: !(HAVE_PS || HAVE_SH) && "no shell" }, async () => {
	const platform = HAVE_PS ? "win32" : "darwin";
	const r = await H.runInstall({ needs: ["node", "git", "pi"], platform, dryRun: true });
	assert.equal(r.ok, true, r.error);
	assert.equal(r.lines.filter((l) => l.startsWith("WOULD ")).length, 3);
});

// --- what is missing decides the list (the IPC handlers, with the real health logic and a stub machine) -----------------
const L = require("../src/health-logic");
function handlers(stub, platform = "win32") {
	const map = {};
	const sent = [];
	const spawned = [];
	const ctx = {
		ipcMain: { handle: (name, fn) => (map[name] = fn) },
		selftest: true,
		env: process.env,
		send: (ch, e) => sent.push(e),
		health: { check: async () => L.buildHealth(L.stubFacts(stub)) },
	};
	H.register(ctx);
	return { map, sent, spawned };
}

test("Git is installed: the plan has no Git line and no Git step", async () => {
	const h = handlers({ pi: "missing", node: "missing" });
	const r = await h.map["health:installPlan"]({}, {});
	assert.deepEqual(r.needs, ["node", "pi"]);
	assert.deepEqual(r.plan.steps.map((s) => s.id), ["node", "pi"]);
	assert.ok(!/Git/.test(r.plan.text), r.plan.text);
});

test("Git is installed: the runner is asked for node and pi only (dry run)", { skip: !(HAVE_PS || HAVE_SH) && "no shell" }, async () => {
	const h = handlers({ pi: "missing", node: "missing" });
	const plan = await h.map["health:installPlan"]({}, {});
	const r = await h.map["health:install"]({}, { token: plan.token });
	assert.equal(r.ok, true, r.error);
	assert.equal(r.dryRun, true);
	const would = r.lines.filter((l) => l.startsWith("WOULD "));
	assert.equal(would.length, 2, would.join(", "));
	assert.ok(!would.some((l) => /git/i.test(l)), would.join(", "));
});

test("Git missing too: all three are listed, in order", async () => {
	const h = handlers({ pi: "missing", node: "missing", git: "missing" });
	const r = await h.map["health:installPlan"]({}, {});
	assert.deepEqual(r.plan.steps.map((s) => s.id), ["node", "git", "pi"]);
});

test("everything is installed: nothing to plan, nothing to run, and no row offers an install button", async () => {
	const h = handlers({});
	const r = await h.map["health:installPlan"]({}, {});
	assert.deepEqual(r.needs, []);
	assert.equal(r.plan.ok, false);
	assert.equal(r.token, null, "nothing to confirm, so no token");
	const run = await h.map["health:install"]({}, {});
	assert.equal(run.ok, false);
	assert.equal(run.noToken, true, "an install without a confirmed list does nothing");
	const rows = L.buildHealth(L.stubFacts({})).rows;
	assert.ok(!rows.some((x) => x.action && /^(install|update)-/.test(x.action.id)));
});

test("the scripts install the same package and version as src/pi-package.js", () => {
	const { PI_PACKAGE } = require("../src/pi-package");
	const spec = `${PI_PACKAGE.name}@${PI_PACKAGE.version}`;
	for (const f of ["install-pi.ps1", "install-pi.sh"]) assert.ok(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8").includes(spec), f);
	assert.ok(H.PLAN.win32.pi.command.includes(spec) && H.PLAN.darwin.pi.command.includes(spec));
	assert.ok(H.manualSteps(["pi"], "win32").some((l) => l.includes(spec)));
});

test("Pi fine, only Git missing: the Git button plans Git alone", async () => {
	const h = handlers({ git: "missing" });
	const r = await h.map["health:installPlan"]({}, { only: ["git"] });
	assert.deepEqual(r.plan.steps.map((s) => s.id), ["git"]);
});
