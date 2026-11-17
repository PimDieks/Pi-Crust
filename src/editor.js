// Editor tab: open files from the tree and edit them with Monaco (the editor of VS Code).
// One Monaco editor, one model per open file. Clean files follow changes on disk (e.g. Pi's edits);
// a file with unsaved changes gets a bar to reload or keep yours. Unsaved changes survive a restart
// and a repo switch ("hot exit"), stored per repo in localStorage.
"use strict";

const ED_VS = "../node_modules/monaco-editor/min/vs";
const ED_HOT_EXIT_MAX = 2 * 1024 * 1024; // don't keep huge unsaved buffers in localStorage

let edMonaco = null; // the monaco namespace once loaded
let edLoading = null;
let edEditor = null;
const edFiles = new Map(); // rel path -> { path, model, savedVersion, mtime, viewState, conflict, error }
let edActive = null; // rel path
let edRepo = null; // the repo the open files belong to
let edRestored = false;
let edPersistTimer;

// ---------------------------------------------------------------------------
// Loading Monaco (lazily: only when a file is opened)
// ---------------------------------------------------------------------------
function edCssVar(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function edApplyTheme() {
	if (!edMonaco) return;
	const dark = currentTheme() === "dark";
	edMonaco.editor.defineTheme("crust", {
		base: dark ? "vs-dark" : "vs",
		inherit: true,
		rules: [],
		colors: { "editor.background": edCssVar("--levels-level-1") || (dark ? "#111111" : "#ffffff") },
	});
	edMonaco.editor.setTheme("crust");
}

function edLoadMonaco() {
	if (edMonaco) return Promise.resolve(edMonaco);
	if (edLoading) return edLoading;
	edLoading = new Promise((resolve, reject) => {
		const workerMain = new URL(`${ED_VS}/base/worker/workerMain.js`, location.href).href;
		self.MonacoEnvironment = { getWorkerUrl: () => workerMain };
		require.config({ paths: { vs: ED_VS } });
		require(["vs/editor/editor.main"], () => {
			edMonaco = window.monaco;
			// Without the rest of the project Monaco can't resolve imports: keep syntax errors, drop type errors.
			const ts = edMonaco.languages.typescript;
			for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
				d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
				d.setCompilerOptions({ target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true, allowNonTsExtensions: true });
			}
			edApplyTheme();
			onThemeChange(edApplyTheme);
			resolve(edMonaco);
		}, reject);
	});
	return edLoading;
}

// Word wrap (on by default so lines stay inside the panel); ⌥Z toggles it in the Editor and the Changes diff.
function edWordWrap() {
	return localStorage.getItem("wordWrap") === "off" ? "off" : "on";
}

function edToggleWordWrap() {
	localStorage.setItem("wordWrap", edWordWrap() === "on" ? "off" : "on");
	const wordWrap = edWordWrap();
	edEditor?.updateOptions({ wordWrap });
	if (typeof chDiff !== "undefined" && chDiff) chDiff.updateOptions({ wordWrap });
	toast(`Word wrap ${wordWrap}`, "info");
}

function edCreateEditor() {
	if (edEditor) return edEditor;
	const m = edMonaco;
	edEditor = m.editor.create($("#editor-host"), {
		model: null,
		theme: "crust",
		automaticLayout: true,
		fontFamily: edCssVar("--mono") || "SF Mono, Menlo, monospace",
		fontSize: 12,
		lineHeight: 18,
		minimap: { enabled: true, renderCharacters: false },
		scrollBeyondLastLine: false,
		renderWhitespace: "selection",
		bracketPairColorization: { enabled: true },
		guides: { bracketPairs: true, indentation: true },
		smoothScrolling: true,
		tabSize: 2,
		detectIndentation: true,
		fixedOverflowWidgets: true,
		wordWrap: edWordWrap(),
		wrappingIndent: "same",
	});
	edEditor.addAction({
		id: "crust.toggleWordWrap",
		label: "Toggle Word Wrap",
		keybindings: [m.KeyMod.Alt | m.KeyCode.KeyZ],
		run: edToggleWordWrap,
	});
	edEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => edSave(edActive));
	edEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Alt | m.KeyCode.KeyS, edSaveAll);
	edEditor.addAction({
		id: "crust.addToChat",
		label: "Add Selection to Chat",
		keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyL],
		contextMenuGroupId: "navigation",
		contextMenuOrder: 0,
		run: edAddSelectionToChat,
	});
	edEditor.addAction({
		id: "crust.mentionFile",
		label: "Mention File in Chat",
		contextMenuGroupId: "navigation",
		contextMenuOrder: 1,
		run: () => edActive && mention(edActive),
	});
	edEditor.addAction({
		id: "crust.openInVSCode",
		label: "Open in VS Code",
		contextMenuGroupId: "navigation",
		contextMenuOrder: 2,
		run: () => edActive && crust.fs.openInEditor(edActive),
	});
	edEditor.onDidChangeCursorPosition(edStatus);
	edEditor.onDidChangeModelContent(() => {
		edRenderTabs();
		edPersistSoon();
	});
	return edEditor;
}

// ---------------------------------------------------------------------------
// Opening, switching, closing
// ---------------------------------------------------------------------------
function edDirty(f) {
	return !!f?.model && f.model.getAlternativeVersionId() !== f.savedVersion;
}

function edUri(rel) {
	return edMonaco.Uri.file(fileUri(info.repo, rel));
}

// Opens `rel` (a repo-relative path) in the Editor tab. `opts.line` jumps to a line; `opts.background` doesn't switch tabs.
async function openFile(rel, opts = {}) {
	if (!rel || !info.repo) return;
	edEnsureRepo();
	if (!opts.background) switchTab("editor");
	try {
		await edLoadMonaco();
	} catch (e) {
		toast(`Couldn't load the editor: ${e?.message || e}`, "error");
		return;
	}
	edCreateEditor();
	let f = edFiles.get(rel);
	if (!f) {
		f = { path: rel, model: null, savedVersion: 0, mtime: 0, viewState: null, conflict: null, error: null };
		edFiles.set(rel, f);
		await edLoad(f, opts.unsaved);
	}
	if (!opts.background || !edActive) edActivate(rel);
	if (opts.line && edActive === rel && f.model) {
		edEditor.revealLineInCenter(opts.line);
		edEditor.setPosition({ lineNumber: opts.line, column: 1 });
	}
	if (!opts.background) edEditor.focus();
	edPersistSoon();
}

async function edLoad(f, unsaved) {
	let r;
	try {
		r = await crust.fs.read(f.path);
	} catch (e) {
		r = { error: String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") };
	}
	f.mtime = r.mtime || 0;
	f.error = r.error || null;
	if (r.error) return;
	const uri = edUri(f.path);
	edMonaco.editor.getModel(uri)?.dispose();
	f.model = edMonaco.editor.createModel(r.content, undefined, uri); // language from the file name
	f.savedVersion = f.model.getAlternativeVersionId();
	if (typeof unsaved?.content === "string" && unsaved.content !== r.content) {
		f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: unsaved.content }], () => null);
		if (unsaved.mtime && unsaved.mtime !== f.mtime) f.conflict = "changed";
	}
}

function edActivate(rel) {
	const prev = edFiles.get(edActive);
	if (prev?.model && edEditor) prev.viewState = edEditor.saveViewState();
	edActive = rel;
	const f = edFiles.get(rel);
	edEditor?.setModel(f?.model || null);
	if (f?.viewState) edEditor.restoreViewState(f.viewState);
	$("#editor-host").style.visibility = f?.model ? "visible" : "hidden";
	edRender();
	// Follow the active file in the tree.
	if (f) {
		selectedPath = rel;
		for (const r of document.querySelectorAll("#tree .node")) r.classList.toggle("selected", r.dataset.path === rel);
		document.querySelector(`#tree .node[data-path="${CSS.escape(rel)}"]`)?.scrollIntoView({ block: "nearest" });
	}
	edPersistSoon();
}

async function edClose(rel, force) {
	const f = edFiles.get(rel);
	if (!f) return;
	if (!force && edDirty(f)) {
		const name = rel.split("/").pop();
		const r = await showDialog({ method: "select", title: `Save changes to ${name}?`, message: "Your changes are lost if you don't save them.", options: ["Save", "Don't save"] });
		if (r.cancelled || !r.value) return;
		if (r.value === "Save" && !(await edSave(rel))) return;
	}
	const keys = [...edFiles.keys()];
	const i = keys.indexOf(rel);
	f.model?.dispose();
	edFiles.delete(rel);
	if (edActive === rel) {
		const next = keys[i + 1] || keys[i - 1];
		edActive = null;
		if (next && next !== rel) edActivate(next);
		else {
			edEditor?.setModel(null);
			edRender();
		}
	} else edRender();
	edPersistSoon();
}

// ---------------------------------------------------------------------------
// Saving and changes on disk
// ---------------------------------------------------------------------------
async function edSave(rel) {
	const f = edFiles.get(rel);
	if (!f?.model) return false;
	if (f.conflict === "changed") {
		const ok = await showDialog({ method: "confirm", title: "File changed on disk", message: `${rel} changed on disk after you opened it. Overwrite it with your version?`, yesLabel: "Overwrite", danger: true });
		if (!ok.confirmed) return false;
	}
	const version = f.model.getAlternativeVersionId();
	try {
		const r = await crust.fs.write(rel, f.model.getValue());
		f.mtime = r.mtime;
		f.savedVersion = version;
		f.conflict = null;
		edRender();
		edPersistSoon();
		return true;
	} catch (e) {
		toast(`Couldn't save ${rel}: ${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`, "error");
		return false;
	}
}

async function edSaveAll() {
	for (const f of edFiles.values()) if (edDirty(f)) await edSave(f.path);
}

// Called when files in the repo change: clean files reload, dirty ones get the conflict bar.
let edChecking = false;
async function edCheckDisk() {
	if (edChecking || !edFiles.size) return;
	edChecking = true;
	try {
		for (const f of [...edFiles.values()]) {
			const st = await crust.fs.stat(f.path);
			if (!edFiles.has(f.path)) continue;
			if (!st.exists) {
				if (f.conflict !== "deleted") {
					f.conflict = "deleted";
					edRender();
				}
				continue;
			}
			if (f.conflict === "deleted") f.conflict = null;
			if (st.mtime === f.mtime) continue;
			if (!f.model) {
				await edLoad(f);
				if (edActive === f.path) edActivate(f.path);
			} else if (edDirty(f)) f.conflict = "changed";
			else await edReload(f);
			edRender();
		}
	} finally {
		edChecking = false;
	}
}

// Replaces the model's text with the file on disk, as one undoable edit (cursor and scroll stay put).
async function edReload(f) {
	const r = await crust.fs.read(f.path);
	if (r.error || !f.model) return;
	f.mtime = r.mtime;
	f.conflict = null;
	if (f.model.getValue() !== r.content) {
		f.model.pushStackElement();
		f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: r.content }], () => null);
		f.model.pushStackElement();
	}
	f.savedVersion = f.model.getAlternativeVersionId();
	edPersistSoon();
}

// ---------------------------------------------------------------------------
// Chat integration
// ---------------------------------------------------------------------------
function edAddSelectionToChat() {
	const f = edFiles.get(edActive);
	if (!f?.model) return;
	const sel = edEditor.getSelection();
	const range = sel.isEmpty() ? f.model.getFullModelRange() : sel;
	const text = f.model.getValueInRange(range);
	if (!text.trim()) return;
	const lines = sel.isEmpty() ? "" : range.startLineNumber === range.endLineNumber ? `${range.startLineNumber}` : `${range.startLineNumber}-${range.endLineNumber}`;
	const lang = f.model.getLanguageId();
	addPicks([`<code-selection path="${f.path}"${lines ? ` lines="${lines}"` : ""} source="editor">\n\`\`\`${lang === "plaintext" ? "" : lang}\n${text}\n\`\`\`\n</code-selection>`]);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function edRender() {
	edRenderTabs();
	const f = edFiles.get(edActive);
	$("#editor-empty").hidden = !!f?.model;
	$("#editor-empty").textContent = f?.error ? `${f.path}: ${f.error}` : "Click a file in the tree to open it.";
	$("#editor-host").style.visibility = f?.model ? "visible" : "hidden";
	const bar = $("#editor-conflict");
	bar.replaceChildren();
	bar.hidden = !f?.conflict;
	if (f?.conflict === "changed") {
		const reload = el("button", "", "Reload from disk");
		reload.type = "button";
		reload.onclick = async () => {
			await edReload(f);
			edRender();
		};
		const keep = el("button", "", "Keep mine");
		keep.type = "button";
		keep.onclick = async () => {
			const st = await crust.fs.stat(f.path);
			f.mtime = st.mtime || f.mtime;
			f.conflict = null;
			edRender();
		};
		bar.append(el("span", "", "This file changed on disk and you have unsaved changes."), el("span", "spacer"), reload, keep);
	} else if (f?.conflict === "deleted") {
		const close = el("button", "", "Close");
		close.type = "button";
		close.onclick = () => edClose(f.path, true);
		bar.append(el("span", "", keyLabel("This file was deleted on disk. Save (⌘S) to recreate it.")), el("span", "spacer"), close);
	}
	$("#editor-path").textContent = f ? f.path : "";
	$("#editor-lang").textContent = f?.model ? f.model.getLanguageId() : "";
	edStatus();
}

function edRenderTabs() {
	const strip = $("#editor-tabs");
	const names = {};
	for (const p of edFiles.keys()) {
		const n = p.split("/").pop();
		names[n] = (names[n] || 0) + 1;
	}
	let dirtyCount = 0;
	const tabs = [...edFiles.values()].map((f) => {
		const name = f.path.split("/").pop();
		const dirty = edDirty(f);
		if (dirty) dirtyCount++;
		const tab = el("div", `ed-tab${dirty ? " dirty" : ""}`);
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(f.path === edActive));
		tab.tabIndex = 0;
		tab.title = f.path + (dirty ? " (unsaved)" : "");
		tab.append(el("span", "ed-label", name));
		if (names[name] > 1) tab.append(el("span", "ed-dir", f.path.split("/").slice(-2, -1)[0] || ""));
		const x = el("button", "ed-close");
		x.type = "button";
		x.setAttribute("aria-label", `Close ${name}`);
		x.append(el("span", "", "×"));
		x.onclick = (e) => {
			e.stopPropagation();
			edClose(f.path);
		};
		tab.append(x);
		tab.onclick = () => {
			edActivate(f.path);
			edEditor?.focus();
		};
		tab.onauxclick = (e) => e.button === 1 && edClose(f.path);
		tab.onkeydown = (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				tab.click();
			}
		};
		return tab;
	});
	strip.replaceChildren(...tabs);
	strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	$("#editor-dirty-count").textContent = dirtyCount ? String(dirtyCount) : "";
}

function edStatus() {
	const pos = edEditor?.getPosition();
	$("#editor-pos").textContent = pos && edFiles.get(edActive)?.model ? `Ln ${pos.lineNumber}, Col ${pos.column}` : "";
}

// ---------------------------------------------------------------------------
// Persistence per repo: open tabs, the active one, and unsaved text ("hot exit")
// ---------------------------------------------------------------------------
function edPersistSoon() {
	clearTimeout(edPersistTimer);
	edPersistTimer = setTimeout(edPersist, 500);
}

function edPersist() {
	if (!edRepo) return;
	const files = [...edFiles.values()].map((f) => {
		const out = { path: f.path };
		if (edDirty(f)) {
			const content = f.model.getValue();
			if (content.length <= ED_HOT_EXIT_MAX) Object.assign(out, { content, mtime: f.mtime });
		}
		return out;
	});
	try {
		localStorage.setItem(`editor:${edRepo}`, JSON.stringify({ files, active: edActive }));
	} catch {
		localStorage.setItem(`editor:${edRepo}`, JSON.stringify({ files: files.map((f) => ({ path: f.path })), active: edActive }));
	}
}

async function edRestore() {
	if (edRestored || !info.repo) return;
	edRestored = true;
	let saved;
	try {
		saved = JSON.parse(localStorage.getItem(`editor:${info.repo}`) || "null");
	} catch {}
	if (!saved?.files?.length) return;
	for (const s of saved.files) await openFile(s.path, { background: true, unsaved: s.content != null ? s : null });
	if (saved.active && edFiles.has(saved.active)) edActivate(saved.active);
}

// The open files belong to one repo: on a switch, store them and start empty (they come back with the repo).
function edEnsureRepo() {
	if (edRepo === info.repo) return;
	if (edRepo) {
		edPersist();
		for (const f of edFiles.values()) f.model?.dispose();
		edFiles.clear();
		edActive = null;
		edEditor?.setModel(null);
	}
	edRepo = info.repo;
	edRestored = false;
	edRender();
}

// switchTab("editor") calls this.
async function showEditor() {
	edEnsureRepo();
	if (!edRestored) await edRestore();
	edRender();
	if (edFiles.get(edActive)?.model) edEditor?.focus();
}

function edDirtyCount() {
	return [...edFiles.values()].filter(edDirty).length;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
crust.fs.onChanged(() => edCheckDisk());
crust.repos.onChanged(() => setTimeout(() => {
	edEnsureRepo();
	if (activeTab === "editor") showEditor();
}, 0));
window.addEventListener("beforeunload", edPersist);
// ⌘S / ⌥⌘S while the Editor tab is showing but the focus is elsewhere (e.g. on the tab strip).
window.addEventListener("keydown", (e) => {
	if (activeTab !== "editor" || !modOnly(e) || e.key.toLowerCase() !== "s") return;
	if (edEditor?.hasTextFocus()) return; // Monaco's own command handles it
	e.preventDefault();
	e.altKey ? edSaveAll() : edSave(edActive);
});
edRender();
