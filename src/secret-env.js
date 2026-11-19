// Secret-looking environment variables, as pure functions shared by both agents (Claude Agent chats and Pi chats). No file, no process
// and no environment is read here: the caller passes the names in. Only NAMES are ever looked at; values are never read, copied or shown.
//   isSecretName(name)             the one name rule
//   parseKeepList(value)           the setting "commandEnvKeep": names a command may keep (default none)
//   secretNames(env, { keep })     the secret-looking names present in an environment object, minus the keep list
//   shellFamily(...)               which shell syntax a command tool runs: "posix" (bash, sh, dash, zsh), "powershell" or "other"
//   hideCommand(command, family, names)  the command that actually runs: a prefix that removes those variables for that command only
// Claude Agent chats drop the names from the engine's own environment (agents/claude/index.js). Pi needs its provider keys in its own
// environment, so Pi's permission extension keeps them there and hides them from every command it runs (pi-extension/permission-modes.ts).
"use strict";

const nodePath = require("node:path");

// Other services' secrets in the inherited environment, by NAME (values are never read). The engine needs none of them, and every command a
// Claude Agent chat runs would inherit them (a real trial printed two unrelated API keys). Matches a name that ends in, or has as a whole
// underscore-separated part, TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIALS, PRIVATE_KEY, ACCESS_KEY or API_KEY; APIKEY anywhere; a trailing PAT
// (personal access token) or PWD part; and connection strings, which embed a password (DATABASE_URL, REDIS_URL, MONGODB_URI, *_CONNECTION_STRING,
// *_DSN). That covers GH_TOKEN, NPM_TOKEN, AWS_SESSION_TOKEN, AWS_SECRET_ACCESS_KEY, PGPASSWORD, MYSQL_PWD and GOOGLE_APPLICATION_CREDENTIALS.
// A second rule adds: a trailing KEY part (SIGNING_KEY, SECRET_KEY, OPENAI_KEY), PASSPHRASE or COOKIE as a whole part, a trailing _SK (STRIPE_SK),
// WEBHOOK_URL (it embeds a secret), and AUTH or AUTHORIZATION as a whole part (AUTH_KEY, NPM_CONFIG__AUTH, AUTHORIZATION).
// Not matched, so kept: PATH, PWD (the plain working-directory variable), proxy and CA variables, AWS_PROFILE, GIT_AUTHOR_NAME, KEYBOARD_LAYOUT.
// SSH_AUTH_SOCK is kept on purpose: it holds a socket path, not a secret, and ssh and git need it to reach the person's own agent.
const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|PRIVATE_KEY|ACCESS_KEY|API_KEY)$|_(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|PRIVATE_KEY|ACCESS_KEY|API_KEY)_|APIKEY|(?:^|_)(?:PAT|MYSQL_PWD)$|(?:^|_)(?:DATABASE_URL|REDIS_URL|MONGODB_URI|MONGODB_URL|MONGO_URL|AMQP_URL|WEBHOOK_URL|CONNECTION_STRING|DSN)$/i;
const SECRET_ENV_NAME_MORE = /(?:^|_)(?:KEY$|(?:PASSPHRASE|COOKIE)(?:_|$))|_SK$|(?:^|_)AUTH(?:ORIZATION)?(?=_|$)(?!_SOCK$)/i;

const isSecretName = (name) => typeof name === "string" && (SECRET_ENV_NAME.test(name) || SECRET_ENV_NAME_MORE.test(name));

// The keep list: an array of names, or one string with names separated by commas or line breaks (a name has no "=" and no NUL; spaces
// inside a name are kept, outer spaces are not). Anything else gives an empty list. At most 200 names of at most 200 characters.
function parseKeepList(value) {
	let items = [];
	if (Array.isArray(value)) items = value;
	else if (typeof value === "string") items = value.split(/[,\r\n]+/);
	const out = [];
	for (const v of items) {
		if (typeof v !== "string") continue;
		const n = v.trim();
		if (n && n.length <= 200 && !/[=\0]/.test(n) && !out.includes(n)) out.push(n);
		if (out.length >= 200) break;
	}
	return out;
}

// Windows names are case-insensitive, so "gh_token" in the list keeps GH_TOKEN there; elsewhere the case must match.
const defaultFold = () => process.platform === "win32";

// The names in `env` that look secret and are not on the keep list.
function secretNames(env, { keep = [], caseInsensitive = defaultFold() } = {}) {
	if (!env || typeof env !== "object") return [];
	const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);
	const kept = new Set(parseKeepList(keep).map(fold));
	return Object.keys(env).filter((k) => isSecretName(k) && !kept.has(fold(k)));
}

// Which syntax a command tool speaks. The "powershell" tool is PowerShell. The "bash" tool runs Pi's shell: settings shellPath (global and
// project, "" / null / undefined count as unset) or, with none, Git Bash (Windows) or bash. bash, sh, dash and zsh are all "posix" (the prefix
// below uses only what they all support); PowerShell is "powershell"; any other
// shell (fish, cmd, nushell ...), a value that is not a string, two settings that disagree, or unreadable settings (shellPaths null) is "other".
function shellFamily({ toolName, shellPaths = [], platform = process.platform } = {}) {
	if (toolName === "powershell") return "powershell";
	if (toolName !== "bash" || !Array.isArray(shellPaths)) return "other";
	const base = platform === "win32" ? nodePath.win32.basename : nodePath.posix.basename;
	const set = shellPaths.filter((p) => p !== undefined && p !== null && p !== "");
	if (!set.length) return "posix";
	const fams = new Set();
	for (const sp of set) {
		if (typeof sp !== "string") return "other";
		const b = base(sp.trim()).toLowerCase();
		fams.add(/^(bash|sh|dash|zsh)(\.exe)?$/.test(b) ? "posix" :/^(powershell|pwsh)(\.exe)?$/.test(b) ? "powershell" : "other");
	}
	return fams.size === 1 ? [...fams][0] : "other";
}

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQ_ESCAPE = "'" + "\\" + "''"; // ' becomes '\'' (close the quote, an escaped quote, open it again)
const sq = (s) => "'" + String(s).replace(/'/g, SQ_ESCAPE) + "'"; // a POSIX single-quoted word: the one quoting that needs no other escape

// PowerShell: a plain name is a single-quoted string; any other name is built from its UTF-16 code units, so no quote character (PowerShell
// reads the curly quotes as quotes too), "(", "%" or non-ASCII character can ever matter, and the prefix stays pure ASCII.
const psName = (n) => (/^[A-Za-z0-9_]+$/.test(n) ? `'${n}'` : `(-join [char[]](${Array.from({ length: n.length }, (_, i) => n.charCodeAt(i)).join(",")}))`);

// The command that actually runs. The caller has already decided on the ORIGINAL command; this only adds what removes the variables.
// The names go on a line of their own, so an error message about the person's own command (bash quotes the offending line) can never quote them.
//   posix       "unset -v A B\n<command>" (a name that is not a shell identifier, such as "ProgramFiles(x86)" or one with a non-ASCII letter, cannot
//               be unset and bash still hands it on: then the whole command runs through
//               `exec env -u NAME ... "${BASH:-${0#-}}" -c '<command>' "$0"`, which is one line whose quoted text is only the person's command)
//   powershell  "'A','B' | ForEach-Object { [Environment]::SetEnvironmentVariable($_, $null, 'Process'); Remove-Item -LiteralPath ('Env:' + $_) -ErrorAction SilentlyContinue }\n<wrapper>": the line that clears the
//               names, then the person's command, unchanged, as a script block built from its Base64 text and dot-sourced. A command may have to
//               start with `using namespace`, `[CmdletBinding()]param()` or `param(...)`, which only work as the first statement of the text
//               they belong to, so nothing may come before them in it. A last line copies the command's own success flag into the exit code.
//   Both calls matter: SetEnvironmentVariable clears the process block child programs inherit (all that Windows PowerShell 5.1 needs), but
//   PowerShell 7 keeps its own copy for `Get-ChildItem Env:` and `$env:NAME`, which only Remove-Item on the Env: drive clears (found with pwsh 7.7).
// Idempotent: a command that already starts with exactly this prefix (or this wrapper) is returned as it is. No names: the command is returned
// unchanged. Returns { ok: true, command, hidden } or { ok: false, reason } for a shell this cannot write for (fail closed) or a command too
// long for the Windows command line once wrapped.
const PS_MARK = "try { $__crust = [scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
const MAX_WINDOWS_LINE = 30000; // CreateProcess allows 32767 characters for the whole line, program and quoting included
const tooLong = (text) => ({
	ok: false,
	reason: "This command is too long to run with the hiding of secret-looking environment variables on Windows (the wrapped text would pass the length limit of a Windows command line, " + MAX_WINDOWS_LINE + " characters). Nothing was run. Shorten the command, put it in a script file and run that, or list the variables in the commandEnvKeep setting.",
	long: text.length,
});
// What a Windows command line costs for this argument: its length, and every quote and backslash may be escaped with one more character.
const winCost = (text) => text.length + (text.match(/["\\]/g) || []).length;

const UNKNOWN_SHELL_REASON =
	"Pi is set to use a shell that Pi Crust does not know (the shellPath setting in Pi's settings.json names it; only bash, sh, dash, zsh and PowerShell are known). Pi Crust hides secret-looking environment variables from every command, and it cannot do that in this shell, so commands cannot run in it while such variables are present. Nothing was run. Set shellPath to bash, sh, dash, zsh or PowerShell (or remove it), or list the variables in the commandEnvKeep setting.";

function hideCommand(command, family, names, { platform = process.platform } = {}) {
	const list = [...new Set(names || [])];
	if (typeof command !== "string") return { ok: false, reason: "The command is not text." };
	if (!list.length) return { ok: true, command, hidden: 0 };
	const win = platform === "win32";
	if (family === "powershell") {
		const first = `${list.map(psName).join(",")} | ForEach-Object { [Environment]::SetEnvironmentVariable($_, $null, 'Process'); Remove-Item -LiteralPath ('Env:\' + $_) -ErrorAction SilentlyContinue }\n`;
		if (command.startsWith(first + PS_MARK)) return { ok: true, command, hidden: list.length };
		// The footer line makes the script block's last statement store its own success flag; the exit code then follows it as in an unwrapped command.
		const b64 = Buffer.from(command + "\n\n$__crustOk = $?", "utf8").toString("base64");
		const wrapped =
			first +
			PS_MARK + b64 + "'))) } catch { [Console]::Error.WriteLine($_.Exception.InnerException.Message); exit 1 }\n" +
			". $__crust\nif (-not $__crustOk) { exit 1 }";
		if (win && winCost(wrapped) > MAX_WINDOWS_LINE) return tooLong(wrapped);
		return { ok: true, command: wrapped, hidden: list.length };
	}
	if (family === "posix") {
		if (list.every((n) => POSIX_NAME.test(n))) {
			const prefix = `unset -v ${list.join(" ")}\n`;
			return { ok: true, command: command.startsWith(prefix) ? command : prefix + command, hidden: list.length };
		}
		// "$0" is the shell as it was started (bash: also $BASH); a leading "-" marks a login shell and is no program name. The new shell gets the
		// same $0 again, so scripts that print it see what they saw before.
		const head = `exec env ${list.map((n) => "-u " + sq(n)).join(" ")} "\${BASH:-\${0#-}}" -c '`;
		const tail = `' "$0"`;
		if (command.startsWith(head) && command.endsWith(tail)) return { ok: true, command, hidden: list.length };
		const wrapped = head + command.replace(/'/g, SQ_ESCAPE) + tail;
		if (win && winCost(wrapped) > MAX_WINDOWS_LINE) return tooLong(wrapped);
		return { ok: true, command: wrapped, hidden: list.length };
	}
	return { ok: false, reason: UNKNOWN_SHELL_REASON };
}

module.exports = { UNKNOWN_SHELL_REASON, SECRET_ENV_NAME, SECRET_ENV_NAME_MORE, isSecretName, parseKeepList, secretNames, shellFamily, hideCommand };
