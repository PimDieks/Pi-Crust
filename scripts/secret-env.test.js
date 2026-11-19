"use strict";
// Secret-looking variables: the shared name rule, the keep list, the prefix per shell, the Pi permission extension that adds it, and real
// runs of the produced command in Git Bash and PowerShell. Dummy variables are set by the test itself, in an environment object it builds;
// the real environment is only read to find the shell programs (ProgramFiles, SystemRoot). Only NAMES are ever printed or compared.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const SRC = path.join(__dirname, "..", "src");
const S = require(path.join(SRC, "secret-env.js"));
const L = require(path.join(SRC, "permission-logic.js"));
const WIN = process.platform === "win32";
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "secret-env-")));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PS_TAIL = " | ForEach-Object { [Environment]::SetEnvironmentVariable($_, $null, 'Process'); Remove-Item -LiteralPath ('Env:' + $_) -ErrorAction SilentlyContinue }";
// The hidden names are on the first line, alone; what follows is the person's command (posix) or the wrapper of it (PowerShell).
const firstLine = (cmd) => cmd.split("\n")[0];
const posixNames = (cmd) => firstLine(cmd).replace(/^unset -v /, "").split(" ").sort();
const psNames = (cmd) => firstLine(cmd).replace(PS_TAIL, "").split(",").map((s) => s.replace(/^'|'$/g, "")).sort();
const afterFirstLine = (cmd) => cmd.slice(cmd.indexOf("\n") + 1);
// The command the PowerShell wrapper carries, decoded.
const psCarried = (cmd) => Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(cmd)[1], "base64").toString("utf8").replace(/\n\n\$__crustOk = \$\?$/, "");

// --- the name rule -----------------------------------------------------------------------------------------
test("name rule: secret-looking names match, ordinary look-alikes and SSH_AUTH_SOCK do not", () => {
	for (const n of ["OPENAI_API_KEY", "gemini_api_key", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "PGPASSWORD", "DATABASE_URL", "STRIPE_SK", "AUTHORIZATION", "KEY", "SESSION_COOKIE"]) assert.ok(S.isSecretName(n), n);
	for (const n of ["PATH", "PWD", "HTTPS_PROXY", "SSH_AUTH_SOCK", "AWS_PROFILE", "KEYBOARD_LAYOUT", "TOKENIZERS_NOTE", "SECRETARY", "PASSWORD_POLICY_URL_DOC", "PI_CRUST_ENV_KEEP"]) assert.ok(!S.isSecretName(n), n);
	assert.equal(S.isSecretName(undefined), false);
});

// --- the keep list -------------------------------------------------------------------------------------------
test("keep list: arrays and comma or line separated text; junk gives nothing; names with = or NUL are refused", () => {
	assert.deepEqual(S.parseKeepList(["A_TOKEN", " B_KEY ", "", 5, null, "A_TOKEN"]), ["A_TOKEN", "B_KEY"]);
	assert.deepEqual(S.parseKeepList("A_TOKEN, B_KEY\nC_SECRET"), ["A_TOKEN", "B_KEY", "C_SECRET"]);
	assert.deepEqual(S.parseKeepList(["A=B", "C\0D", "x".repeat(201)]), []);
	for (const v of [undefined, null, 7, {}, true]) assert.deepEqual(S.parseKeepList(v), []);
	assert.equal(S.parseKeepList(Array.from({ length: 500 }, (_, i) => "N" + i)).length, 200);
});
test("secretNames: names only, the keep list removes names (case-insensitive on Windows only), nothing present gives nothing", () => {
	const env = { PATH: "p", GH_TOKEN: "v1", Npm_Token: "v2", OPENAI_API_KEY: "v3", ORDINARY: "v4" };
	assert.deepEqual(S.secretNames(env, { caseInsensitive: true }).sort(), ["GH_TOKEN", "Npm_Token", "OPENAI_API_KEY"]);
	assert.deepEqual(S.secretNames(env, { keep: ["gh_token", "NPM_TOKEN"], caseInsensitive: true }), ["OPENAI_API_KEY"]);
	assert.deepEqual(S.secretNames(env, { keep: ["gh_token", "NPM_TOKEN"], caseInsensitive: false }).sort(), ["GH_TOKEN", "Npm_Token", "OPENAI_API_KEY"]);
	assert.deepEqual(S.secretNames({ PATH: "p", HOME: "h" }), []);
	assert.deepEqual(S.secretNames(undefined), []);
	assert.deepEqual(S.secretNames(null, { keep: "A" }), []);
});

// --- which shell -------------------------------------------------------------------------------------------------
test("shellFamily: the powershell tool, Git Bash by default, a custom shellPath, and everything else is other", () => {
	const f = (o) => S.shellFamily({ platform: "win32", ...o });
	assert.equal(f({ toolName: "powershell" }), "powershell");
	assert.equal(f({ toolName: "bash" }), "posix");
	assert.equal(f({ toolName: "bash", shellPaths: [undefined, ""] }), "posix");
	assert.equal(f({ toolName: "bash", shellPaths: ["C:\\Program Files\\Git\\usr\\bin\\bash.exe"] }), "posix");
	assert.equal(f({ toolName: "bash", shellPaths: ["C:\\Windows\\System32\\bash.exe"] }), "posix", "WSL's bash speaks bash");
	assert.equal(f({ toolName: "bash", shellPaths: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }), "powershell");
	assert.equal(f({ toolName: "bash", shellPaths: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE"] }), "powershell");
	assert.equal(f({ toolName: "bash", shellPaths: ["C:\\tools\\fish.exe"] }), "other");
	assert.equal(f({ toolName: "bash", shellPaths: ["C:\\Windows\\System32\\cmd.exe"] }), "other");
	assert.equal(f({ toolName: "bash", shellPaths: [42] }), "other");
	assert.equal(f({ toolName: "bash", shellPaths: ["bash.exe", "pwsh.exe"] }), "other", "two settings that disagree");
	assert.equal(f({ toolName: "bash", shellPaths: null }), "other", "unreadable settings");
	assert.equal(f({ toolName: "write" }), "other");
	for (const p of ["/usr/bin/zsh", "/bin/zsh", "/bin/sh", "/usr/bin/dash", "/bin/bash", "/opt/homebrew/bin/zsh"]) assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: [p] }), "posix", p);
	assert.equal(S.shellFamily({ platform: "darwin", toolName: "bash", shellPaths: ["/bin/zsh", "/bin/sh"] }), "posix", "two POSIX shells agree");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: ["/usr/bin/fish"] }), "other");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: ["/usr/bin/nu"] }), "other");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: ["/bin/bashful"] }), "other", "only the exact program names count");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: [{}] }), "other", "a shellPath that is not a string");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: [true] }), "other", "a shellPath that is not a string");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: [0] }), "other", "0 is a value, not unset");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: ["/bin/zsh", "/bin/zsh"] }), "posix");
	assert.equal(S.shellFamily({ platform: "linux", toolName: "bash", shellPaths: ["/bin/zsh", 7] }), "other", "one bad value among good ones");
});

// --- the prefix per shell --------------------------------------------------------------------------------------------
test("posix prefix: exact text, names only", () => {
	const r = S.hideCommand("echo hi", "posix", ["GH_TOKEN", "OPENAI_API_KEY"]);
	assert.equal(r.ok, true);
	assert.equal(r.hidden, 2);
	assert.ok(/^unset -v \S+ \S+\necho hi$/.test(r.command), "the names are alone on the first line: " + JSON.stringify(r.command));
	assert.deepEqual(posixNames(r.command), ["GH_TOKEN", "OPENAI_API_KEY"], "in any order");
	assert.equal(afterFirstLine(r.command), "echo hi");
	assert.equal(S.hideCommand("echo hi", "posix", ["A_TOKEN", "A_TOKEN"]).command, "unset -v A_TOKEN\necho hi", "a name is listed once");
});
test("powershell prefix: the names are alone on the first line, the command is carried unchanged, and a name with any other character is built from character codes (pure ASCII)", () => {
	const r = S.hideCommand("Get-Date", "powershell", ["GH_TOKEN", "B_KEY"]).command;
	assert.deepEqual(psNames(r), ["B_KEY", "GH_TOKEN"], "in any order");
	assert.equal(psCarried(r), "Get-Date");
	assert.ok(!r.slice(r.indexOf("\n")).match(/GH_TOKEN|B_KEY/), "no name outside the first line");
	const text = "using namespace System.Text\n[CmdletBinding()]param()\n'it''s' # \u00e9 \u2018";
	assert.equal(psCarried(S.hideCommand(text, "powershell", ["A_TOKEN"]).command), text, "any text, quotes and non-ASCII included");
	const odd = S.hideCommand("Get-Date", "powershell", ["A(B)_TOKEN", "100%_KEY", "\u00c4PI_KEY", "it's_TOKEN", "\u2018q\u2019_TOKEN"]).command;
	assert.match(odd, /^\(-join \[char\[\]\]\(65,40,66,41,95,84,79,75,69,78\)\),/);
	assert.ok(/^[\x20-\x7e\n]*$/.test(odd), "pure ASCII");
	assert.ok(!/A\(B\)|%_KEY|PI_KEY|it's/.test(firstLine(odd)), "no odd name appears as text");
	assert.equal(psCarried(odd), "Get-Date");
});
test("posix: a name that is not a shell identifier (parentheses, percent, non-ASCII) runs through env -u, quoted", () => {
	const r = S.hideCommand("echo 'it''s'; echo $HOME", "posix", ["GH_TOKEN", "ProgramFiles(x86)_TOKEN", "100%_KEY", "\u00c4PI_KEY"]);
	assert.equal(r.ok, true);
	assert.equal(
		r.command,
		`exec env -u 'GH_TOKEN' -u 'ProgramFiles(x86)_TOKEN' -u '100%_KEY' -u '\u00c4PI_KEY' "\${BASH:-\${0#-}}" -c 'echo '\\''it'\\'''\\''s'\\''; echo $HOME' "$0"`,
	);
});
test("nothing is added when there is nothing to hide, in any shell", () => {
	for (const fam of ["posix", "powershell", "other"]) assert.deepEqual(S.hideCommand("echo hi", fam, []), { ok: true, command: "echo hi", hidden: 0 });
	assert.deepEqual(S.hideCommand("echo hi", "posix", undefined), { ok: true, command: "echo hi", hidden: 0 });
});
test("idempotent: applying it twice gives the same command, in every form", () => {
	for (const [fam, names] of [["posix", ["GH_TOKEN", "B_KEY"]], ["posix", ["GH_TOKEN", "A(1)_KEY"]], ["powershell", ["GH_TOKEN", "A(1)_KEY"]]]) {
		for (const cmd of ["echo hi", "echo it's\nexit 3", "cat <<'EOF'\nx\nEOF"]) {
			const once = S.hideCommand(cmd, fam, names).command;
			assert.notEqual(once, cmd);
			assert.equal(S.hideCommand(once, fam, names).command, once, `${fam} ${names}`);
		}
	}
});
test("a shell the prefix cannot be written for is refused with a reason, when there are names", () => {
	const r = S.hideCommand("echo hi", "other", ["GH_TOKEN"]);
	assert.equal(r.ok, false);
	assert.match(r.reason, /Nothing was run/);
	assert.ok(!r.reason.includes("GH_TOKEN"));
	assert.equal(S.hideCommand(5, "posix", ["A_TOKEN"]).ok, false);
});

// --- real runs ------------------------------------------------------------------------------------------------------------
// The produced command, run in the real shell with dummy variables the test sets itself. The shell prints the NAMES of its environment;
// the test checks which dummy names are gone. The values are the single character "x".
function findGitBash() {
	if (!WIN) return fs.existsSync("/bin/bash") ? "/bin/bash" : null;
	for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
		const p = pf && path.join(pf, "Git", "bin", "bash.exe");
		if (p && fs.existsSync(p)) return p;
	}
	return null;
}
function findPowerShell() {
	if (!WIN) return null;
	const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
	const p = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return fs.existsSync(p) ? p : null;
}
const BASH = findGitBash();
const PWSH = findPowerShell();
const SYSROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const DUMMIES = ["DUMMY_ONE_TOKEN", "dummy_mixed_Api_Key", "DUMMY_PAREN(1)_TOKEN", "DUMMY_100%_KEY", "DUMMY_\u00c4_SECRET", "DUMMY_KEEPME_TOKEN"];
const KEEP = ["DUMMY_KEEPME_TOKEN"];
function dummyEnv(extra = {}) {
	const dir = BASH ? path.dirname(BASH) : "";
	const env = { SystemRoot: SYSROOT, PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: [dir, path.join(dir, "..", "usr", "bin"), path.join(SYSROOT, "System32")].join(path.delimiter), ORDINARY_NAME: "x", ...extra };
	for (const n of DUMMIES) env[n] = "x";
	return env;
}
// WIN only: the names with ( ) % and a non-ASCII letter are fine on Windows; elsewhere "(" and "%" in a name are too, but keep the run simple.
const dummyNames = () => DUMMIES;
function hiddenFor(command, family, env) {
	const names = S.secretNames(env, { keep: KEEP, caseInsensitive: WIN }).filter((n) => DUMMIES.includes(n));
	assert.ok(names.length >= 4, "the dummy names are found: " + names.length);
	assert.ok(!names.includes("DUMMY_KEEPME_TOKEN"));
	return S.hideCommand(command, family, names);
}
function namesPrinted(out) {
	return new Set(String(out).split(/\r?\n/).map((l) => l.replace(/=.*$/, "").trim()).filter(Boolean));
}
function checkGone(printed, label) {
	for (const n of dummyNames()) {
		if (n === "DUMMY_KEEPME_TOKEN") assert.ok(printed.has(n), `${label}: ${n} stays (keep list)`);
		else assert.ok(![...printed].some((p) => p.toLowerCase() === n.toLowerCase()), `${label}: ${n} is gone`);
	}
	assert.ok(printed.has("ORDINARY_NAME"), `${label}: an ordinary variable stays`);
}

test("real run, bash: secret-looking dummy names are gone, the keep-listed one stays; exit code, heredoc, quotes, several lines and the folder are intact", { skip: !BASH && "no bash here" }, () => {
	const sub = path.join(tmp, "work dir");
	fs.mkdirSync(sub);
	const env = dummyEnv();
	const original = ["env | sed 's/=.*//'", "echo \"it's here\"", "cat <<'EOF'", "line with $NOT_EXPANDED and 'quotes'", "EOF", "pwd", "(exit 7)"].join("\n");
	const r = hiddenFor(original, "posix", env);
	assert.equal(r.ok, true);
	assert.ok(r.command.startsWith("exec env "), "this set has non-identifier names, so it is wrapped");
	const run = spawnSync(BASH, ["-c", r.command], { cwd: sub, env, encoding: "utf8" });
	assert.equal(run.status, 7, "the exit code of the original command: " + run.stderr);
	checkGone(namesPrinted(run.stdout), "wrapped");
	assert.match(run.stdout, /it's here/);
	assert.match(run.stdout, /line with \$NOT_EXPANDED and 'quotes'/);
	assert.match(run.stdout.replace(/\\/g, "/"), /work dir/, "the working folder is unchanged");
});
test("real run, bash: the plain 'unset -v' prefix (identifier names only), including a mixed-case name; a command with its own exit code", { skip: !BASH && "no bash here" }, () => {
	const env = dummyEnv();
	for (const n of ["DUMMY_PAREN(1)_TOKEN", "DUMMY_100%_KEY", "DUMMY_\u00c4_SECRET"]) delete env[n];
	const names = S.secretNames(env, { keep: KEEP, caseInsensitive: WIN }).filter((n) => /^(DUMMY|dummy)/.test(n));
	assert.deepEqual(names.sort(), ["DUMMY_ONE_TOKEN", "dummy_mixed_Api_Key"]);
	const r = S.hideCommand("env | sed 's/=.*//'; exit 3", "posix", names);
	assert.ok(r.command.startsWith("unset -v "));
	const run = spawnSync(BASH, ["-c", r.command], { env, encoding: "utf8" });
	assert.equal(run.status, 3);
	const printed = namesPrinted(run.stdout);
	assert.ok(![...printed].some((p) => /^dummy_(one|mixed)/i.test(p)), "mixed case gone too");
	assert.ok(printed.has("DUMMY_KEEPME_TOKEN") && printed.has("ORDINARY_NAME"));
	// without the prefix the same command prints them: the check can tell
	const bare = spawnSync(BASH, ["-c", "env | sed 's/=.*//'"], { env, encoding: "utf8" });
	assert.ok(namesPrinted(bare.stdout).has("DUMMY_ONE_TOKEN"), "control: unhidden, the name is visible");
});
test("real run, bash: a failing command keeps its exit code and nothing is added when no secret name exists", { skip: !BASH && "no bash here" }, () => {
	const env = { ...dummyEnv() };
	for (const n of DUMMIES) delete env[n];
	assert.deepEqual(S.secretNames(env, { caseInsensitive: WIN }), []);
	const r = S.hideCommand("exit 9", "posix", S.secretNames(env));
	assert.equal(r.command, "exit 9");
	assert.equal(spawnSync(BASH, ["-c", r.command], { env }).status, 9);
});
test("real run, PowerShell: secret-looking dummy names are gone, the keep-listed one stays; exit code, quotes, several lines and the folder are intact", { skip: !PWSH && "no PowerShell here" }, () => {
	const sub = path.join(tmp, "ps dir");
	fs.mkdirSync(sub);
	const env = dummyEnv();
	const original = ["Get-ChildItem Env: | ForEach-Object { $_.Name }", "Write-Output \"it's here\"", "(Get-Location).Path", "exit 7"].join("\n");
	const r = hiddenFor(original, "powershell", env);
	assert.equal(r.ok, true);
	const run = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", r.command], { cwd: sub, env, encoding: "utf8" });
	assert.equal(run.status, 7, "the exit code of the original command: " + run.stderr);
	checkGone(namesPrinted(run.stdout), "powershell");
	assert.match(run.stdout, /it's here/);
	assert.match(run.stdout, /ps dir/, "the working folder is unchanged");
	const bare = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem Env: | ForEach-Object { $_.Name }"], { env, encoding: "utf8" });
	assert.ok(namesPrinted(bare.stdout).has("DUMMY_ONE_TOKEN"), "control: unhidden, the name is visible");
});
test("real run, PowerShell used as the bash tool's shell (-c): the same prefix works", { skip: !PWSH && "no PowerShell here" }, () => {
	const env = dummyEnv();
	const r = hiddenFor("Get-ChildItem Env: | ForEach-Object { $_.Name }", S.shellFamily({ toolName: "bash", shellPaths: [PWSH] }), env);
	const run = spawnSync(PWSH, ["-NoProfile", "-c", r.command], { env, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	checkGone(namesPrinted(run.stdout), "shellPath powershell");
});

// --- the extension -------------------------------------------------------------------------------------------------------
const proj = path.join(tmp, "proj");
const agentDir = path.join(tmp, "agent");
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
async function load() {
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const mod = await import(pathToFileURL(path.join(SRC, "pi-extension", "permission-modes.ts")).href + "?t=" + Math.random());
		const handlers = {};
		const commands = {};
		mod.default({ on: (n, f) => (handlers[n] = f), registerCommand: (n, o) => (commands[n] = o), appendEntry() {} });
		const mk = (select) => ({ hasUI: true, cwd: proj, sessionManager: { getBranch: () => [] }, ui: { setStatus() {}, notify() {}, select } });
		return { handlers, commands, mk };
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
}
// Runs fn with process.env replaced by exactly `env`, so the extension never sees the real environment.
async function withEnv(env, fn) {
	const saved = process.env;
	process.env = { PI_CODING_AGENT_DIR: agentDir, ...env };
	try {
		return await fn();
	} finally {
		process.env = saved;
	}
}
const ENV = { ProgramFiles: process.env.ProgramFiles, OTHER_SERVICE_API_KEY: "dummy-value-1", Gh_Token: "dummy-value-2", ORDINARY_NAME: "x" };
const prefixOf = (cmd, orig) => cmd.slice(0, cmd.length - orig.length);

test("extension: every mode hides the names from the command that runs; Trusted too; nothing else about the command changes", async () => {
	for (const mode of ["plan", "ask-edits", "ask-commands", "trusted"]) {
		const { handlers: h, commands: c, mk } = await load();
		const ctx = mk(async () => "Allow once");
		await withEnv(ENV, async () => {
			await h.session_start({}, ctx);
			await c.mode.handler(mode, ctx);
			const input = { command: "ls src" };
			const r = await h.tool_call({ toolName: "bash", input }, ctx);
			assert.equal(r, undefined, mode);
			assert.deepEqual(posixNames(input.command), ["Gh_Token", "OTHER_SERVICE_API_KEY"], mode);
			assert.equal(afterFirstLine(input.command), "ls src", mode);
			assert.ok(!/dummy-value/.test(input.command), "names only: " + mode);
		});
	}
});
test("extension: a command that is asked about shows the ORIGINAL text in the prompt, and the approved command runs with the prefix", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const seen = [];
	const ctx = mk(async (title) => (seen.push(title), "Allow once"));
	await withEnv(ENV, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("ask-commands", ctx);
		const input = { command: "npm run build" };
		assert.equal(await h.tool_call({ toolName: "bash", input }, ctx), undefined);
		assert.equal(seen.length, 1);
		assert.ok(seen[0].includes("npm run build") && !/unset|OTHER_SERVICE/.test(seen[0]), "the prompt shows " + JSON.stringify(seen[0]));
		assert.match(input.command, /^unset -v [^\n]*\nnpm run build$/);
		assert.throws(() => (input.command = "x"), TypeError, "still pinned after the prefix");
	});
});
test("extension: Trusted rewrites only by adding the prefix (no git hardening); the same call again gives the same command (idempotent)", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk(async () => undefined);
	await withEnv(ENV, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const a = { command: "git status" };
		assert.equal(await h.tool_call({ toolName: "bash", input: a }, ctx), undefined);
		assert.match(a.command, /^unset -v [^\n]+\ngit status$/);
		const b = { command: a.command };
		assert.equal(await h.tool_call({ toolName: "bash", input: b }, ctx), undefined);
		assert.equal(b.command, a.command);
	});
});
test("extension: nothing is added when Pi's environment has no secret-looking variable", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk(async () => undefined);
	await withEnv({ ProgramFiles: process.env.ProgramFiles, ORDINARY_NAME: "x" }, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const a = { command: "echo hi" };
		assert.equal(await h.tool_call({ toolName: "bash", input: a }, ctx), undefined);
		assert.equal(a.command, "echo hi");
	});
});
test("extension: the keep list (PI_CRUST_ENV_KEEP) is honoured, a broken one keeps nothing", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk(async () => undefined);
	const run = async (keep) => {
		const a = { command: "echo hi" };
		await withEnv({ ...ENV, ...(keep === undefined ? {} : { PI_CRUST_ENV_KEEP: keep }) }, async () => {
			await h.session_start({}, ctx);
			await c.mode.handler("trusted", ctx);
			assert.equal(await h.tool_call({ toolName: "bash", input: a }, ctx), undefined);
		});
		return a.command;
	};
	assert.equal(await run(JSON.stringify(["OTHER_SERVICE_API_KEY"])), "unset -v Gh_Token\necho hi");
	assert.equal(await run(JSON.stringify(["OTHER_SERVICE_API_KEY", "gh_token"])), WIN ? "echo hi" : "unset -v Gh_Token\necho hi");
	assert.match(await run("not json"), /^unset -v [^\n]*OTHER_SERVICE_API_KEY[^\n]*\necho hi$/);
	assert.match(await run(undefined), /^unset -v [^\n]*Gh_Token[^\n]*\necho hi$/);
});
test("extension: the powershell tool, and a custom PowerShell shellPath, get the PowerShell prefix", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk(async () => undefined);
	await withEnv(ENV, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const a = { command: "Get-Date" };
		assert.equal(await h.tool_call({ toolName: "powershell", input: a }, ctx), undefined);
		assert.ok(psCarried(a.command) === "Get-Date" && a.command.startsWith("'"), a.command);
	});
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }));
	try {
		await withEnv(ENV, async () => {
			const b = { command: "Get-Date" };
			assert.equal(await h.tool_call({ toolName: "bash", input: b }, ctx), undefined);
			assert.equal(psCarried(b.command), "Get-Date", b.command);
		});
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ shellPath: "C:\\tools\\fish.exe" }));
		await withEnv(ENV, async () => {
			const d = { command: "echo hi" };
			const r = await h.tool_call({ toolName: "bash", input: d }, ctx);
			assert.ok(r && r.block && /Nothing was run/.test(r.reason), "an unknown shell blocks when there is something to hide");
			assert.equal(d.command, "echo hi");
		});
		await withEnv({ ORDINARY_NAME: "x" }, async () => {
			const d = { command: "echo hi" };
			assert.equal(await h.tool_call({ toolName: "bash", input: d }, ctx), undefined, "an unknown shell is fine when there is nothing to hide");
		});
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{ broken");
		await withEnv(ENV, async () => {
			const r = await h.tool_call({ toolName: "bash", input: { command: "echo hi" } }, ctx);
			assert.ok(r && r.block, "unreadable settings: the shell is unknown, so blocked");
		});
	} finally {
		fs.rmSync(path.join(agentDir, "settings.json"), { force: true });
	}
});
test("extension: tools that are not commands are left alone", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk(async () => undefined);
	await withEnv(ENV, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const w = { path: "a.txt", content: "OTHER_SERVICE_API_KEY" };
		assert.equal(await h.tool_call({ toolName: "write", input: w }, ctx), undefined);
		assert.deepEqual(w, { path: "a.txt", content: "OTHER_SERVICE_API_KEY" });
	});
});

// --- Pi's process gets the keep list --------------------------------------------------------------------------------------
test("pi process: the keep list reaches Pi as PI_CRUST_ENV_KEEP only when it is not empty, and never from the inherited environment", () => {
	const { childEnv } = require(path.join(SRC, "agents", "pi", "process.js"));
	const inherited = { PATH: "p", PI_CRUST_ENV_KEEP: JSON.stringify(["EVIL_TOKEN"]) };
	assert.equal("PI_CRUST_ENV_KEEP" in childEnv(inherited, {}), false);
	assert.equal("PI_CRUST_ENV_KEEP" in childEnv(inherited, { commandEnvKeep: [] }), false);
	assert.deepEqual(JSON.parse(childEnv(inherited, { commandEnvKeep: ["GH_TOKEN", " NPM_TOKEN "] }).PI_CRUST_ENV_KEEP), ["GH_TOKEN", "NPM_TOKEN"]);
	assert.deepEqual(JSON.parse(childEnv({}, { commandEnvKeep: "A_TOKEN, B_KEY" }).PI_CRUST_ENV_KEEP), ["A_TOKEN", "B_KEY"]);
	assert.equal(childEnv({}, {}).PI_CRUST_TOOL_CHECKIN, "40");
});

// --- Trusted is not remembered -------------------------------------------------------------------------------------------
test("last chosen mode: Plan, Ask before edits and Ask before commands are remembered; Trusted is stored and read as Ask before commands", () => {
	for (const m of ["plan", "ask-edits", "ask-commands"]) {
		assert.equal(L.lastModeToStore(m), m);
		assert.equal(L.parseLastMode(JSON.stringify({ mode: L.lastModeToStore(m) })), m);
	}
	assert.equal(L.lastModeToStore("trusted"), "ask-commands");
	assert.equal(L.parseLastMode(JSON.stringify({ mode: "trusted" })), "ask-commands", "an older file that says trusted");
	for (const bad of ["", "{", "[]", JSON.stringify({ mode: "root" })]) assert.equal(L.parseLastMode(bad), "ask-commands");
	assert.equal(L.lastModeToStore("nonsense"), "ask-commands");
});
test("a chat restored from a saved session never comes back in Trusted", () => {
	const entry = (mode) => ({ type: "custom", customType: L.ENTRY_TYPE, data: { mode } });
	assert.equal(L.restoreMode([entry("plan"), entry("trusted")]), "ask-commands");
	assert.equal(L.restoreMode([entry("trusted"), entry("ask-edits")]), "ask-edits");
	assert.equal(L.restoreMode([]), null);
});
test("Pi: switching a chat to Trusted affects that chat only; the stored last choice is Ask before commands, a new chat starts there", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk(async () => undefined);
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const file = path.join(agentDir, "crust-permission-mode.json");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mode: "ask-commands" });
		const statuses = [];
		const next = { ...mk(async () => undefined) };
		next.ui = { ...next.ui, setStatus: (_k, t) => statuses.push(t) };
		await h.session_start({}, next); // a new chat in the same process
		assert.deepEqual(statuses, ["Mode: Ask before commands"]);
		await c.mode.handler("plan", ctx);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mode: "plan" });
		// a restored tab: its saved entry says trusted, the file says plan
		const restored = { ...mk(async () => undefined), sessionManager: { getBranch: () => [{ type: "custom", customType: L.ENTRY_TYPE, data: { mode: "trusted" } }] } };
		restored.ui = { ...restored.ui, setStatus: (_k, t) => statuses.push(t) };
		await h.session_start({}, restored);
		assert.equal(statuses.at(-1), "Mode: Ask before commands");
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		fs.rmSync(path.join(agentDir, "crust-permission-mode.json"), { force: true });
	}
});
