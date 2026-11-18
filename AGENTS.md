# Pi Crust: agent notes

## Self-testing: test only the feature you changed

Don't run the full `npm run selftest` tour after every change. It visits every tab and feature and takes minutes. Run only the feature you touched:

```bash
npm run selftest -- <feature>            # e.g. npm run selftest -- timeline
npm run selftest -- <feature> <feature>  # several, e.g. timeline annotate
```

- Step names come from the script that registers the step (`selftestSteps.push(...)` in `src/<name>.js` gives `<name>`). Examples: `timeline`, `annotate`, `chat-find`, `design-tokens`, `worktree`, `tweak`. The turn timers are `durations`, and the built-in tour (context panel, changes, theme, terminal, editor, palette, chat tabs, modes, layout, zoom) is `core`.
- If you build a new feature, register its own selftest step in its script so it can be tested alone. Don't add it to `runCoreTour`.
- An unknown name prints `SELFTEST only: ... MISMATCH unknown ... (known: ...)` with the valid names.
- Use a short `PI_CRUST_SELFTEST_PROMPT` and a lower `PI_CRUST_SELFTEST_TIMEOUT` when the feature doesn't need a real turn.
- For pure logic, prefer `node --test src/<module>.test.js` over a selftest. Test files (`*.test.js`) are gitignored: they stay local and are never committed or pushed. Don't `git add -f` them.
- Run the full tour (`npm run selftest` with no names) only when asked, or before a release or a change that affects the whole app (layout, main.js startup, shared renderer code).
- Check the output for `MISMATCH` and `[ui error]`, and look at the `out/<run>-*.png` screenshots from that run.

## Never push secrets

Every commit and push runs the secret check (`.githooks`, `scripts/check-secrets.js`; `npm install` turns it on via `core.hooksPath`).

- Before committing, make sure `git config core.hooksPath` prints `.githooks`; if not, run `npm install` or `node scripts/install-hooks.js`.
- Never use `--no-verify` to get past it. If it blocks, remove the secret (environment variable or a file outside the repo) and rewrite the commit if it's already in one. Only for a confirmed false positive: add `secret-check: allow` on that line, and tell the user.
- Never commit `.env` files, `auth.json` or other login files, keys or certificates, real tokens in tests or docs, or personal data from the user's machine.
- Test files (`*.test.js`, `*.spec.*`, `test/`, `tests/`, `__tests__/`) may hold made-up passwords in URLs and assignments; the check skips those generic patterns there. Fake tokens in a real format (`ghp_…`, `sk-ant-…`, keys) are still caught everywhere, so build those from pieces (see `scripts/check-secrets.test.js`).
- Before pushing, also look at `git diff origin/main..HEAD --stat` for files that shouldn't be there.

## UI layers: nothing overlaps

Every new overlay (menu, popover, toast, panel, modal, confirmation) takes a named `--layer-*` z-index from `src/styles.css` (panel, popover, toast, modal, confirm; never a bare number), and anything that needs an answer sits above whatever is open.
Add a case for it to `OVERLAYS` in `src/layers.js` and run `npm run selftest -- layers`: every control of the top overlay must be reachable with `elementFromPoint`.
