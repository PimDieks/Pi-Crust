# Pi Crust: chat and visual-design features, implementation plan

**Status: WP1–WP8 done.**

## DESIGN RULES (must follow in every package)
Every new piece of UI must look like it was always part of Pi Crust. Before building UI, read `src/styles.css` (Pi Crust design tokens at the top) and look at the latest selftest screenshots in `out/` to match the existing look.
- **Tokens only**: colours via `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--hover`, `--selected`, `--border`, `--text`, `--muted`, `--accent`, `--accent-2`, `--ok/--warn/--err` and the `--fills-*-muted` / `--text-*` status pairs; spacing via `--space-*`, `--panel-pad*`, `--panel-gap`; radius via `--radius-*`; type via `--fs-*`, `--font`, `--mono`; shadows via `--elevation-*`; motion via `--dur`, `--dur-slow`, `--ease` and the `crust-pop` animation. No hex colours, no ad-hoc px values except 1px borders and sizes the existing CSS already uses (`--control-h`, `--chip-h`, `--icon`).
- **Reuse existing components/classes**: buttons `.btn` / `.btn.secondary` / `.btn.tertiary` / `.btn.naked`, icon buttons `button.icon` with a 14px inline SVG (stroke `currentColor`, same style as existing icons in `index.html`), menus/popovers like `.slash-menu` + `.pal-item`, toasts via `toast()`, dialogs via the existing `showDialog`/modal (`.modal-actions`), pills like the existing picks pills, tool-card look for in-chat cards, pane headers `.pane-header`, tabs like the existing middle tabs and chat tabs, selects like `#perm-mode`.
- **Layout**: new panels are Level-1 cards (`--panel`) on the base surface; floating things use `--panel-2` + `1px solid var(--border)` + `--radius-md` + `--elevation-2`. Compact density (24px controls, 20px chips, 12px text). Respect the chat pane min width (composer bar must still fit one row).
- **Both themes**: check light and dark (`<html data-theme>`). Selftest screenshots in both if possible.
- **Accessibility**: keyboard operable, `aria-label` on icon buttons, focus-visible like existing controls.
- **Icons**: no emoji in UI chrome; use small inline SVG icons consistent with existing ones.
- Hover-only actions (copy, edit, rewind) appear like existing hover affordances (muted `button.icon`, revealed on hover/focus-within).

## Shared conventions
1. Start with `git status` / `git diff`: the working tree has uncommitted work. Keep it; never revert, stash, reset or commit.
2. Main-process feature code → `src/<feature>-main.js` exporting `register(ctx)`; `main.js` gets one require line per feature.
3. Renderer feature code → `src/<feature>.js`, loaded via `<script>` in `index.html` after `palette.js`, before Monaco's `loader.js`. Subscribes to the hook bus (WP1); only tiny emit points in `renderer.js`.
4. `preload.js` add-only: one new namespace per feature.
5. New CSS in a clearly commented section at the end of `styles.css`.
6. Pure logic in testable modules with `*.test.js` siblings.
7. Verify: `node --check` every touched JS file; `npm test`; `npm run selftest -- <feature>` (only that feature's steps, see AGENTS.md) → inspect `out/<run>-*.png`, look for `[ui error]` and `MISMATCH`.
8. Update the README section per feature.

## Findings
- Pi RPC (`docs/rpc-commands.md` in Pi's docs): `prompt`, `abort`, `get_state` (incl. `thinkingLevel`), `get_messages`, `get_fork_messages` (`{entryId,text}`), `fork {entryId}` (returns `data.text`), `get_entries`, `get_tree`, `get_available_thinking_levels`, `set_thinking_level`, `get_commands`, `clone`, `get_last_assistant_text`. Events: `agent_start`, `agent_settled`, `message_start/update/end`, `tool_execution_start/update/end` (`result.details`), `turn_end`.
- Todo tool (`~/.pi/agent/extensions/todo.ts`): `details = {action, todos:[{id,text,done}], nextId}`.
- Code-block copy exists (`addCodeActions`); message copy doesn't.
- Thinking only via `/thinking` (`slash.js pickThinking`).
- No worktree code; `git:*`/`fs:*` use global `REPO`.
- Browser view is a native `WebContentsView` above the HTML, hidden via 0×0 bounds (`applyBrowserBounds`) → `capturePage()` only works while visible.
- `figma-mcp.js callTool` returns text parts only → `get_screenshot` needs a raw variant.
- `picker.js` `togglePick` returns formatted blocks only.
- Tabs hard-wired to 4: `TAB_DEFAULT_ORDER` + length check (`changes.js`), ⌘1–4 (`palette.js`), key list in main `before-input-event`.
- UI CSP: `default-src 'self'; script-src 'self'; img-src 'self' data:` → images as data URLs; no iframes to localhost.
- `npm test` only runs `src/figma-selection.test.js`. `npm run selftest` runs `runSelftestTour()` → `out/`.

---

## WP1: Hook bus, notifications, message copy, find in chat, thinking control (A, F, G, H)
New: `src/notify.js`, `src/chat-find.js`, `src/thinking.js`. Touch: `renderer.js`, `main.js`, `preload.js`, `index.html`, `styles.css`, `package.json`, `README.md`.
1. **Hook bus** top of `renderer.js`: `onCrust(name, fn)`, `emitCrust(name, ...args)` (try/catch per handler). Emits: `turn:start(chat)` (agent_start), `turn:settled(chat,{aborted})` (agent_settled), `user:rendered(chat,node,message)` (end of renderUser; include whether it's history), `assistant:turn(chat,root)` (startAssistant), `text:final(chat,blockEl,raw)` (text_end and in renderHistory after flushRender; set `b.final=true`), `tool:end(chat,{toolName,toolCallId,args,result,isError,history})` (tool_execution_end and toolResult in `sessions.js renderHistory` with history:true), `chat:cleared`, `chat:activated`, `chat:closed`, `models:loaded(chat,stateData)`, `ask:added(chat,spec)`. Add `const selftestSteps=[]`; `runSelftestTour` awaits each `step({snap,wait})` before `crust.selftest.done()`.
2. **main.js ctx** (before `app.whenReady`): getters `repo, env, win, browserView, selftest`; `send, run, insideRepo, readSettings, writeSettings, showWindow, app, ipcMain, getBrowserBounds`. Later: `require('./x-main').register(ctx)`.
3. **A notifications**: IPC `app:isFocused` (win.isFocused()), `app:badge(n)` (app.dock.setBadge), `app:show`, `app:bounce`. On `turn:settled`/`ask:added` when window unfocused → `new Notification("Pi finished"|"Pi asks", {body: chat label})`, onclick → show + activate(chat). Focused but other tab → toast with an Open action. Badge = chats with unread||asks while unfocused; clear on focus/activate. Skip in selftest. Palette toggle "Notifications: on/off" (localStorage).
4. **F copy**: on `assistant:turn` add hover `.turn-actions` with Copy (`button.icon`) copying joined raw text blocks via `crust.clipboard.write`. Verify code-block copy hover styling.
5. **G find** (`chat-find.js`): ⌘F (capture phase, not inside `.monaco-editor`/`.xterm`) opens a find bar pinned top of `#messages-host`: input, "n / m", ↑/↓ (Enter/⇧Enter), Esc. TreeWalker over active chat's `c.el`; CSS Custom Highlight API (`::highlight(chat-find)`, `::highlight(chat-find-current)`) — no DOM mutation. Re-run on `chat:activated` and debounced while open.
6. **H thinking** (`thinking.js`): `<select id="thinking-level">` in `.composer-bar` after `#perm-mode`, styled like it. On `models:loaded`/`chat:activated`: fill from `get_available_thinking_levels`, select `stateData.thinkingLevel`; hide when only `off`. Change → `set_thinking_level`, revert on failure. `slash.js pickThinking` calls `window.refreshThinking?.()`.
7. `package.json` test → `node --test src/*.test.js`.
8. Selftest steps: thinking levels log, find with "folder" + `snap('find')`.

## WP2: @ mentions, todo panel, Mermaid (B, E, V11) — DONE
New: `src/mention-menu.js`, `src/todo-panel.js`, `src/mermaid-render.js`.
1. **B** clone of `slash-menu.js`: trigger `/(^|\s)@([^\s@`]*)$/` on text before caret; source `fileIndex`/`refreshSources()`/`fuzzy()`/`highlight()` from `palette.js` (refresh if >30s); basename matches first; ≤12; directories too. Accept (Tab/Enter/click) → `` `path` `` + space. Esc closes. Reuse `.slash-menu` styling, `id="mention-menu"`, ARIA.
2. **E** `<div id="todo-panel" hidden>` between `#widgets` and `#ask`. On `tool:end` toolName `todo`: `result.details.todos` (generic: text|content|title; done===true|status done/completed; in_progress). Store `chat.todos`, reset on `chat:cleared`, rebuilt from history events. Header "Todos 2/5" collapsible; ✓/○/◐ as small SVG/glyph styled with tokens; done muted; hide when empty; auto-collapse 3s after all done. Re-render on `chat:activated`.
3. **V11** `npm i mermaid`; lazy-load `../node_modules/mermaid/dist/mermaid.min.js`; `initialize({startOnLoad:false, securityLevel:'strict', theme by currentTheme(), flowchart:{htmlLabels:false}})`; ideally themeVariables mapped from CSS tokens. On `text:final` render `code.language-mermaid` → `mermaid.render` → `DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},RETURN_DOM_FRAGMENT:true})` → `.mermaid-block` with a "Code" toggle. Cache by source+theme; re-render on theme change; error → keep code + note. In `flushRender`, after `replaceChildren(md(b.raw))`, `if (b.final) emitCrust('text:final', view, b.el, b.raw)`.
4. Selftest: "@pack" mention snap; fake todo snap; fake mermaid snap.

## WP3: Checkpoints, rewind, edit & resend (C, D) — DONE
New: `src/checkpoints-main.js`, `src/checkpoints.test.js`, `src/rewind.js`. Touch `main.js` (register), `preload.js`, `index.html`, `styles.css`, `slash.js`, README.
- `create({sessionFile,text})`: copy `git rev-parse --git-path index` to tmp idx; `GIT_INDEX_FILE=idx git add -A`; `write-tree`; `commit-tree <tree> [-p HEAD]` with GIT_AUTHOR_*/COMMITTER_* env; `update-ref refs/pi-crust/cp/<id>`; delete idx. Never touch real index/HEAD/branches.
- `restore(id)`: `pre=create('before restore')` keeping its idx; `files = git diff --name-status pre.tree target.tree`; `GIT_INDEX_FILE=preIdx git read-tree -m -u pre.tree target.tree`; return `{ok, undoId, files}`.
- Serialize git ops per repo. Metadata `userData/checkpoints/<sha1(repo)>.json` (`id, commit, tree, sessionFile, textHash, text≤120, at`), prune to 300 (+ `update-ref -d`). `copy(fromFile,toFile,beforeAt)` for forks.
- IPC `checkpoints:create|list|preview|restore|copy|clear` → `crust.checkpoints.*`.
- Renderer `rewind.js`: live `user:rendered` → create, store `node.dataset.cp`; history → match by textHash against cached list. Hover bar on `.msg.user`: Edit (pencil) and Rewind icons. Map node → fork entry via `get_fork_messages`, aligning from the end with text check.
- **Edit**: `confirmStopIfWorking('edit')` → `fork` → `showCurrentSession()` → `splitPicks(f.data.text)` back into pills + `#input`; notice "Editing an earlier message"; optional "Also restore files" checkbox.
- **Rewind**: dialog listing file changes (preview) with checkboxes Code / Conversation → restore → fork (prefill) → `checkpoints.copy`; toast "Undo restore". No checkpoint → conversation only. Refresh changes + tree.
- `/rewind` slash command + palette action.
- Tests in a temp git repo: create→modify/add/delete→restore equals snapshot; real index and HEAD unchanged; ignored untouched; undo works.

## WP4: Capture infra, per-turn before/after, timeline (V4, V5) — DONE
New: `src/snap-main.js`, `src/compare-view.js`, `src/turn-shots.js`, `src/timeline.js`. Touch `main.js` (`applyBrowserBounds`, register), `preload.js`, `index.html` (`#timeline` under `#chat-tabs`), `styles.css`, README.
1. Hidden-browser capture: keep `lastRealBounds`; when hidden `setVisible(false)` (keep bounds) instead of 0×0; when shown `setVisible(true)`. Check zoom selftest and modals. Fallback: offscreen capture.
2. `snap-main.js`: `captureLive({rect})` (`capturePage(rect,{stayHidden:true})`); `captureUrl(url,{width,height,colorScheme,mobile,fullPage,settleMs=800})` via offscreen BrowserWindow (partition `persist:devbrowser`), debugger CDP `Emulation.setDeviceMetricsOverride`, `Emulation.setEmulatedMedia`, `Page.captureScreenshot`; max 2 concurrent. Store `userData/shots/<sha1(repo)>/<id>.png` + ≤480px jpeg thumb; prune 500. IPC `snap:live|url|get|list|tag` → `crust.snap.*`.
3. `compare-view.js` `createCompare(beforeSrc, afterSrc, {mode})`: modes slider (clip-path + range) and overlay (opacity range), plus side-by-side; mode tabs styled like existing segmented/tab controls; keyboard + aria.
4. **V4** on `turn:start` capture before; count `edit`/`write` on `tool:end`; on `turn:settled` with edits wait for load or 1500ms, capture after; append a `.shot-card` (tool-card look) with thumbnail compare; click → large modal. Tag shots `{sessionFile, cpId, before/after}`. Palette toggle "Before/after screenshots".
5. **V5** `#timeline` strip of after-thumbnails for active chat (persisted + live); click → popover with large compare, prompt text, "Rewind to before this turn" (WP3), "Show in chat". Collapse toggle; re-render on activate/settle/fork.
6. Selftest: `snap:url` non-empty; `snap('timeline')`.

Notes (as built): hidden view = `setVisible(false)` with real bounds (a zero-size slot while hidden keeps the last real bounds); `captureUrl` must load `about:blank` before attaching CDP (otherwise `Emulation.*` hangs); `snap:selftestLoad` (selftest only) loads a data: page into the dev browser; data: URLs are only accepted by `snap:url`/`snap:live` in selftest. Shots of a chat are listed by `sessionFile`, so a fork starts with an empty timeline. The `zoom check ... MISMATCH` was the browser view being hidden (tab not Browser) at 0×0 when the check ran, not a regression from WP1–3; the check now also prints `visible`.

## WP5: Design tab, Figma compare, onion skin, pixel diff, annotate (V1, V2, V6) — DONE
New: `src/design.js`, `src/design-compare.js`, `src/pixel-diff.js` + test, `src/design-main.js`, `src/annotate.js`. Touch `index.html` (5th tab + annotate button), `changes.js` (tolerant tab order: add missing tabs instead of reset), `palette.js` (⌘5), `main.js` (`"5"` in before-input-event; register), `figma-mcp.js` (`callToolRaw`), `preload.js`, `styles.css`, README.
1. Design tab "Design ⌘5": segmented control + view host; `registerDesignView({id,label,mount,show,hide})`. Hides browser view.
2. IPC `figma:screenshot`: `get_screenshot` (raw image part) + `get_metadata` for frame w/h → `{dataUrl, frameW, frameH, name, nodeId}`; errors via `figmaError`.
3. **V1** Compare view: "Get Figma selection", "Capture build" with source select (same size as frame via `snap:url`; current viewport `snap:live`; picked element via pick + rect — `togglePick` gains `raw: els`). `createCompare` modes side-by-side, overlay, onion/slider. Normalise scale. "Send to chat" → `addImages` + note.
4. **V2** `pixel-diff.js` (UMD): `diff(a,b,{threshold})` → `{matchPct, diffCount, heatmap}` YIQ distance; Diff mode with heatmap + "92.4 % match" + threshold slider. Tests.
5. **V6** `annotate.js`: browser-bar pen button → `snap:live()` → overlay in middle pane (hide browser view) with pen/arrow/box/text, colour from theme tokens, undo/redo, clear, shortcuts P/A/B/T, ⌘Z; note textarea; "Add to chat" → PNG File → `addImages` + note to `#input`. Esc cancels.
6. Selftest: design-compare snap; diff log; annotate snap.

Notes (as built): `design.js` owns the segmented control and exports `registerDesignView` and `window.crustDesign` (`select`, `loadImage`, `dataUrlToFile`, `tokenRgb/tokenColor` for canvas colours from tokens, `empty`, `sendToChat`). `switchTab` emits `tab:changed(name, prev)`. Tab order is tolerant (new tabs are appended to a saved order). `createCompare` got `labels` and per-mode `render({stage, extras, ...})` (used for Diff). Figma: `figma:screenshot` runs `get_design_context` (selection → node id and name), `get_metadata {nodeId}` (frame size) and `get_screenshot {nodeId}`; `figma-mcp.callToolRaw` returns the content parts. `browser:pick` also returns `raw` (the described elements). Annotate overlay lives inside the Browser panel (hide reason `annotate`); palette action "Annotate a screenshot of the page".

## WP6: Token check, tweak panel, theme board (V3, V7, V10) — DONE
New: `src/page-tokens.js`, `src/token-match.js` + test, `src/tweak.js`, `src/design-tokens.js`. Touch `picker.js`, `design-main.js`, `index.html`, `preload.js`, `styles.css`, README.
1. `token-match.js` UMD: `normalizeColor`, `matchColor`, `matchLength`, `matchTypography` → `{token, nearest, delta}`. Tests.
2. `page-tokens.js` `TOKENS_JS` defines `window.__piTokens = {collect(), check(el)}`: CSS custom props from same-origin sheets + MUI theme via React fibers (palette, spacing(0..16), shape.borderRadius, typography). `check(el)` matches computed styles; matcher inlined via `Function.prototype.toString`.
3. **V3** picker: inject TOKENS_JS before PICKER; hover label second line with chips (✓ token / ✗ hard-coded) coloured with success/minor tokens; `describe()` adds `tokens`; `format()` adds a "token check:" line. No tokens → "no theme tokens found".
4. **V7** `tweak.js`: browser-bar sliders button → single pick → `#tweak-panel` right drawer inside browser panel (browser slot shrinks). Controls padding (linked/per side), gap, radius, font-size, colour/background (+ token dropdown); snap to tokens (⌥ for free). Live via IPC `browser:insertCss`/`browser:removeCss`. Apply → precise before→after request + `<browser-element>` pill sent via `sendPrompt`; "Add to composer" alternative. Remove CSS after next `fs:changed`. Reset/close.
5. **V10** Tokens design view: IPC `design:tokens`; swatches (name, value, contrast), spacing bars, radii, type specimens. "Compare with Figma variables" via `get_variable_defs` + `parseDefs` from `figma-selection.js`, normalised name match; ✓ / ≠ / only in code / only in Figma. Optional `designTokensFile` JSON setting; button "Ask Pi to export the theme as tokens JSON".
6. Selftest: inject `:root{--brand:#ff0000}` page, log tokens + check; `snap('tokens')`.

Notes (as built): `page-tokens.js` is a main-process module (`TOKENS_JS` + pure `muiTokens`), `token-match.js` exposes its own source (`TokenMatch.source`) which is inlined into the page. The picker gets the status colours for its chips from the UI (`crust.browser.pick(opts)`, `crustDesign.pickOpts()`). New IPC in `design-main.js`: `design:tokens`, `design:inspect` (marks the element `data-pi-tweak`, returns current values + tokens), `design:untag`, `design:figmaVariables`, `design:tokensFile`, `browser:insertCss/removeCss`. The browser panel is now `#browser-body` (slot + `#tweak-panel`). Tokens file format: `{colors, spacing, radii|radius, typography}` (nested groups, `$value`/`value` allowed). Figma names are matched after normalising (`color/brand` ↔ `--brand` by suffix).

## WP7: Viewport/theme grid, Storybook gallery (V8, V9) — DONE
New: `src/design-viewports.js`, `src/design-stories.js`, `src/storybook-main.js`.
1. **V8** Viewports view: presets Mobile 390×844 (mobile), Tablet 820×1180, Desktop 1440×900; Light/Dark/both toggles; URL field. Tile grid via `snap:url` with `colorScheme`, concurrency 2, spinner per tile; refresh; auto-refresh on `fs:changed` (1.5s, only when visible); click tile → large + "Send to chat".
2. **V9** `storybook-main.js` detect `storybook` scripts (root, apps/*, libs/*, packages/*) and probe `settings.storybookUrl || http://localhost:6006` `/index.json` then `/stories.json`. IPC `storybook:detect`. Not running → "Start Storybook" in terminal (pnpm if pnpm-lock). Grid grouped by title; lazy thumbnails via `snap:url(iframe.html?id=…&viewMode=story, 480×320)` cached; click → open in Browser tab; "Ask Pi" → thumbnail image + `` Story `title / name` (`importPath`) `` in composer. Empty state explains `storybookUrl`.
3. Selftest: viewports snap; stories-empty snap.

Notes (as built): views `viewports` and `stories` register with `registerDesignView`; `crustDesign.openImage` (large image in the shared dialog with an extra action) and `crustDesign.spinner` are shared. Viewport tiles are `snap:url` shots (viewport only, mobile emulation for Mobile). `storybook-main.js` also exports `parseIndex`, `detectProjects`, `packageManager`, `probe` (tested). "Start Storybook" runs `[cd <dir> &&] <pm> run <script>` through `runInTerminal` and polls every 2 s for 90 s. Tile click navigates the Browser tab to `<url>/?path=/story/<id>`.

## WP8: Worktree per chat (I) — DONE
New: `src/worktree-main.js`, `src/worktree.js`. Touch `main.js` (startPi cwd, openList cwd, git root), `preload.js`, `index.html`, `renderer.js` (tab badge), `changes.js`, `sessions.js`, `styles.css`, README.
- Chevron next to ＋ / palette "New chat in worktree…" → branch name (default `pi/<yyyymmdd-hhmm>`). `worktree:create` → `git worktree add -b <branch> <userData>/worktrees/<sha1(repo)>/<slug> HEAD`.
- `pi:newChat(sessionFile,{cwd})`; validate cwd via `git worktree list --porcelain`; `openList` entries `{id,file,cwd}`.
- `activeRoot = chat.cwd || REPO` for `git:*` handlers; tree/editor stay on main checkout with a banner in Changes.
- `sessions:list` also reads worktree session dirs. Tab shows a branch badge (SVG icon). Close chat → "Remove worktree? (branch kept)" (dirty → Keep/Force). Offer installing deps in the worktree terminal.
- Selftest: create in pi-crust repo, chat, verify, remove in `finally`.

Notes (as built): `worktree-main.js` (`worktree:create|list|status|remove`, `findWorktree` validates every cwd against `git worktree list --porcelain`; selftest-only helpers). `startPi(chatId, file, hint, cwd)`; open-list entries are `{id, file, cwd}` and `open-chats.json` keeps `cwds` per session file so worktree chats reopen there. `gitRoot()` (the active chat's worktree, else the repo) is the default cwd of `run()`, so Changes, diff, discard (path check against that root), commit, push and PR info follow the active chat; the file tree (`git:status` with `main=true`), editor, commit graph and `fs:index` stay on the main checkout. The Changes diff is the read-only text diff while a worktree chat is active (the Monaco diff editor reads/writes the main checkout). Checkpoints use one store per working root (`ctx.activeRoot()`). `fs:changed` also fires for edits inside open worktrees. `sessions:list` adds the sessions of existing worktrees (`cwd`, `branch`) and opening one resumes it there. Closing a worktree chat: `worktreeAskRemove` (Remove / Keep; dirty: Force remove / Keep) then `worktreeRemove` once its Pi has exited; the branch is always kept.

## Order
WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7 → WP8. Known limits: a worktree needs its own dependencies (a toast offers `<pm> install` in the Terminal tab); the commit graph and file tree always show the main checkout; checkpoints don't cover ignored files or messages sent before WP3; edited messages lose images; viewport grid is snapshots, not live; theme from runtime/CSS vars/JSON, not arbitrary TS files.
