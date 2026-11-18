// Design tab, "Stories" view: a gallery of the project's Storybook stories as thumbnails (captured lazily from the running
// Storybook's iframe.html), grouped by title, plus a connection pill (set the Storybook address, re-probed every 5 s while
// not connected). Click opens the story in "work mode": the isolated story (iframe.html) in the Viewer tab, so the picker,
// Tweak, Annotate and the token check see only the component, with a story bar under the address bar (files, siblings,
// Figma, "Work on with Pi"). The chat button adds the thumbnail and a <storybook-story> block to the chat input.
// Detection and file resolving are in storybook-main.js.
"use strict";

(() => {
	const D = window.crustDesign;
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const ASK_ICON = ICON('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>');
	const CODE_ICON = ICON('<path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5"/>');
	const THUMB = { width: 480, height: 320 };
	let ui = null;
	let info = null; // last storybook:detect result
	let visible = false;
	let pollTimer = 0;
	let filter = "";
	let work = null; // { story, base, files } while a story is open in the Viewer tab
	let browserUrl = ""; // the Viewer tab's URL (browser:state)
	let fsTimer = 0;
	const thumbs = new Map(); // `${url}|${id}` -> data URL
	const filesCache = new Map(); // same key -> Promise of storybook:resolve
	const jobs = new Map(); // same key -> Promise
	let observer = null;
	let running = 0;
	const waiting = [];
	let captureFn = null; // replaced in the self-test
	let gen = 0; // bumped whenever the caches are cleared: captures that started before don't write into thumbs
	let figmaOn = false; // toolbar toggle "In Figma": only the stories of the master components of the Figma file the Desktop Bridge plugin runs in
	try {
		figmaOn = localStorage.getItem("crust.stories.figma") === "1";
	} catch {}
	let figma = { state: "idle", file: null, components: [], match: null, error: "" }; // state: idle | loading | ok | error
	let figmaGen = 0;
	let figmaFn = null; // replaced in the self-test
	let pendingNav = ""; // the URL of a navigation started by openStory, until the Viewer tab reports it settled

	function clearCaches() {
		gen++;
		thumbs.clear();
		filesCache.clear();
		jobs.clear();
	}

	const isolatedUrl = (base, story) => `${base}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
	const uiUrl = (base, story) => `${base}/?path=/story/${encodeURIComponent(story.id)}`;
	const shq = shellQuote;

	function slot() {
		return new Promise((resolve) => {
			const go = () => {
				running++;
				resolve(() => {
					running--;
					waiting.shift()?.();
				});
			};
			if (running < 2) go();
			else waiting.push(go);
		});
	}

	async function realCapture(url, story) {
		const r = await crust.snap.url(`${url}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`, { ...THUMB, settleMs: 700, kind: "design" });
		if (!r.ok) throw new Error(r.error || "Capture failed");
		return crust.snap.get(r.entry.id, true);
	}

	function thumbOf(story, base = info?.url) {
		const url = base;
		const key = `${url}|${story.id}`;
		if (thumbs.has(key)) return Promise.resolve(thumbs.get(key));
		if (!jobs.has(key)) {
			const g = gen;
			const p = (async () => {
				const release = captureFn ? () => {} : await slot(); // the self-test's generated thumbnails don't wait for real captures
				try {
					const src = await (captureFn || realCapture)(url, story);
					if (src && g === gen) thumbs.set(key, src);
					return src;
				} finally {
					release();
					if (g === gen) jobs.delete(key);
				}
			})();
			jobs.set(key, p);
		}
		return jobs.get(key);
	}

	// --- detection -------------------------------------------------------------------------------
	let detecting = false;
	let rerun = false; // detect() was called while a probe was running: probe again, the running one is stale
	let detectP = Promise.resolve();
	function detect() {
		if (!ui) return Promise.resolve();
		if (detecting) {
			rerun = true;
			return detectP;
		}
		detecting = true;
		detectP = runDetect();
		return detectP;
	}
	async function runDetect() {
		ui.refresh.setAttribute("aria-busy", "true");
		try {
			for (;;) {
				rerun = false;
				let next;
				try {
					next = await crust.storybook.detect();
				} catch (e) {
					next = { url: "", running: false, stories: [], projects: [] };
					console.error("storybook detect failed", e);
				}
				if (rerun) continue; // stale: discard
				info = next;
				break;
			}
		} finally {
			ui.refresh.removeAttribute("aria-busy");
			detecting = false;
		}
		render();
		renderBar();
		if (figmaOn && info.running && figma.state === "idle") loadFigma(false);
		if (info.running) stopPolling();
		else if (visible && !pollTimer) poll(5000);
	}

	function stopPolling() {
		clearInterval(pollTimer);
		pollTimer = 0;
	}

	// Re-probe while the view is visible and Storybook isn't up: every 5 s, or every 2 s for 90 s after "Start Storybook".
	function poll(ms, max = Infinity) {
		stopPolling();
		let n = 0;
		pollTimer = setInterval(async () => {
			if (!visible || info?.running) return stopPolling();
			if (++n > max) return poll(5000);
			if (detecting) return; // the last probe is still running: skip this tick
			await detect();
		}, ms);
	}
	const pollUntilUp = () => poll(2000, 45);

	// --- Figma components ----------------------------------------------------------------------------
	async function loadFigma(refresh = false) {
		if (!figmaOn || !ui) return;
		const g = ++figmaGen;
		figma = { state: "loading", file: null, components: [], match: null, error: "" };
		render();
		let r;
		try {
			r = await (figmaFn || crust.figmaBridge.components)({ refresh });
		} catch (e) {
			r = { ok: false, error: String(e.message || e) };
		}
		if (g !== figmaGen) return;
		if (!r.ok) {
			figma = { state: "error", file: null, components: [], match: null, error: r.error || "Couldn't read the Figma file" };
			return render();
		}
		const stories = info?.stories || [];
		let match = FigmaMatch.matchStories(stories, r.components);
		const rest = stories.filter((s) => !match.byStory[s.id]);
		if (rest.length && match.unmatched.length) {
			// Stories that didn't match by name: look at their component file and Figma URL.
			const files = {};
			let next = 0;
			await Promise.all(Array.from({ length: 6 }, async () => {
				while (next < rest.length) {
					const s = rest[next++];
					files[s.id] = await filesOf(s);
				}
			}));
			if (g !== figmaGen) return;
			match = FigmaMatch.matchStories(stories, r.components, files);
		}
		figma = { state: "ok", file: r.file, components: r.components, match, error: "" };
		render();
	}

	function setFigmaOn(on) {
		figmaOn = on;
		try {
			localStorage.setItem("crust.stories.figma", on ? "1" : "0");
		} catch {}
		paintSeg();
		if (on) loadFigma(false);
		else {
			figmaGen++;
			render();
		}
	}

	function paintSeg() {
		if (!ui) return;
		ui.segAll.setAttribute("aria-pressed", String(!figmaOn));
		ui.segFigma.setAttribute("aria-pressed", String(figmaOn));
		ui.seg.hidden = !info?.running;
	}

	// Facts about a Figma component without a story, for Pi.
	function figmaBlock(c, file) {
		const line = (k, v) => (v ? `${k}: ${blockText(v)}\n` : "");
		const id = String(c.nodeId || "").replace(":", "-");
		const link = file?.key && id ? `https://www.figma.com/design/${encodeURIComponent(file.key)}/?node-id=${encodeURIComponent(id)}` : "";
		return `<figma-component>\n${line("name", c.setName || c.name)}${line("type", c.type === "componentSet" ? "component set (variants)" : "component")}${line("file", file?.name)}${line("node id", c.nodeId)}${line("link", link)}${line("description", c.description)}</figma-component>`;
	}

	async function askForStory(c) {
		await D.sendToChat([], "", [figmaBlock(c, figma.file)]);
	}

	function renderFigmaNoStory() {
		const list = figma.match.unmatched;
		const det = el("details", "st-nostory");
		det.append(el("summary", "dt-title", `In Figma, no story (${list.length})`));
		const ul = el("ul", "st-nostory-list");
		for (const c of list) {
			const li = el("li", "st-nostory-row");
			const name = el("span", "st-name", c.setName || c.name);
			name.title = c.description || c.setName || c.name;
			const b = el("button", "btn", "Ask Pi to write a story");
			b.type = "button";
			b.title = "Add the component's details to the chat input (nothing is sent)";
			b.onclick = () => askForStory(c);
			li.append(name, b);
			ul.append(li);
		}
		det.append(ul);
		return det;
	}

	// --- connection ------------------------------------------------------------------------------
	function paintPill() {
		const on = !!info?.running;
		let host = "";
		try {
			host = new URL(info.url).host;
		} catch {}
		ui.pill.classList.toggle("on", on);
		ui.pill.textContent = on ? `● Connected · ${host} · ${info.stories.length} stories` : "○ Not connected";
		ui.pill.title = on ? `Storybook at ${info.url}. Click to change the address` : "Click to set the Storybook address";
	}

	function openConnect(show, refocus) {
		ui.form.hidden = !show;
		ui.pill.hidden = show;
		if (show) {
			ui.address.value = info?.custom ? info.url : "";
			ui.address.placeholder = `http://localhost:6006`;
			ui.address.focus();
			ui.address.select();
		} else if (refocus) ui.pill.focus();
	}

	async function connect() {
		const r = await crust.storybook.setUrl(ui.address.value);
		if (!r.ok) return toast(r.error || "Couldn't save the address", "error");
		openConnect(false, true);
		clearCaches();
		await detect();
	}

	async function start(p, pm) {
		const cmd = p.dir ? shellAnd(`cd ${shq(p.dir)}`, `${pm} run ${p.script}`) : `${pm} run ${p.script}`;
		await runInTerminal(cmd);
		toast("Storybook is starting in the Terminal tab. The gallery fills in when it is up.", "info");
		pollUntilUp();
	}

	// --- rendering -------------------------------------------------------------------------------
	function renderEmpty() {
		const box = el("div", "st-empty");
		box.append(el("p", "st-lead", info.projects.length ? `Storybook isn't running at ${info.url}.` : `No Storybook found at ${info.url}.`));
		if (info.projects.length) {
			const row = el("div", "st-start");
			for (const p of info.projects) {
				const b = el("button", "btn", info.projects.length > 1 ? `Start Storybook (${p.name})` : "Start Storybook");
				b.type = "button";
				b.title = `${p.dir ? `cd ${p.dir} && ` : ""}${info.pm} run ${p.script}, in the Terminal tab`;
				b.onclick = () => start(p, info.pm);
				row.append(b);
			}
			box.append(row);
		}
		const how = el("p", "muted");
		how.append("Storybook is expected at ", el("code", "", info.url), ". If it runs on another address, click the pill above and connect to it. ");
		if (info.invalidUrl) how.append("The configured storybookUrl isn't an http(s) address, so the default is used. ");
		if (!info.projects.length) how.append("No ", el("code", "", "storybook"), " script was found in the repo root, apps/, libs/ or packages/.");
		box.append(how);
		ui.body.replaceChildren(box);
	}

	// The gallery shows what the files look like now: Storybook hot-reloads the preview, the thumbnails are re-captured.
	function refreshThumbs() {
		if (!info || (!thumbs.size && !filesCache.size && !jobs.size)) return;
		clearCaches();
		if (!visible || !info.running) return;
		const top = ui.body.scrollTop;
		render();
		ui.body.scrollTop = top;
	}
	crust.fs.onChanged(() => {
		clearTimeout(fsTimer);
		fsTimer = setTimeout(refreshThumbs, 1500);
	});

	function render() {
		if (!info) return;
		observer?.disconnect();
		paintPill();
		ui.filter.hidden = !info.running;
		paintSeg();
		if (!info.running) return renderEmpty();
		const inFigma = figmaOn;
		if (inFigma && figma.state !== "ok") {
			if (figma.state === "error") {
				const box = el("div", "st-empty");
				box.append(el("p", "st-lead", "Couldn't read the Figma components."), el("p", "muted", figma.error), el("p", "muted", "Advanced: this filter needs the Desktop Bridge plugin, see the README."));
				const retry = el("button", "btn", "Try again");
				retry.type = "button";
				retry.onclick = () => loadFigma(true);
				box.append(retry);
				return ui.body.replaceChildren(box);
			}
			return ui.body.replaceChildren(D.empty("Reading the components of the Figma file…"));
		}
		const q = filter.trim().toLowerCase();
		let list = info.stories;
		if (inFigma) list = list.filter((s) => figma.match.byStory[s.id]);
		if (q) list = list.filter((s) => `${s.title} ${s.name}`.toLowerCase().includes(q));
		const frag = document.createDocumentFragment();
		if (inFigma) {
			const m = figma.match;
			const status = el("p", "muted st-figma-status", `Figma: ${figma.file?.name || "(unnamed file)"} · ${m.matched.length + m.unmatched.length} components · ${m.matched.length} with stories`);
			frag.append(status);
		}
		if (!list.length) {
			frag.append(D.empty(inFigma && !q ? "None of the Figma components has a story." : "No stories match."));
			if (inFigma && figma.match.unmatched.length) frag.append(renderFigmaNoStory());
			return ui.body.replaceChildren(frag);
		}
		const groups = new Map();
		for (const s of list) groups.set(s.title, [...(groups.get(s.title) || []), s]);
		observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					observer.unobserve(e.target);
					fill(e.target);
				}
			},
			{ root: ui.body, rootMargin: "240px" },
		);
		for (const [title, stories] of groups) {
			const sec = el("section", "dt-section");
			sec.append(el("h3", "dt-title", `${title} ${stories.length}`));
			const grid = el("div", "st-grid");
			for (const s of stories) grid.append(tile(s));
			sec.append(grid);
			frag.append(sec);
		}
		if (inFigma && figma.match.unmatched.length) frag.append(renderFigmaNoStory());
		ui.body.replaceChildren(frag);
		for (const t of ui.body.querySelectorAll(".st-tile")) observer.observe(t);
	}

	function tile(story) {
		const t = el("div", "st-tile");
		t._story = story;
		const open = el("button", "st-open");
		open.type = "button";
		open.title = `Work on this story in the Viewer tab\n${story.importPath}`;
		open.setAttribute("aria-label", `Work on story ${story.title} / ${story.name}`);
		const thumb = el("span", "st-thumb");
		thumb.append(D.spinner());
		open.append(thumb, el("span", "st-name", story.name));
		const fc = figmaOn && figma.match?.byStory[story.id];
		if (fc) {
			const badge = el("span", "st-badge", fc);
			badge.title = `Figma component: ${fc}`;
			open.append(badge);
		}
		open.onclick = () => openStory(story);
		const actions = el("span", "st-actions");
		const edit = el("button", "icon st-edit");
		edit.type = "button";
		edit.title = "Open the component in the editor";
		edit.setAttribute("aria-label", `Open ${story.title} in the editor`);
		edit.innerHTML = CODE_ICON;
		edit.onclick = async () => {
			const f = await filesOf(story, info?.url);
			const file = f.componentFile || f.storyFile;
			if (file) openFile(file);
			else toast("Couldn't find the component's file", "warning");
		};
		const ask = el("button", "icon st-ask");
		ask.type = "button";
		ask.title = "Add this story to the chat input";
		ask.setAttribute("aria-label", `Add ${story.title} / ${story.name} to the chat`);
		ask.innerHTML = ASK_ICON;
		ask.onclick = () => askPi(story);
		actions.append(edit, ask);
		t.append(open, actions);
		return t;
	}

	async function fill(t) {
		const thumb = t.querySelector(".st-thumb");
		try {
			const src = await thumbOf(t._story);
			if (!src || !t.isConnected) return;
			const img = el("img");
			img.alt = "";
			img.src = src;
			thumb.replaceChildren(img);
		} catch (e) {
			thumb.replaceChildren(el("span", "vp-err", "No preview"));
			thumb.title = String(e.message || e);
		}
	}

	// --- files, chat block, work mode ---------------------------------------------------------------
	function filesOf(story, base = info?.url) {
		const key = `${base}|${story.id}`;
		if (!filesCache.has(key)) filesCache.set(key, crust.storybook.resolve(story).catch(() => ({ storyFile: "", componentFile: "", figmaUrl: "", exportName: "" })));
		return filesCache.get(key);
	}

	const siblingsOf = (story) => (info?.stories || []).filter((s) => s.title === story.title);

	// One line of the block: no line breaks and no angle brackets, so a value can't close the block or open another one.
	const blockText = (v) => String(v).replace(/[\r\n]+/g, " ").replace(/</g, "‹").replace(/>/g, "›").trim();

	// Facts about the story for Pi, no instructions.
	function storyBlock(story, files, base) {
		const line = (k, v) => (v ? `${k}: ${blockText(v)}\n` : "");
		const sib = siblingsOf(story).map((s) => blockText(s.name)).join(", ");
		return `<storybook-story>\n${line("title", story.title)}${line("name", story.name)}${line("id", story.id)}${line("isolated url", isolatedUrl(base, story))}${line("storybook url", uiUrl(base, story))}${line("stories file", files.storyFile)}${line("component file", files.componentFile)}${line("figma url", files.figmaUrl)}${line("sibling stories", sib)}</storybook-story>`;
	}

	async function askPi(story, base = info?.url) {
		if (!base) return;
		let src = null;
		try {
			src = await thumbOf(story, base);
		} catch {}
		const files = await filesOf(story, base);
		const ext = (/^data:image\/([a-z0-9+.-]+)/i.exec(src || "")?.[1] || "png").toLowerCase().replace("jpeg", "jpg").replace(/\+.*/, "");
		const name = String(story.id).replace(/[^\w.-]+/g, "-").slice(0, 80) || "story";
		await D.sendToChat(src ? [D.dataUrlToFile(src, `${name}.${ext}`)] : [], "", [storyBlock(story, files, base)]);
	}

	async function openStory(story) {
		const base = info.url;
		work = { story, base, files: { storyFile: "", componentFile: "", figmaUrl: "", exportName: "" } };
		browserUrl = isolatedUrl(base, story);
		pendingNav = browserUrl;
		renderBar();
		crust.browser.navigate(browserUrl);
		switchTab("browser");
		const mine = work;
		const files = await filesOf(story, base);
		if (work === mine) {
			mine.files = files;
			renderBar();
		}
	}

	function leaveWork() {
		work = null;
		renderBar();
		switchTab("design");
		D.select("stories");
	}

	// The story bar under the browser's address bar: only while the Viewer tab shows the open story's isolated page.
	function isWorkPage() {
		if (!work) return false;
		try {
			const u = new URL(browserUrl);
			return u.origin === new URL(work.base).origin && u.pathname.endsWith("/iframe.html") && u.searchParams.get("id") === work.story.id;
		} catch {
			return false;
		}
	}

	function renderBar() {
		const bar = $("#story-bar");
		if (!isWorkPage()) {
			bar.hidden = true;
			bar.replaceChildren();
			return;
		}
		const { story, base, files } = work;
		const btn = (label, title, onClick, disabled) => {
			const b = el("button", "btn", label);
			b.type = "button";
			b.title = title;
			b.disabled = !!disabled;
			b.onclick = onClick;
			return b;
		};
		const path = el("span", "sb-path", `${story.title} / ${story.name}`);
		path.title = story.importPath;
		const kids = [path];
		const sibs = siblingsOf(story);
		if (sibs.length > 1) {
			const sel = el("select", "sb-sibs");
			sel.setAttribute("aria-label", "Switch story");
			for (const s of sibs) {
				const o = el("option", "", s.name);
				o.value = s.id;
				o.selected = s.id === story.id;
				sel.append(o);
			}
			sel.onchange = () => openStory(sibs.find((s) => s.id === sel.value));
			kids.push(sel);
		}
		kids.push(el("span", "spacer"));
		kids.push(btn("Component", files.componentFile || "The component's file wasn't found", () => openFile(files.componentFile), !files.componentFile));
		kids.push(btn("Stories file", files.storyFile || "The stories file wasn't found", () => openFile(files.storyFile), !files.storyFile));
		if (/^https:\/\//i.test(files.figmaUrl)) kids.push(btn("Figma", files.figmaUrl, () => window.open(files.figmaUrl, "_blank", "noopener")));
		kids.push(btn("Storybook UI", "Open the story in Storybook's own UI", () => crust.browser.navigate(uiUrl(base, story))));
		const pi = btn("Work on with Pi", "Add the story's thumbnail and details to the chat input", () => askPi(story, base));
		pi.classList.add("primary");
		kids.push(pi);
		const x = el("button", "icon sb-close", "×");
		x.type = "button";
		x.title = "Back to the stories";
		x.setAttribute("aria-label", "Leave the story");
		x.onclick = leaveWork;
		kids.push(x);
		bar.replaceChildren(...kids);
		bar.hidden = false;
	}

	crust.browser.onState((s) => {
		if (pendingNav) {
			if (s.loading && s.url !== pendingNav) return; // the old page, still loading: keep the story bar
			if (!s.loading) pendingNav = "";
		}
		browserUrl = s.url || "";
		renderBar();
	});

	function mount(host) {
		const bar = el("div", "dv-toolbar");
		const filterInput = el("input", "dv-url");
		filterInput.placeholder = "Filter stories…";
		filterInput.spellcheck = false;
		filterInput.setAttribute("aria-label", "Filter stories");
		filterInput.hidden = true;
		filterInput.oninput = () => {
			filter = filterInput.value;
			render();
		};
		const pill = el("button", "st-pill", "○ Not connected");
		pill.type = "button";
		pill.onclick = () => openConnect(true);
		const form = el("form", "dv-url-form st-connect");
		form.hidden = true;
		const address = el("input", "dv-url");
		address.spellcheck = false;
		address.setAttribute("aria-label", "Storybook address");
		address.title = "Storybook address; empty = http://localhost:6006";
		address.onkeydown = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				openConnect(false, true);
			}
		};
		const go = el("button", "btn", "Connect");
		go.type = "submit";
		form.append(address, go);
		form.onsubmit = (e) => {
			e.preventDefault();
			connect();
		};
		const refresh = el("button", "icon");
		refresh.type = "button";
		refresh.title = "Look for Storybook again (and re-read the Figma components)";
		refresh.setAttribute("aria-label", "Refresh");
		refresh.innerHTML = ICON('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>');
		refresh.onclick = async () => {
			clearCaches();
			await detect();
			if (figmaOn) loadFigma(true);
		};
		const seg = el("div", "seg");
		seg.setAttribute("role", "group");
		seg.setAttribute("aria-label", "Figma components");
		seg.hidden = true;
		const segAll = el("button", "seg-btn", "All");
		const segFigma = el("button", "seg-btn", "In Figma");
		for (const b of [segAll, segFigma]) b.type = "button";
		segAll.title = "All stories";
		segFigma.title = "Only the stories of the master components of the Figma file the Desktop Bridge plugin runs in (advanced: needs that plugin, see the README)";
		segAll.onclick = () => figmaOn && setFigmaOn(false);
		segFigma.onclick = () => !figmaOn && setFigmaOn(true);
		seg.append(segAll, segFigma);
		bar.append(pill, form, filterInput, el("span", "spacer"), seg, refresh);
		const body = el("div", "st-body dv-stage");
		host.append(bar, body);
		ui = { filter: filterInput, pill, form, address, refresh, body, seg, segAll, segFigma };
		body.append(D.empty("Looking for Storybook…"));
	}

	registerDesignView({
		id: "stories",
		label: "Stories",
		mount,
		show: () => {
			visible = true;
			detect();
		},
		hide: () => {
			visible = false;
			openConnect(false);
			stopPolling();
		},
	});

	D.stories = {
		detect,
		info: () => info,
		focusFilter: () => {
			if (ui && !ui.filter.hidden) ui.filter.focus();
			else if (ui) openConnect(true);
		},
	};

	selftestSteps.push(async ({ snap, wait }) => {
		switchTab("design");
		D.select("stories");
		await wait(1500);
		const st = info;
		console.error(`SELFTEST stories detect: running=${st?.running} url=${st?.url} projects=${st?.projects.length} -> ${st && (st.running || document.querySelector(".st-empty")) ? "OK" : "MISMATCH"}`);
		await snap("stories-empty");
		// A gallery with generated thumbnails (no Storybook needed).
		const mk = (title, name) => ({ id: `${title}--${name}`.toLowerCase().replace(/\W+/g, "-"), title, name, importPath: `./src/${title}.stories.tsx` });
		info = { url: "http://localhost:6006", running: true, projects: [], stories: [mk("Button", "Primary"), mk("Button", "Secondary"), mk("Button", "Disabled"), mk("Card", "Default"), mk("Card", "With image"), mk("Input", "Default")] };
		captureFn = async (_u, story) => {
			const c = document.createElement("canvas");
			c.width = THUMB.width;
			c.height = THUMB.height;
			const g = c.getContext("2d");
			g.fillStyle = D.tokenColor("--panel-3");
			g.fillRect(0, 0, c.width, c.height);
			g.fillStyle = D.tokenColor("--accent");
			g.beginPath();
			g.roundRect(150, 120, 180, 80, 12);
			g.fill();
			g.fillStyle = D.tokenColor("--text-on-accent");
			g.font = "600 28px sans-serif";
			g.textAlign = "center";
			g.fillText(story.name.slice(0, 10), 240, 170);
			return c.toDataURL("image/png");
		};
		render();
		await wait(1200);
		const loaded = document.querySelectorAll(".st-thumb img").length;
		console.error(`SELFTEST stories gallery: ${document.querySelectorAll(".st-tile").length} tiles, ${loaded} thumbnails -> ${loaded === 6 ? "OK" : "MISMATCH"}`);
		await snap("stories");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`stories-${currentTheme()}`);
		setTheme(was);
		await wait(300);
		const before = active?.picks.length || 0;
		const input = $("#input");
		const prevText = input.value;
		document.querySelector(".st-ask")?.click();
		await wait(800);
		const pickBlock = active?.picks.find((x) => typeof x === "string" && x.startsWith("<storybook-story>"));
		console.error(`SELFTEST stories ask: picks ${before} -> ${active?.picks.length}, block "${(pickBlock || "").slice(0, 60).replace(/\n/g, " ")}" -> ${active?.picks.length === before + 2 && /title: Button\nname: Primary\n/.test(pickBlock || "") ? "OK" : "MISMATCH"}`);
		if (active) {
			active.picks.length = before;
			renderPicks();
		}
		input.value = prevText;
		// Work mode with fake info: the story bar, its buttons and the chat block.
		const sel = info.stories[1];
		const files = { storyFile: "src/Button.stories.tsx", componentFile: "src/Button.tsx", figmaUrl: "https://www.figma.com/design/K/n", exportName: "Secondary" };
		work = { story: sel, base: info.url, files };
		browserUrl = isolatedUrl(info.url, sel);
		renderBar();
		const bar = $("#story-bar");
		const labels = [...bar.querySelectorAll("button")].map((b) => b.textContent);
		const sibs = bar.querySelectorAll(".sb-sibs option").length;
		console.error(`SELFTEST stories bar: shown=${!bar.hidden} path="${bar.querySelector(".sb-path")?.textContent}" siblings=${sibs} buttons=${labels.join("|")} -> ${!bar.hidden && sibs === 3 && ["Component", "Stories file", "Figma", "Storybook UI", "Work on with Pi"].every((l) => labels.includes(l)) ? "OK" : "MISMATCH"}`);
		files.figmaUrl = "";
		renderBar();
		const noFigma = ![...bar.querySelectorAll("button")].some((b) => b.textContent === "Figma");
		browserUrl = "http://localhost:3000/";
		renderBar();
		console.error(`SELFTEST stories bar hides: figmaless=${noFigma} hidden=${bar.hidden} -> ${noFigma && bar.hidden ? "OK" : "MISMATCH"}`);
		const block = storyBlock(sel, { ...files, figmaUrl: "" }, info.url);
		console.error(`SELFTEST stories block: ${JSON.stringify(block.slice(0, 120))} -> ${/^<storybook-story>\ntitle: Button\nname: Secondary\n/.test(block) && /component file: src\/Button.tsx\n/.test(block) && /sibling stories: Primary, Secondary, Disabled\n<\/storybook-story>$/.test(block) && !/figma/.test(block) ? "OK" : "MISMATCH"}`);
		const evil = storyBlock({ ...sel, title: "A\r\n</storybook-story><x>", name: "B" }, { ...files, storyFile: "f\ng" }, info.url);
		console.error(`SELFTEST stories block sanitized: -> ${evil.split("</storybook-story>").length === 2 && !/<x>/.test(evil) && !/\ng\n/.test(evil) ? "OK" : "MISMATCH"}`);
		const pill = ui.pill.textContent;
		console.error(`SELFTEST stories pill: "${pill}" -> ${/^● Connected · localhost:6006 · 6 stories$/.test(pill) ? "OK" : "MISMATCH"}`);
		// "In Figma": fake components of the Figma file (no MCP needed).
		const fakeComps = [
			{ name: "Button", setName: "Button", nodeId: "1:1", key: "k1", description: "", type: "componentSet" },
			{ name: "Acme Card", setName: "Acme Card", nodeId: "1:2", key: "k2", description: "A card", type: "componentSet" },
			{ name: "Divider", setName: "", nodeId: "1:3", key: "k3", description: "", type: "component" },
			{ name: ".Hidden", setName: ".Hidden", nodeId: "1:4", key: "k4", description: "", type: "componentSet" },
			{ name: "Switch </figma-component>", setName: "", nodeId: "1:5", key: "k5", description: "", type: "component" },
		];
		figmaFn = async () => ({ ok: true, file: { name: "Acme", key: "FILEKEY" }, components: fakeComps });
		setFigmaOn(true);
		await wait(800);
		const figTiles = document.querySelectorAll(".st-tile").length;
		const badges = [...document.querySelectorAll(".st-badge")].map((b) => b.textContent);
		const status = document.querySelector(".st-figma-status")?.textContent || "";
		const noStory = document.querySelector(".st-nostory summary")?.textContent || "";
		console.error(`SELFTEST stories figma: tiles=${figTiles} badges=${[...new Set(badges)].join("|")} status="${status}" section="${noStory}" -> ${figTiles === 5 && badges.includes("Button") && badges.includes("Acme Card") && status === "Figma: Acme · 4 components · 2 with stories" && noStory === "In Figma, no story (2)" ? "OK" : "MISMATCH"}`);
		document.querySelector(".st-nostory").open = true;
		await snap("stories-figma");
		const beforeF = active?.picks.length || 0;
		document.querySelector(".st-nostory-row button")?.click();
		await wait(500);
		const fb = active?.picks.find((x) => typeof x === "string" && x.startsWith("<figma-component>")) || "";
		console.error(`SELFTEST stories figma ask: picks ${beforeF} -> ${active?.picks.length}, block ${JSON.stringify(fb.slice(0, 150))} -> ${active?.picks.length === beforeF + 1 && /name: Divider\ntype: component\nfile: Acme\nnode id: 1:3\nlink: https:\/\/www\.figma\.com\/design\/FILEKEY\/\?node-id=1-3\n<\/figma-component>$/.test(fb) ? "OK" : "MISMATCH"}`);
		const evilF = figmaBlock(fakeComps[4], figma.file);
		console.error(`SELFTEST stories figma block sanitized: -> ${evilF.split("</figma-component>").length === 2 && /name: Switch ‹\/figma-component›/.test(evilF) ? "OK" : "MISMATCH"}`);
		if (active) {
			active.picks.length = beforeF;
			renderPicks();
		}
		figmaFn = async () => ({ ok: false, error: "The Figma Desktop Bridge plugin isn't connected." });
		await loadFigma(true);
		const errTxt = document.querySelector(".st-empty")?.textContent || "";
		console.error(`SELFTEST stories figma error: "${errTxt.slice(0, 80)}" -> ${/Couldn't read the Figma components\./.test(errTxt) && /plugin isn't connected/.test(errTxt) ? "OK" : "MISMATCH"}`);
		setFigmaOn(false);
		await wait(300);
		console.error(`SELFTEST stories figma off: tiles=${document.querySelectorAll(".st-tile").length} -> ${document.querySelectorAll(".st-tile").length === 6 ? "OK" : "MISMATCH"}`);
		figmaFn = null;
		figma = { state: "idle", file: null, components: [], match: null, error: "" };
		work = null;
		captureFn = null;
		info = null;
		clearCaches();
		visible = false;
	});
})();
