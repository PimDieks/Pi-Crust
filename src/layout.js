// Panel layout: show or hide the left (files + commits) and right (chat) panes, and dock the terminal at the bottom.
"use strict";

const panelState = JSON.parse(localStorage.getItem("panels") || '{"left":true,"right":true,"bottom":false}');

function savePanels() {
	localStorage.setItem(panelsKey(), JSON.stringify(panelState));
}

// Panel motion: the pane's size animates between 0 and its size while its contents stay at full size
// (clipped, not reflowed), so only the middle pane resizes per frame. The browser view follows through
// the ResizeObserver on its slot. Toggling again mid-way reverses from where it is.
const PANEL_MS = 240;
const PANEL_EASE = "cubic-bezier(0.2, 0, 0, 1)"; // emphasized decelerate
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function animatePanel(el, gutter, axis, open, { anchorEnd = false, animate = true, done } = {}) {
	const prop = axis === "x" ? "width" : "height";
	const running = el._panelAnim;
	// Size right now (mid-animation if one is running), then cancel it.
	const from = el.getBoundingClientRect()[prop];
	const gutterFrom = gutter.getBoundingClientRect()[prop];
	if (running) for (const a of running) a.cancel();
	el._panelAnim = null;

	el.classList.remove("collapsed");
	gutter.classList.remove("collapsed");
	const full = el.getBoundingClientRect()[prop];
	const gutterFull = gutter.getBoundingClientRect()[prop];
	const finish = () => {
		el.classList.remove("panel-animating", "anchor-end");
		el.style.removeProperty("--panel-lock");
		el.classList.toggle("collapsed", !open);
		gutter.classList.toggle("collapsed", !open);
		el._panelAnim = null;
		done?.();
	};
	if (!animate || reducedMotion.matches || !full) return finish();

	el.style.setProperty("--panel-lock", `${full}px`);
	el.classList.add("panel-animating");
	el.classList.toggle("anchor-end", anchorEnd);
	const start = running ? from : open ? 0 : full;
	const gStart = running ? gutterFrom : open ? 0 : gutterFull;
	const end = open ? full : 0;
	const opts = { duration: PANEL_MS, easing: PANEL_EASE };
	const shift = (open ? 1 : -1) * (anchorEnd ? 12 : -12);
	const anims = [
		el.animate({ [prop]: [`${start}px`, `${end}px`] }, opts),
		gutter.animate({ [prop]: [`${gStart}px`, `${open ? gutterFull : 0}px`] }, opts),
		el.animate(
			{ opacity: [running ? getComputedStyle(el).opacity : open ? 0.4 : 1, open ? 1 : 0.4] },
			{ ...opts, duration: PANEL_MS * 0.8 },
		),
	];
	const inner = [...el.children];
	for (const c of inner)
		anims.push(
			c.animate(
				{ transform: open ? [`translate${axis.toUpperCase()}(${shift}px)`, "none"] : ["none", `translate${axis.toUpperCase()}(${-shift}px)`] },
				opts,
			),
		);
	el._panelAnim = anims;
	anims[0].finished.then(finish, () => {});
}

let panelsReady = false;

function setPane(side, open) {
	panelState[side] = open;
	const pane = side === "left" ? $("#tree-pane") : $("#chat-pane");
	const splitter = document.querySelector(side === "left" ? '.splitter[data-left="tree-pane"]' : '.splitter[data-right="chat-pane"]');
	$(`#toggle-${side}`).setAttribute("aria-pressed", String(open));
	savePanels();
	animatePanel(pane, splitter, "x", open, {
		anchorEnd: side === "right",
		animate: panelsReady,
		done: () => {
			if (open && side === "right") $("#input").focus();
			syncBrowserBounds();
			fitTerminal();
		},
	});
}

// The terminal is one xterm instance that moves between the Terminal tab and the bottom panel.
function setBottom(open, animate = true) {
	if (open && viewDef().noBottom) return; // this view has no bottom panel
	panelState.bottom = open;
	const host = $("#terminal-host");
	const panel = $("#bottom-panel");
	const splitter = $("#bottom-splitter");
	$("#toggle-bottom").setAttribute("aria-pressed", String(open));
	$("#term-to-bottom").hidden = open;
	$("#term-close").hidden = !open;
	savePanels();
	// The panel uses .collapsed (not [hidden]) so it can animate; hidden stays false.
	panel.hidden = false;
	splitter.hidden = false;
	if (open) {
		terminalDocked = true;
		panel.append(host);
		if (activeTab === "terminal") switchTab(visibleTabs().find((t) => t !== "terminal"));
	}
	animatePanel(panel, splitter, "y", open, {
		animate: panelsReady && animate,
		done: async () => {
			if (!open) {
				terminalDocked = false;
				document.querySelector('.tab-panel[data-panel="terminal"]').append(host);
			}
			syncBrowserBounds();
			if (open) await showTerminal();
			else fitTerminal();
		},
	});
}

function initLayout() {
	$("#toggle-left").addEventListener("click", () => setPane("left", !panelState.left));
	$("#toggle-right").addEventListener("click", () => setPane("right", !panelState.right));
	$("#toggle-bottom").addEventListener("click", () => setBottom(!panelState.bottom));
	$("#term-to-bottom").addEventListener("click", () => setBottom(true));
	$("#term-close").addEventListener("click", () => setBottom(false));

	// Resizable bottom panel.
	const panel = $("#bottom-panel");
	const saved = Number(localStorage.getItem("bottomHeight"));
	if (saved) panel.style.height = `${saved}px`;
	const splitter = $("#bottom-splitter");
	splitter.addEventListener("pointerdown", (e) => {
		const startY = e.clientY;
		const startH = panel.getBoundingClientRect().height;
		splitter.classList.add("dragging");
		splitter.setPointerCapture(e.pointerId);
		const move = (ev) => {
			const max = $("#middle-pane").getBoundingClientRect().height - 140;
			panel.style.height = `${Math.max(100, Math.min(max, startH - (ev.clientY - startY)))}px`;
			syncBrowserBounds();
		};
		splitter.addEventListener("pointermove", move);
		splitter.addEventListener(
			"pointerup",
			() => {
				splitter.classList.remove("dragging");
				splitter.removeEventListener("pointermove", move);
				localStorage.setItem("bottomHeight", String(Math.round(panel.getBoundingClientRect().height)));
				fitTerminal();
			},
			{ once: true },
		);
	});

	// Shortcuts: ⌘B left, ⌥⌘B right, ⌃` terminal at the bottom (as in VS Code).
	window.addEventListener(
		"keydown",
		(e) => {
			if (dialogOpen) return;
			const k = e.key.toLowerCase();
			let act = null;
			if (modOnly(e) && k === "b") act = () => (e.altKey ? setPane("right", !panelState.right) : setPane("left", !panelState.left));
			else if (e.ctrlKey && !e.metaKey && (e.key === "`" || e.code === "Backquote")) act = () => setBottom(!panelState.bottom);
			if (!act) return;
			e.preventDefault();
			e.stopPropagation();
			act();
		},
		true,
	);

	setPane("left", panelState.left);
	setPane("right", panelState.right);
	setBottom(panelState.bottom);
	panelsReady = true;
}
