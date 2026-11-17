#!/usr/bin/env node
// CI helper for the leak scan. The deny-list lives in the GitHub Actions secret LEAK_DENYLIST (one rule per line),
// never in the repo. This writes it to a file outside the workspace and prints that file's path, or deletes it again:
//   node scripts/ci-denylist.js write      reads env LEAK_DENYLIST, writes $RUNNER_TEMP/leak-denylist.txt, prints the path.
//                                           Exits 1 (and says "deny-list missing") when the secret is empty or has no rules,
//                                           for example on pull requests from forks, where secrets are not passed.
//                                           Also exits 1 when a rule is not a valid regular expression (reported by number, never by text).
//   node scripts/ci-denylist.js delete     removes that file.
// Nothing here ever prints the list or a word from it. The workflow must not echo the secret or use `set -x`.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseRules } = require("./check-secrets.js");

const file = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), "leak-denylist.txt");

function write(env = process.env) {
	const text = env.LEAK_DENYLIST || "";
	const rules = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
	if (!rules.length) return { ok: false, message: "deny-list missing: the LEAK_DENYLIST secret is empty or not available (secrets are not passed to pull requests from forks)." };
	// A rule that is not a valid regular expression is reported by number only, and nothing is written.
	const { invalid } = parseRules(text);
	if (invalid.length) return { ok: false, message: invalid.map((n) => `deny-list rule #${n} is invalid`).join("; ") + " (the rule text is not shown). Fix the LEAK_DENYLIST secret." };
	const f = file();
	fs.writeFileSync(f, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
	return { ok: true, file: f, rules: rules.length };
}

if (require.main === module) {
	const cmd = process.argv[2];
	if (cmd === "write") {
		const r = write();
		if (!r.ok) {
			process.stderr.write(r.message + "\n");
			process.exit(1);
		}
		process.stderr.write(`Deny-list written (${r.rules} rules).\n`);
		process.stdout.write(r.file + "\n");
	} else if (cmd === "delete") {
		fs.rmSync(file(), { force: true });
		process.stderr.write("Deny-list file removed.\n");
	} else {
		process.stderr.write("Usage: node scripts/ci-denylist.js write|delete\n");
		process.exit(2);
	}
}
module.exports = { write };
