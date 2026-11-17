// Repo picker: choose the repo at startup and switch later (repo name above the file tree, ⌘O, palette).
"use strict";

let pickerItems = [];
let pickerIndex = 0;
let pickerOpen = false;
let pickerData = null;

function shortPath(p, home) {
	return tildePath(p, home);
}

async function openRepoPicker() {
	if (pickerOpen) return;
	pickerOpen = true;
	crust.browser.hide(true, "picker");
	$("#repo-picker").hidden = false;
	$("#picker-cancel").hidden = !info.repo; // at startup there's nothing to go back to
	$("#picker-filter").value = "";
	$("#picker-list").replaceChildren(el("div", "picker-group", "Looking for repos…"));
	$("#picker-filter").focus();
	pickerData = await crust.repos.list();
	drawPicker();
}

function closeRepoPicker() {
	if (!pickerOpen || !info.repo) return; // stays open until a repo is chosen
	pickerOpen = false;
	$("#repo-picker").hidden = true;
	crust.browser.hide(false, "picker");
}

function drawPicker() {
	if (!pickerData) return;
	const q = $("#picker-filter").value.trim();
	const match = (p) => !q || fuzzy(q, baseName(p)) || fuzzy(q, p);
	const recent = pickerData.recent.filter((r) => match(r.path));
	const found = pickerData.discovered.filter(match);
	pickerItems = [...recent.map((r) => ({ path: r.path, when: r.openedAt })), ...found.map((p) => ({ path: p }))];
	pickerIndex = 0;
	const list = $("#picker-list");
	const rows = [];
	const row = (it, i) => {
		const r = el("div", `picker-item${i === 0 ? " active" : ""}`);
		r.setAttribute("role", "option");
		r.append(el("span", "p-name", baseName(it.path)), el("span", "p-path", shortPath(it.path, pickerData.home)));
		if (it.path === pickerData.current) r.append(el("span", "p-current", "open now"));
		else if (it.when) r.append(el("span", "p-when", timeAgo(it.when)));
		r.onmousemove = () => setPickerActive(i);
		r.onclick = () => chooseRepo(it.path);
		return r;
	};
	let i = 0;
	if (recent.length) rows.push(el("div", "picker-group", "Recent"), ...recent.map(() => row(pickerItems[i], i++)));
	if (found.length) rows.push(el("div", "picker-group", `Git repos on this ${isMac ? "Mac" : "PC"}`), ...found.map(() => row(pickerItems[i], i++)));
	if (!rows.length) rows.push(el("div", "picker-group", q ? "No match. Use Browse… to pick any folder." : "No repos found. Use Browse… to pick a folder."));
	list.replaceChildren(...rows);
}

function setPickerActive(i) {
	const rows = [...document.querySelectorAll(".picker-item")];
	rows[pickerIndex]?.classList.remove("active");
	pickerIndex = Math.max(0, Math.min(rows.length - 1, i));
	rows[pickerIndex]?.classList.add("active");
	rows[pickerIndex]?.scrollIntoView({ block: "nearest" });
}

async function chooseRepo(p) {
	if (!p) return;
	if (p === info.repo) return closeRepoPicker();
	if (anyWorking()) {
		const ok = await showDialog({ method: "confirm", title: "Pi is still working", message: "Switching repos stops the current run. Switch anyway?", yesLabel: "Switch" });
		if (!ok.confirmed) return;
	}
	const res = await crust.repos.open(p);
	if (!res.ok) return toast(res.error || "Couldn't open that folder", "error");
	pickerOpen = false;
	$("#repo-picker").hidden = true;
	crust.browser.hide(false, "picker");
}

// Everything that depends on the repo, refreshed when it changes.
let appliedRepo; // undefined until the first call
function applyRepo(repo) {
	if (repo === appliedRepo) return;
	appliedRepo = repo;
	info.repo = repo;
	if (repo && pickerOpen) {
		pickerOpen = false;
		$("#repo-picker").hidden = true;
		crust.browser.hide(false, "picker");
	}
	const name = repo ? baseName(repo) : "Open a repo…";
	$("#repo-name").textContent = name;
	document.title = repo ? `Pi Crust — ${name}` : "Pi Crust";
	$("#term-cwd").textContent = repo ? tildeGuess(repo) : "";
	// Per-repo tree state.
	expanded.clear();
	for (const p of JSON.parse(localStorage.getItem(`expanded:${repo}`) || "[]")) expanded.add(p);
	selectedPath = null;
	selectedChange = null;
	fileIndex = [];
	fileIndexAt = 0;
	resetChats(); // main restarts Pi with a fresh chat
	welcomeNotice = repo ? `Working in ${tildeGuess(repo)}` : null;
	refreshTree();
	loadChanges();
	resetTerminals();
}

function initRepos() {
	$("#repo-name").addEventListener("click", openRepoPicker);
	$("#picker-filter").addEventListener("input", drawPicker);
	$("#picker-filter").addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown") setPickerActive(pickerIndex + 1);
		else if (e.key === "ArrowUp") setPickerActive(pickerIndex - 1);
		else if (e.key === "Enter") chooseRepo(pickerItems[pickerIndex]?.path);
		else if (e.key === "Escape") closeRepoPicker();
		else return;
		e.preventDefault();
	});
	$("#picker-browse").addEventListener("click", async () => chooseRepo(await crust.repos.browse()));
	$("#picker-cancel").addEventListener("click", closeRepoPicker);
	crust.repos.onChanged(({ repo }) => applyRepo(repo));
	startRepos();
	window.addEventListener(
		"keydown",
		(e) => {
			if (modOnly(e) && !e.altKey && e.key.toLowerCase() === "o" && !dialogOpen) {
				e.preventDefault();
				openRepoPicker();
			}
		},
		true,
	);
}

async function startRepos() {
	const { repo } = await crust.repos.uiReady();
	applyRepo(repo);
	if (!repo) openRepoPicker();
}
