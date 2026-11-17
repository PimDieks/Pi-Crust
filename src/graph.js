// Commit graph in the bottom-left: lanes for every branch, merge lines, ref labels.
"use strict";

const LANE_W = 10;
const ROW_H = 22; // keep in step with .commit height in styles.css
const MAX_LANES = 7; // lanes further right are drawn on the last column, so messages stay readable
const LANE_COLORS = ["#5c94d5", "#ff8036", "#5fbf7f", "#e0b04f", "#c678dd", "#56b6c2", "#ef6b6b", "#98c379", "#e5a0c8", "#a0a8ff"];

let graphLimit = 400;
let graphStamp = "";
let graphSelected = null;
let graphLoading = false;

// Assigns each commit a lane and works out which lines cross its row.
// lanes[j] holds the hash the lane is waiting for (the next commit drawn in that column), or null.
function layoutGraph(commits) {
	const lanes = [];
	const rows = [];
	for (const c of commits) {
		let col = lanes.indexOf(c.hash);
		if (col < 0) {
			col = lanes.indexOf(null);
			if (col < 0) col = lanes.length;
			lanes[col] = c.hash;
		}
		const before = lanes.slice();
		// Other lanes that also waited for this commit (it has several children) end here.
		const merging = [];
		for (let j = 0; j < lanes.length; j++) if (j !== col && lanes[j] === c.hash) {
			merging.push(j);
			lanes[j] = null;
		}
		// The first parent continues this lane; extra parents (a merge) get their own lane.
		lanes[col] = c.parents[0] || null;
		const parentCols = [];
		c.parents.forEach((p, i) => {
			if (i === 0) return parentCols.push(col);
			let k = lanes.indexOf(p);
			if (k < 0) {
				k = lanes.indexOf(null);
				if (k < 0) k = lanes.length;
				lanes[k] = p;
			}
			parentCols.push(k);
		});
		while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
		rows.push({ col, before, after: lanes.slice(), merging, parentCols });
	}
	return rows;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
	const n = document.createElementNS(SVG_NS, tag);
	for (const k in attrs) n.setAttribute(k, attrs[k]);
	return n;
}
const laneX = (j) => 8 + Math.min(j, MAX_LANES) * LANE_W;
const laneColor = (j) => LANE_COLORS[j % LANE_COLORS.length];

function rowSvg(row, width, isMerge, isHead) {
	const svg = svgEl("svg", { width, height: ROW_H, viewBox: `0 0 ${width} ${ROW_H}` });
	const mid = ROW_H / 2;
	const line = (x1, y1, x2, y2, color) => {
		const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
		svg.append(svgEl("path", { d, stroke: color, "stroke-width": 1.6, fill: "none" }));
	};
	// Lanes passing straight through this row.
	row.before.forEach((h, j) => {
		if (h && j !== row.col && !row.merging.includes(j) && row.after[j] === h) line(laneX(j), 0, laneX(j), ROW_H, laneColor(j));
	});
	// Lines coming into the commit from above: its own lane and lanes that end here.
	if (row.before[row.col]) line(laneX(row.col), 0, laneX(row.col), mid, laneColor(row.col));
	for (const j of row.merging) line(laneX(j), 0, laneX(row.col), mid, laneColor(j));
	// Lines to the parents below.
	row.parentCols.forEach((k) => line(laneX(row.col), mid, laneX(k), ROW_H, laneColor(k === row.col ? row.col : k)));
	// Lanes that start in this row for a merge parent continue from here (already drawn by the curve).
	const x = laneX(row.col);
	if (isMerge) svg.append(svgEl("circle", { cx: x, cy: mid, r: 3.2, fill: "var(--panel)", stroke: laneColor(row.col), "stroke-width": 1.8 }));
	else svg.append(svgEl("circle", { cx: x, cy: mid, r: isHead ? 4.5 : 3.6, fill: laneColor(row.col), stroke: isHead ? "var(--text)" : "none", "stroke-width": 1.2 }));
	return svg;
}

function refBadge(ref) {
	let cls = "local";
	let text = ref;
	if (ref.startsWith("HEAD -> ")) {
		text = ref.slice(8);
		cls = "head";
	} else if (ref === "HEAD") cls = "head";
	else if (ref.startsWith("tag: ")) {
		text = ref.slice(5);
		cls = "tag";
	} else if (ref.includes("/")) cls = "remote";
	const b = el("span", `ref ${cls}`, text);
	b.title = ref;
	return b;
}

// "Eems, Pieter van der" -> "Pieter"; "Pim Dieks" -> "Pim".
const firstName = (name) => (name.includes(",") ? name.split(",")[1] : name).trim().split(/\s+/)[0] || name;
const refRank = (r) => (r.startsWith("HEAD") ? 0 : r.startsWith("tag: ") ? 3 : r.includes("/") ? 2 : 1);

function shortAge(ms) {
	const s = (Date.now() - ms) / 1000;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	if (s < 30 * 86400) return `${Math.round(s / 86400)}d`;
	if (s < 365 * 86400) return `${Math.round(s / (30 * 86400))}mo`;
	return `${Math.round(s / (365 * 86400))}y`;
}

async function loadGraph(force) {
	if (!info.repo) {
		$("#graph").replaceChildren();
		return;
	}
	if (graphLoading) return;
	graphLoading = true;
	try {
		const stamp = await crust.git.refsStamp();
		if (!force && stamp === graphStamp) return;
		graphStamp = stamp;
		const { commits, error } = await crust.git.log({ all: $("#graph-scope").value === "all", limit: graphLimit });
		renderGraph(commits, error);
	} finally {
		graphLoading = false;
	}
}

function renderGraph(commits, error) {
	const box = $("#graph");
	if (error || !commits.length) {
		box.replaceChildren(el("div", "graph-more", error ? `Not a git repo or no commits yet (${error.split("\n")[0]})` : "No commits yet."));
		return;
	}
	const rows = layoutGraph(commits);
	const maxLanes = Math.min(MAX_LANES, Math.max(...rows.map((r) => Math.max(r.before.length, r.after.length, r.col + 1))));
	const width = 8 + maxLanes * LANE_W;
	const frag = document.createDocumentFragment();
	commits.forEach((c, i) => {
		const isMerge = c.parents.length > 1;
		const isHead = c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
		const row = el("div", `commit${c.hash === graphSelected ? " selected" : ""}`);
		row.setAttribute("role", "listitem");
		row.dataset.hash = c.hash;
		row.title = `${c.hash.slice(0, 10)} · ${c.author} · ${new Date(c.at).toLocaleString()}\n${c.subject}\n\nClick: show the commit · Double-click: mention it in the chat`;
		const text = el("span", `c-text${isMerge ? " c-merge" : ""}`);
		// HEAD and local branches first; at most two labels, the rest in a "+N" with a tooltip.
		const refs = c.refs.filter(Boolean).sort((a, b) => refRank(a) - refRank(b));
		for (const r of refs.slice(0, 2)) text.append(refBadge(r));
		if (refs.length > 2) {
			const more = el("span", "ref remote", `+${refs.length - 2}`);
			more.title = refs.slice(2).join("\n");
			text.append(more);
		}
		text.append(el("span", "c-subject", c.subject));
		const meta = el("span", "c-meta");
		meta.append(el("span", "c-author", firstName(c.author)), shortAge(c.at));
		row.append(rowSvg(rows[i], width, isMerge, isHead), text, meta);
		frag.append(row);
	});
	if (commits.length >= graphLimit) {
		const more = el("div", "graph-more");
		const btn = el("button", "", `Show ${graphLimit} more`);
		btn.onclick = () => {
			graphLimit += 400;
			loadGraph(true);
		};
		more.append(`Showing the newest ${commits.length} commits. `, btn);
		frag.append(more);
	}
	const top = box.scrollTop;
	box.replaceChildren(frag);
	box.scrollTop = top;
}

async function showCommit(hash) {
	graphSelected = hash;
	diffShowsCommit = true;
	for (const r of document.querySelectorAll(".commit")) r.classList.toggle("selected", r.dataset.hash === hash);
	switchTab("changes");
	selectedChange = null;
	chHide();
	for (const r of document.querySelectorAll(".change.selected")) r.classList.remove("selected");
	const text = await crust.git.show(hash);
	if (graphSelected !== hash) return;
	$("#diff-view").dataset.source = `commit ${hash.slice(0, 10)}`;
	// git show --format=fuller: header lines, a blank line, the indented message, then stat and patch.
	const lines = text.split("\n");
	const msgStart = lines.findIndex((l) => l === "") + 1;
	let msgEnd = msgStart;
	while (msgEnd < lines.length && (lines[msgEnd].startsWith("    ") || lines[msgEnd] === "")) msgEnd++;
	const message = lines.slice(msgStart, msgEnd).map((l) => l.replace(/^ {4}/, "")).join("\n").trim();
	const meta = (key) => (lines.find((l) => l.startsWith(`${key}:`)) || "").replace(/^\w+:\s*/, "");
	const head = el("div", "commit-head");
	head.append(el("h3", "", message), el("div", "muted", `${hash.slice(0, 10)} · ${meta("Author")} · ${meta("AuthorDate")}${meta("Merge") ? ` · merge of ${meta("Merge")}` : ""}`));
	$("#diff-view").replaceChildren(head, ...diffLines(lines.slice(msgEnd).join("\n").replace(/^\n+/, "")));
	$("#diff-view").scrollTop = 0;
}

function initGraph() {
	const box = $("#graph");
	box.addEventListener("click", (e) => {
		const row = e.target.closest(".commit");
		if (row) showCommit(row.dataset.hash);
	});
	box.addEventListener("dblclick", (e) => {
		const row = e.target.closest(".commit");
		if (row) mention(row.dataset.hash.slice(0, 10));
	});
	$("#graph-refresh").addEventListener("click", () => loadGraph(true));
	$("#graph-scope").addEventListener("change", () => {
		localStorage.setItem("graphScope", $("#graph-scope").value);
		loadGraph(true);
	});
	$("#graph-scope").value = localStorage.getItem("graphScope") || "all";

	// Resizable split between the file tree and the graph.
	const pane = $("#graph-pane");
	const saved = Number(localStorage.getItem("graphHeight"));
	if (saved) pane.style.height = `${saved}px`;
	const splitter = $("#graph-splitter");
	splitter.addEventListener("pointerdown", (e) => {
		const startY = e.clientY;
		const startH = pane.getBoundingClientRect().height;
		splitter.classList.add("dragging");
		splitter.setPointerCapture(e.pointerId);
		const move = (ev) => {
			const max = $("#tree-pane").getBoundingClientRect().height - 120;
			pane.style.height = `${Math.max(90, Math.min(max, startH - (ev.clientY - startY)))}px`;
		};
		splitter.addEventListener("pointermove", move);
		splitter.addEventListener(
			"pointerup",
			() => {
				splitter.classList.remove("dragging");
				splitter.removeEventListener("pointermove", move);
				localStorage.setItem("graphHeight", String(Math.round(pane.getBoundingClientRect().height)));
			},
			{ once: true },
		);
	});

	// Redraw when commits or branches change (commits from Pi, the terminal or the git bar).
	// Poll only while the pane is on screen (not hidden window, not collapsed sidebar); the stamp check is cheap but still spawns git.
	const graphVisible = () => !document.hidden && pane.offsetParent !== null;
	setInterval(() => {
		if (graphVisible()) loadGraph(false);
	}, 4000);
	new IntersectionObserver((entries) => {
		if (entries.some((e) => e.isIntersecting) && !document.hidden) loadGraph(false);
	}).observe(pane);
	document.addEventListener("visibilitychange", () => graphVisible() && loadGraph(false));
	window.addEventListener("focus", () => loadGraph(false));
	crust.repos.onChanged(() => {
		graphStamp = "";
		graphSelected = null;
		graphLimit = 400;
		loadGraph(true);
	});
	loadGraph(true);
}
