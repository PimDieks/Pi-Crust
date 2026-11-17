// Changes tab: an editable Monaco diff (HEAD on the left, the working tree on the right) with a toolbar
// to copy, save and open the file in the Editor tab. Falls back to the plain text diff (changes.js)
// for deleted, binary or very large files, and for commits from the graph.
// A file that's open in the Editor tab shares its model, so edits and unsaved state show up in both.
"use strict";

let chDiff = null; // the Monaco diff editor
let chPath = null; // rel path shown in the diff editor
let chOriginal = null; // HEAD model (read-only)
const chModels = new Map(); // rel -> { model, savedVersion, mtime } for files not open in the Editor tab
let chSideBySide = localStorage.getItem("diffSideBySide") === "1"; // inline by default: the middle pane is narrow
let chToken = 0;

function chSharedFile(rel) {
	const f = edFiles.get(rel);
	return f?.model ? f : null;
}

// The modified side: { model, dirty, save } whether it's shared with the Editor tab or our own.
function chModified(rel = chPath) {
	if (!rel) return null;
	const shared = chSharedFile(rel);
	if (shared) return { model: shared.model, dirty: edDirty(shared), save: () => edSave(rel) };
	const own = chModels.get(rel);
	if (!own) return null;
	return { model: own.model, dirty: own.model.getAlternativeVersionId() !== own.savedVersion, save: () => chSaveOwn(rel) };
}

async function chSaveOwn(rel) {
	const own = chModels.get(rel);
	if (!own) return false;
	const st = await crust.fs.stat(rel);
	if (st.exists && own.mtime && st.mtime !== own.mtime) {
		const ok = await showDialog({ method: "confirm", title: "File changed on disk", message: `${rel} changed on disk after you started editing. Overwrite it with your version?`, yesLabel: "Overwrite", danger: true });
		if (!ok.confirmed) return false;
	}
	const version = own.model.getAlternativeVersionId();
	try {
		const r = await crust.fs.write(rel, own.model.getValue());
		own.mtime = r.mtime;
		own.savedVersion = version;
		chRenderToolbar();
		refreshChangesSoon();
		return true;
	} catch (e) {
		toast(`Couldn't save ${rel}: ${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`, "error");
		return false;
	}
}

function chCreateDiff() {
	if (chDiff) return chDiff;
	const m = edMonaco;
	chDiff = m.editor.createDiffEditor($("#diff-editor-host"), {
		theme: "crust",
		automaticLayout: true,
		fontFamily: edCssVar("--mono") || "SF Mono, Menlo, monospace",
		fontSize: 12,
		lineHeight: 18,
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		renderSideBySide: chSideBySide,
		useInlineViewWhenSpaceIsLimited: false, // the toolbar toggle decides
		originalEditable: false,
		readOnly: false,
		renderWhitespace: "selection",
		bracketPairColorization: { enabled: true },
		hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
		smoothScrolling: true,
		fixedOverflowWidgets: true,
		wordWrap: edWordWrap(),
		wrappingIndent: "same",
	});
	const mod = chDiff.getModifiedEditor();
	for (const ed of [mod, chDiff.getOriginalEditor()]) {
		ed.addAction({ id: "crust.toggleWordWrap", label: "Toggle Word Wrap", keybindings: [m.KeyMod.Alt | m.KeyCode.KeyZ], run: edToggleWordWrap });
	}
	mod.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => chSave());
	mod.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyC, () => chCopy());
	for (const ed of [mod, chDiff.getOriginalEditor()]) {
		ed.addAction({
			id: "crust.diffAddToChat",
			label: "Add Selection to Chat",
			keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyL],
			contextMenuGroupId: "navigation",
			contextMenuOrder: 0,
			run: () => chAddToChat(ed),
		});
		ed.addAction({
			id: "crust.diffCopy",
			label: "Copy Selection or File",
			contextMenuGroupId: "navigation",
			contextMenuOrder: 1,
			run: () => chCopy(ed),
		});
	}
	mod.onDidChangeModelContent(() => {
		chRenderToolbar();
		if (chSharedFile(chPath)) {
			edRenderTabs();
			edPersistSoon();
		}
		chMarkDirtyRows();
	});
	return chDiff;
}

// Shows `c` (an entry from the changes list) in the editable diff. Returns false when the text diff should be used.
async function chShow(c) {
	if (!c || c.label === "DEL") return false;
	if (active?.cwd) return false; // a worktree's files aren't what the editor reads and writes: show the text diff
	const token = ++chToken;
	try {
		await edLoadMonaco();
	} catch {
		return false;
	}
	if (active?.cwd || token !== chToken) return token === chToken ? false : true; // switched to a worktree chat while Monaco loaded
	edEnsureRepo();
	const [orig, cur] = await Promise.all([crust.git.original(changesChat, c.path, c.code), chSharedFile(c.path) ? null : crust.fs.read(c.path).catch((e) => ({ error: String(e) }))]);
	if (token !== chToken) return true; // another file was selected meanwhile
	if (active?.cwd) return false; // the active chat moved to a worktree meanwhile: its files aren't what this editor holds
	if (orig.error || cur?.error) return false;

	chCreateDiff();
	// The modified model: the Editor tab's, or ours (kept while it has unsaved edits).
	const shared = chSharedFile(c.path);
	if (!shared) {
		let own = chModels.get(c.path);
		if (!own) {
			const uri = edMonaco.Uri.from({ scheme: "crust-changes", path: `/${c.path}` });
			edMonaco.editor.getModel(uri)?.dispose();
			const model = edMonaco.editor.createModel(cur.content, undefined, uri);
			own = { model, savedVersion: model.getAlternativeVersionId(), mtime: cur.mtime };
			chModels.set(c.path, own);
		} else if (own.model.getAlternativeVersionId() === own.savedVersion && own.model.getValue() !== cur.content) {
			// Clean and changed on disk (e.g. Pi edited it): follow the disk, as one undoable edit.
			own.model.pushStackElement();
			own.model.pushEditOperations([], [{ range: own.model.getFullModelRange(), text: cur.content }], () => null);
			own.model.pushStackElement();
			own.savedVersion = own.model.getAlternativeVersionId();
			own.mtime = cur.mtime;
		} else if (own.model.getAlternativeVersionId() === own.savedVersion) own.mtime = cur.mtime;
	}
	const modified = chModified(c.path).model;

	const sameFile = chPath === c.path && chDiff.getModel()?.modified === modified;
	if (sameFile && chOriginal) {
		if (chOriginal.getValue() !== orig.content) chOriginal.setValue(orig.content);
	} else {
		const prevOriginal = chOriginal;
		chOriginal = edMonaco.editor.createModel(orig.content, modified.getLanguageId(), edMonaco.Uri.from({ scheme: "crust-head", path: `/${c.path}`, query: String(token) }));
		chDiff.setModel({ original: chOriginal, modified });
		prevOriginal?.dispose();
		// The Editor tab may close (dispose) a shared model while it's shown here.
		modified.onWillDispose(() => {
			if (chDiff.getModel()?.modified !== modified) return;
			chDiff.setModel(null);
			chOriginal?.dispose();
			chOriginal = null;
			chPath = null;
			if (activeTab === "changes") refreshChangesSoon();
		});
		chDisposeClean(c.path);
	}
	chPath = c.path;
	$("#diff-view").hidden = true;
	$("#diff-editor-host").hidden = false;
	chRenderToolbar();
	return true;
}

// Drop our models that have no unsaved edits (other than the one being shown).
function chDisposeClean(keep) {
	for (const [rel, own] of chModels) {
		if (rel === keep || own.model.getAlternativeVersionId() !== own.savedVersion) continue;
		own.model.dispose();
		chModels.delete(rel);
	}
}

// Back to the text view (empty states, deleted files, commits).
function chHide() {
	chToken++;
	$("#diff-editor-host").hidden = true;
	$("#diff-view").hidden = false;
	$("#diff-toolbar").hidden = true;
	if (chDiff && chPath) {
		chDiff.setModel(null);
		chOriginal?.dispose();
		chOriginal = null;
		chPath = null;
		chDisposeClean();
	}
}

function chRenderToolbar() {
	const bar = $("#diff-toolbar");
	bar.hidden = !chPath;
	if (!chPath) return;
	const mod = chModified();
	$("#diff-path").textContent = chPath;
	$("#diff-path").title = chPath;
	$("#diff-dirty").hidden = !mod?.dirty;
	$("#diff-save").disabled = !mod?.dirty;
	$("#diff-layout").textContent = chSideBySide ? "Inline" : "Side by side";
}

// A dot on rows with unsaved edits in the Changes tab.
function chMarkDirtyRows() {
	for (const r of document.querySelectorAll("#changes-list .change")) {
		const rel = r.querySelector(".cpath")?.title;
		r.classList.toggle("dirty", !!chModified(rel)?.dirty);
	}
}

async function chSave() {
	const mod = chModified();
	if (mod?.dirty) await mod.save();
	chRenderToolbar();
	chMarkDirtyRows();
}

// Copies the selection (in whichever side has focus), or else the whole working-tree file.
async function chCopy(ed) {
	if (!chDiff || !chPath) return;
	const mod = chDiff.getModifiedEditor();
	const orig = chDiff.getOriginalEditor();
	ed = ed || (orig.hasTextFocus() ? orig : mod);
	const sel = ed.getSelection();
	const model = ed.getModel();
	const useSel = sel && !sel.isEmpty();
	const text = useSel ? model.getValueInRange(sel) : mod.getModel().getValue();
	try {
		await crust.clipboard.write(text);
		toast(useSel ? "Copied the selection" : `Copied ${chPath.split("/").pop()}`, "info");
	} catch (e) {
		toast(`Couldn't copy: ${e?.message || e}`, "error");
	}
}

function chAddToChat(ed) {
	const model = ed.getModel();
	if (!model) return;
	const sel = ed.getSelection();
	const range = sel.isEmpty() ? model.getFullModelRange() : sel;
	const text = model.getValueInRange(range);
	if (!text.trim()) return;
	const lines = sel.isEmpty() ? "" : range.startLineNumber === range.endLineNumber ? `${range.startLineNumber}` : `${range.startLineNumber}-${range.endLineNumber}`;
	const lang = model.getLanguageId();
	const source = ed === chDiff.getOriginalEditor() ? "HEAD" : "working tree";
	addPicks([`<code-selection path="${chPath}"${lines ? ` lines="${lines}"` : ""} source="${source}">\n\`\`\`${lang === "plaintext" ? "" : lang}\n${text}\n\`\`\`\n</code-selection>`]);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$("#diff-save").addEventListener("click", chSave);
$("#diff-copy").addEventListener("click", () => chCopy());
$("#diff-layout").addEventListener("click", () => {
	chSideBySide = !chSideBySide;
	localStorage.setItem("diffSideBySide", chSideBySide ? "1" : "0");
	chDiff?.updateOptions({ renderSideBySide: chSideBySide });
	chRenderToolbar();
});
$("#diff-open").addEventListener("click", async () => {
	if (!chPath) return;
	const rel = chPath;
	const own = chModels.get(rel);
	const line = chDiff?.getModifiedEditor().getPosition()?.lineNumber;
	// Hand unsaved edits over to the Editor tab, which then owns the file.
	const unsaved = own && own.model.getAlternativeVersionId() !== own.savedVersion ? { content: own.model.getValue(), mtime: own.mtime } : null;
	await openFile(rel, { line, unsaved });
	const shared = chSharedFile(rel);
	if (own && shared) {
		// The Editor tab owns the file now: show its model here and drop ours.
		if (chPath === rel && chOriginal) chDiff.setModel({ original: chOriginal, modified: shared.model });
		own.model.dispose();
		chModels.delete(rel);
	}
});
// ⌘S / ⇧⌘C in the Changes tab when the focus isn't in Monaco.
window.addEventListener("keydown", (e) => {
	if (activeTab !== "changes" || !chPath || !modOnly(e) || e.altKey) return;
	if (chDiff?.getModifiedEditor().hasTextFocus() || chDiff?.getOriginalEditor().hasTextFocus()) return;
	const k = e.key.toLowerCase();
	if (k === "s" && !e.shiftKey) {
		e.preventDefault();
		chSave();
	} else if (k === "c" && e.shiftKey) {
		e.preventDefault();
		chCopy();
	}
});
crust.repos.onChanged(() => {
	chHide();
	for (const own of chModels.values()) own.model.dispose();
	chModels.clear();
});
