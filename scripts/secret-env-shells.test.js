"use strict";
// Secret-looking variables, second part: the produced command run for real in Git Bash (bash, sh, dash) and Windows PowerShell 5.1 (and pwsh 7
// when it is installed), with dummy variables the test sets itself in an environment object it builds. Covers: a command that must start with
// `using namespace` / `param(...)`, exit codes, error messages that must never quote the hidden names (syntax errors in bash, PowerShell and
// the env -u form), POSIX shells other than bash, the shell check before any question, the length limit, and the three extension mutations.
// Only NAMES are ever printed or compared; every value is "x".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const SRC = path.join(__dirname, "..", "src");
const S = require(path.join(SRC, "secret-env.js"));
const WIN = process.platform === "win32";
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "secret-env-shells-")));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SYSROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const gitDir = () => {
	if (!WIN) return null;
	for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
		const p = pf && path.join(pf, "Git");
		if (p && fs.existsSync(path.join(p, "bin", "bash.exe"))) return p;
	}
	return null;
};
const GIT = gitDir();
const posixShell = (name) => {
	if (!WIN) {
		for (const d of ["/bin", "/usr/bin"]) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
		return null;
	}
	const p = GIT && path.join(GIT, name === "bash" ? "bin" : "usr/bin", name + ".exe");
	return p && fs.existsSync(p) ? p : null;
};
const SHELLS = Object.fromEntries(["bash", "sh", "dash", "zsh"].map((n) => [n, posixShell(n)]));
const PS5 = WIN && fs.existsSync(path.join(SYSROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")) ? path.join(SYSROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const PS7 = WIN && process.env.ProgramFiles && fs.existsSync(path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")) ? path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe") : null;

const IDENT = ["DUMMY_ONE_TOKEN", "dummy_mixed_Api_Key"];
const ODD = ["DUMMY_PAREN(1)_TOKEN", "DUMMY_100%_KEY", "DUMMY_\u00c4_SECRET"];
function baseEnv(names) {
	const bin = GIT ? [path.join(GIT, "bin"), path.join(GIT, "usr", "bin")] : [];
	const env = { SystemRoot: SYSROOT, PATH: [...bin, path.join(SYSROOT, "System32")].join(path.delimiter), ORDINARY_NAME: "x" };
	if (!WIN) env.PATH = "/usr/bin:/bin";
	for (const n of names) env[n] = "x";
	return env;
}
const leaks = (text, names) => names.filter((n) => String(text).toLowerCase().includes(n.toLowerCase()));
const hide = (cmd, family, names) => {
	const r = S.hideCommand(cmd, family, names);
	assert.equal(r.ok, true, r.reason);
	return r.command;
};

// --- POSIX shells ---------------------------------------------------------------------------------------------------------
for (const sh of ["bash", "sh", "dash", "zsh"]) {
	for (const [label, names] of [["unset form", IDENT], ["env -u form", [...IDENT, ...ODD]]]) {
		test(`real run, ${sh}, ${label}: names gone, other variables stay, exit code, $0 and the folder are those of the original`, { skip: !SHELLS[sh] && `no ${sh} here` }, () => {
			if (!WIN && label === "env -u form" && sh === "zsh") return; // names with ( ) % are fine in env, but keep this run simple
			const env = baseEnv(names);
			const dir = path.join(tmp, "dir " + sh);
			fs.mkdirSync(dir, { recursive: true });
			const orig = "env | sed 's/=.*//'\necho \"zero=$0\"\npwd\n(exit 4)";
			const bare = spawnSync(SHELLS[sh], ["-c", orig], { env, cwd: dir, encoding: "utf8" });
			const wrapped = hide(orig, "posix", names);
			assert.equal(wrapped.startsWith("unset -v ") || wrapped.startsWith("exec env "), true);
			assert.equal(wrapped.startsWith("exec env "), label === "env -u form");
			const run = spawnSync(SHELLS[sh], ["-c", wrapped], { env, cwd: dir, encoding: "utf8" });
			assert.equal(run.status, 4, run.stderr);
			assert.deepEqual(leaks(run.stdout, names), [], "the hidden names are gone");
			assert.ok(leaks(bare.stdout, names).length >= IDENT.length, "control: unhidden, they are visible (dash drops names that are not identifiers by itself)");
			assert.match(run.stdout, /ORDINARY_NAME/);
			const zero = (o) => /zero=(.*)/.exec(o)[1].trim();
			assert.equal(zero(run.stdout), zero(bare.stdout), "$0 is unchanged");
			assert.match(run.stdout.replace(/\\/g, "/"), /dir /);
		});
	}
}

// --- error messages never quote the hidden names ------------------------------------------------------------------------------
const bashCases = {
	"first line": ";echo x",
	"middle": "echo a\necho b;;\necho c",
	"heredoc, never ended": "cat <<EOF\nhi",
	"unterminated quote": "echo 'abc",
	"unknown command": "no_such_command_zzz",
};
for (const [label, names] of [["unset form", IDENT], ["env -u form", [...IDENT, ...ODD]]]) {
	test(`bash errors, ${label}: a syntax error, an unfinished heredoc or quote and a missing command never quote a hidden name`, { skip: !SHELLS.bash && "no bash here" }, () => {
		const env = baseEnv(names);
		for (const [where, cmd] of Object.entries(bashCases)) {
			const run = spawnSync(SHELLS.bash, ["-c", hide(cmd, "posix", names)], { env, encoding: "utf8" });
			assert.deepEqual(leaks(run.stderr + run.stdout, names), [], where + ": " + JSON.stringify(run.stderr));
		}
		// the error does name the person's own line
		const first = spawnSync(SHELLS.bash, ["-c", hide(";echo x", "posix", names)], { env, encoding: "utf8" });
		assert.match(first.stderr, /;echo x/);
		assert.notEqual(first.status, 0);
	});
}
test("control for the error check: with the names on the same line as the command (the earlier form), bash does quote them", { skip: !SHELLS.bash && "no bash here" }, () => {
	const run = spawnSync(SHELLS.bash, ["-c", "unset -v DUMMY_ONE_TOKEN dummy_mixed_Api_Key; ;echo x"], { env: baseEnv(IDENT), encoding: "utf8" });
	assert.equal(leaks(run.stderr, IDENT).length, 2, "the check can tell: " + run.stderr);
});

// --- PowerShell -----------------------------------------------------------------------------------------------------------
const psHosts = [["Windows PowerShell 5.1", PS5], ["pwsh 7", PS7]];
function psRun(exe, command, env, cwd) {
	return spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { env, cwd, encoding: "utf8" });
}
const psCases = {
	"using namespace": ["using namespace System.Text\n[StringBuilder]::new('sb ok').ToString()", "sb ok"],
	"[CmdletBinding()]param()": ["[CmdletBinding()]param()\n'cb ok'", "cb ok"],
	"param(...)": ["param($a, $b = 2)\n\"param ok $b\"", "param ok 2"],
	"here-string": ["$x = @'\nline one\n'it' ''quoted''\n'@\n$x\n\"it's here\"", "line one"],
	"multi-line pipeline": ["Get-ChildItem Env: |\n  Where-Object { $_.Name -like 'ORDINARY*' } |\n  ForEach-Object { $_.Name }", "ORDINARY_NAME"],
	"reads $args": ["'args=' + $args.Count", "args=0"],
	"a failing cmdlet": ["Get-Item C:\\no_such_folder_zzz", null],
	"a native command's exit code": ["cmd /c exit 5", null],
	"exit 7": ["'before'\nexit 7", "before"],
	"throws": ["throw 'boom'", null],
	"ErrorActionPreference Stop": ["$ErrorActionPreference = 'Stop'\nGet-Item C:\\no_such_folder_zzz\n'not reached'", null],
	"a failure that is not the last statement": ["Get-Item C:\\no_such_folder_zzz -ErrorAction SilentlyContinue\n'fine'", "fine"],
	"working folder": ["(Get-Location).Path", "ps dir"],
};
for (const [hostName, exe] of psHosts) {
	test(`real run, ${hostName}: a command that must start with using/param runs unchanged; exit code, output, errors, $ErrorActionPreference and folder match an unwrapped run; names gone`, { skip: !exe && `${hostName} is not installed here, untested` }, () => {
		const dir = path.join(tmp, "ps dir");
		fs.mkdirSync(dir, { recursive: true });
		const names = [...IDENT, ...ODD];
		const env = baseEnv(names);
		for (const [label, [cmd, expectOut]] of Object.entries(psCases)) {
			const bare = psRun(exe, cmd, env, dir);
			const run = psRun(exe, hide(cmd, "powershell", names), env, dir);
			assert.equal(run.status, bare.status, `${label}: exit code (bare ${bare.status}) ${run.stderr}`);
			assert.equal(run.stdout, bare.stdout, `${label}: output`);
			if (expectOut) assert.ok(bare.stdout.includes(expectOut), `${label}: the unwrapped command itself works: ${bare.stdout}${bare.stderr}`);
			assert.equal((run.stderr.match(/boom|no_such_folder_zzz/g) || []).length > 0, (bare.stderr.match(/boom|no_such_folder_zzz/g) || []).length > 0, `${label}: the error is reported`);
			assert.deepEqual(leaks(run.stderr, names), [], label + ": no hidden name in stderr");
		}
		const printed = psRun(exe, hide("Get-ChildItem Env: | ForEach-Object { $_.Name }", "powershell", names), env, dir);
		assert.deepEqual(leaks(printed.stdout, names), [], "the hidden names are gone");
		assert.match(printed.stdout, /ORDINARY_NAME/);
		assert.equal(leaks(psRun(exe, "Get-ChildItem Env: | ForEach-Object { $_.Name }", env, dir).stdout, names).length >= IDENT.length, true, "control: unhidden they are visible");
	});
	test(`${hostName}: a parse error in the person's command quotes only the person's own text, never the hidden names`, { skip: !exe && `${hostName} is not installed here, untested` }, () => {
		const names = [...IDENT, ...ODD];
		const env = baseEnv(names);
		for (const cmd of [")", "Get-Date\n)\nGet-Date", "'unterminated", "$x = @'\nnever ended", "param(\n"]) {
			const run = psRun(exe, hide(cmd, "powershell", names), env, tmp);
			assert.notEqual(run.status, 0, JSON.stringify(cmd));
			assert.deepEqual(leaks(run.stderr + run.stdout, names), [], JSON.stringify(cmd) + ": " + run.stderr);
			assert.ok(!/ForEach-Object|SetEnvironmentVariable|FromBase64String/.test(run.stderr + run.stdout), "the wrapper itself is not quoted either: " + run.stderr);
		}
	});
}
test("PowerShell: pwsh 7 status", { skip: PS7 || !WIN }, () => {
	// Documents that the pwsh 7 run above is skipped on this machine; it is untested here.
	assert.equal(PS7, null);
});
test("PowerShell wrapper: the same command is not wrapped twice, and a prefix for other names is not mistaken for it", () => {
	const once = hide("Get-Date", "powershell", ["A_TOKEN", "B_KEY"]);
	assert.equal(hide(once, "powershell", ["A_TOKEN", "B_KEY"]), once);
	const other = hide(once, "powershell", ["C_TOKEN"]);
	assert.notEqual(other, once);
});

// --- the length limit ----------------------------------------------------------------------------------------------------------
test("a command that would pass the Windows command-line limit once wrapped is refused with a readable message, in both wrapped forms", () => {
	const longQuotes = "echo 'a'\n".repeat(4000); // 36000 characters, every quote costs 4 in the env -u form
	for (const [family, names] of [["posix", ["A(1)_TOKEN"]], ["powershell", ["A_TOKEN"]]]) {
		const big = family === "posix" ? longQuotes : "Write-Output 'x'\n".repeat(2500);
		const r = S.hideCommand(big, family, names, { platform: "win32" });
		assert.equal(r.ok, false, family);
		assert.match(r.reason, /too long/);
		assert.match(r.reason, /Nothing was run/);
		assert.match(r.reason, /commandEnvKeep/);
		assert.ok(!/A_TOKEN|A\(1\)/.test(r.reason), "no names");
	}
	assert.equal(S.hideCommand(longQuotes, "posix", ["A(1)_TOKEN"], { platform: "linux" }).ok, true, "no such limit elsewhere");
	assert.equal(S.hideCommand("echo 'a'\n".repeat(500), "posix", ["A(1)_TOKEN"], { platform: "win32" }).ok, true, "a normal command passes");
	assert.equal(S.hideCommand(longQuotes, "posix", ["A_TOKEN"], { platform: "win32" }).ok, true, "the unset form adds only a short line, so it is not limited here");
});

// --- the extension: the shell check comes before any question; the three mutations --------------------------------------------------
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
		const asked = [];
		const mk = (answer = "Allow once") => ({ hasUI: true, cwd: proj, sessionManager: { getBranch: () => [] }, ui: { setStatus() {}, notify() {}, select: async (title) => (asked.push(title), answer) } });
		return { handlers, commands, mk, asked };
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
}
async function withEnv(env, fn) {
	const saved = process.env;
	process.env = { PI_CODING_AGENT_DIR: agentDir, ...env };
	try {
		return await fn();
	} finally {
		process.env = saved;
	}
}
const ENV = { ProgramFiles: process.env.ProgramFiles, DUMMY_SERVICE_API_KEY: "x", Dummy_Gh_Token: "x", ORDINARY_NAME: "x" };
const NAMES = ["DUMMY_SERVICE_API_KEY", "Dummy_Gh_Token"];
const setShell = (v) => fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(v === undefined ? {} : { shellPath: v }));
test.afterEach(() => fs.rmSync(path.join(agentDir, "settings.json"), { force: true }));

for (const mode of ["ask-commands", "ask-edits", "trusted"]) {
	test(`extension, ${mode}: an unknown shell (fish, a number) is refused BEFORE any question, and the message names shellPath, the cause and commandEnvKeep`, async () => {
		for (const sp of ["/usr/bin/fish", "C:\\tools\\nu.exe", 42]) {
			setShell(sp);
			const { handlers: h, commands: c, mk, asked } = await load();
			const ctx = mk("Allow once");
			await withEnv(ENV, async () => {
				await h.session_start({}, ctx);
				await c.mode.handler(mode, ctx);
				const input = { command: "npm run build" };
				const r = await h.tool_call({ toolName: "bash", input }, ctx);
				assert.ok(r && r.block, `${mode} ${sp}`);
				assert.deepEqual(asked, [], "no question was asked");
				assert.match(r.reason, /shellPath/);
				assert.match(r.reason, /commands cannot run in it while such variables are present/);
				assert.match(r.reason, /commandEnvKeep/);
				assert.match(r.reason, /Nothing was run/);
				assert.deepEqual(leaks(r.reason, NAMES), [], "names only in the message? none");
				assert.equal(input.command, "npm run build", "untouched");
			});
		}
	});
	test(`extension, ${mode}: zsh, sh, dash and bash as shellPath get the POSIX prefix, and a question (where the mode asks) is asked once and approved`, async () => {
		for (const sp of ["/bin/zsh", "/usr/bin/zsh", "/bin/sh", "/usr/bin/dash", "/bin/bash", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
			setShell(sp);
			const { handlers: h, commands: c, mk, asked } = await load();
			const ctx = mk("Allow once");
			await withEnv(ENV, async () => {
				await h.session_start({}, ctx);
				await c.mode.handler(mode, ctx);
				const input = { command: "npm run build" };
				const r = await h.tool_call({ toolName: "bash", input }, ctx);
				assert.equal(r, undefined, `${mode} ${sp}: ${r && r.reason}`);
				assert.match(input.command, /^unset -v [^\n]+\nnpm run build$/, sp);
				assert.deepEqual(input.command.split("\n")[0].replace("unset -v ", "").split(" ").sort(), [...NAMES].sort());
				assert.equal(asked.length, mode === "trusted" ? 0 : 1, `${mode} ${sp}: asked ${asked.length}`);
			});
		}
	});
}
test("extension: an unknown shell is fine when the keep list covers every secret-looking name, and when there is nothing to hide", async () => {
	setShell("/usr/bin/fish");
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk();
	await withEnv({ ...ENV, PI_CRUST_ENV_KEEP: JSON.stringify(NAMES) }, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const input = { command: "echo hi" };
		assert.equal(await h.tool_call({ toolName: "bash", input }, ctx), undefined);
		assert.equal(input.command, "echo hi");
	});
});
test("extension: a shellPath that is not a string blocks (a number, an object), and an unset or empty one is bash", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk();
	await withEnv(ENV, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		for (const v of [0, 5, {}, ["bash"], true]) {
			setShell(v);
			const r = await h.tool_call({ toolName: "bash", input: { command: "echo hi" } }, ctx);
			assert.ok(r && r.block, JSON.stringify(v));
		}
		for (const v of ["", null, undefined]) {
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ shellPath: v }));
			const input = { command: "echo hi" };
			assert.equal(await h.tool_call({ toolName: "bash", input }, ctx), undefined, JSON.stringify(v));
			assert.match(input.command, /^unset -v /);
		}
	});
});
test("extension: a command that already starts with this very prefix is left alone, one that starts with the prefix for other names gets its own", async () => {
	const { handlers: h, commands: c, mk } = await load();
	const ctx = mk();
	await withEnv(ENV, async () => {
		await h.session_start({}, ctx);
		await c.mode.handler("trusted", ctx);
		const a = { command: "echo hi" };
		await h.tool_call({ toolName: "bash", input: a }, ctx);
		const again = { command: a.command };
		await h.tool_call({ toolName: "bash", input: again }, ctx);
		assert.equal(again.command, a.command, "not wrapped twice");
		assert.equal((again.command.match(/unset -v/g) || []).length, 1);
		const other = { command: "unset -v SOME_OTHER_TOKEN\necho hi" };
		await h.tool_call({ toolName: "bash", input: other }, ctx);
		assert.notEqual(other.command, "unset -v SOME_OTHER_TOKEN\necho hi");
		assert.equal((other.command.match(/unset -v/g) || []).length, 2, "the other names do not count as the prefix");
	});
});
test("extension: Trusted adds only the prefix; the same git command in Ask before commands is rewritten (hardened), and the prefix is added to that", async () => {
	const cmd = "git status";
	const out = {};
	for (const mode of ["ask-commands", "trusted"]) {
		const { handlers: h, commands: c, mk } = await load();
		const ctx = mk();
		await withEnv(ENV, async () => {
			await h.session_start({}, ctx);
			await c.mode.handler(mode, ctx);
			const input = { command: cmd };
			assert.equal(await h.tool_call({ toolName: "bash", input }, ctx), undefined, mode);
			out[mode] = input.command;
		});
	}
	assert.equal(out.trusted.split("\n").slice(1).join("\n"), cmd, "Trusted: the person's command exactly");
	assert.ok(out["ask-commands"].includes("core.fsmonitor=false"), "outside Trusted the command is hardened: " + out["ask-commands"]);
	assert.match(out["ask-commands"], /^unset -v [^\n]+\n/);
});
test("extension: the PowerShell tool carries the person's command unchanged inside the wrapper, in every mode", async () => {
	for (const mode of ["ask-commands", "trusted"]) {
		const { handlers: h, commands: c, mk } = await load();
		const ctx = mk();
		await withEnv(ENV, async () => {
			await h.session_start({}, ctx);
			await c.mode.handler(mode, ctx);
			const orig = "using namespace System.Text\n'ok'";
			const input = { command: orig };
			assert.equal(await h.tool_call({ toolName: "powershell", input }, ctx), undefined, mode);
			assert.equal(Buffer.from(/FromBase64String\('([^']*)'\)/.exec(input.command)[1], "base64").toString("utf8").startsWith(orig), true);
			assert.ok(!NAMES.some((n) => input.command.slice(input.command.indexOf("\n")).includes(n)), "names only on the first line");
		});
	}
});
