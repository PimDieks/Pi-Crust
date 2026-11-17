// Remote access: the phone button in the chat header (always there: its menu shares the active chat and has the on/off
// switch), the settings panel (from that menu, the palette or /remote), the palette actions and the tab badges.
// The server lives in main (remote-main.js); this only shows its status and sends commands. DOM APIs only, no innerHTML.
"use strict";

(() => {
	const indicator = $("#remote-indicator");
	let status = null;
	// Phones drop their event stream whenever they lock or go to the background and reconnect when they come back, so a
	// raw connected/disconnected flip would toast on every unlock. A device is "announced" once on connect; a drop only
	// counts (and toasts) when it stays away for DROP_GRACE_MS, a reconnect within that time is silent.
	const DROP_GRACE_MS = 60_000;
	const announced = new Map(); // device id -> name, devices we told the user are connected
	const dropTimers = new Map(); // device id -> timer for a device that went away but may come back
	let render = null; // re-fills the open panel, or null when it is closed
	let shared = new Set(); // ids of the open chats shared with the phone, from the last status
	const activeChat = () => (typeof active !== "undefined" && active) || null;
	const isActiveShared = () => !!activeChat() && shared.has(activeChat().id);

	const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
	const button = (label, onClick, cls = "btn secondary") => {
		const b = el("button", cls, label);
		b.type = "button";
		b.onclick = onClick;
		return b;
	};
	const copyButton = (text) =>
		button("Copy", async (e) => {
			const b = e.currentTarget;
			try {
				await crust.clipboard.write(text);
				b.textContent = "Copied";
				setTimeout(() => (b.textContent = "Copy"), 1200);
			} catch (err) {
				toast(`Couldn't copy: ${err.message}`, "error");
			}
		});
	const ago = (t) => {
		if (!t) return "never";
		const s = Math.max(0, Math.round((Date.now() - t) / 1000));
		if (s < 60) return "just now";
		if (s < 3600) return `${Math.round(s / 60)} min ago`;
		if (s < 86400) return `${Math.round(s / 3600)} h ago`;
		return `${Math.round(s / 86400)} d ago`;
	};
	// Main returns { error } for refusals; show it instead of failing silently.
	const call = async (fn, ...args) => {
		try {
			const r = await fn(...args);
			if (r?.error) toast(r.error, "error");
			return r;
		} catch (e) {
			toast(e.message || String(e), "error");
		}
	};

	// --- Indicator --------------------------------------------------------------------------
	function applyStatus(s, quiet) {
		status = s;
		const before = [...shared].sort().join();
		shared = new Set(s.shared || []);
		const sharedChanged = before !== [...shared].sort().join();
		trackPresence(s, quiet);
		indicator.hidden = !!s.disabled; // selftest: no remote at all
		indicator.querySelector(".ri-count").textContent = s.enabled && s.clients ? s.clients : "";
		indicator.classList.toggle("off", !s.enabled);
		indicator.classList.toggle("connected", !!s.enabled && s.clients > 0);
		indicator.classList.toggle("error", !!s.enabled && !!s.error);
		refreshIndicator();
		render?.();
		fillMenu?.();
		if (sharedChanged) renderTabs(); // badges on the tabs
	}
	function trackPresence(s, quiet) {
		const devices = s.enabled ? s.devices || [] : [];
		const now = new Map(devices.filter((d) => d.connected).map((d) => [d.id, d.name]));
		for (const [id, name] of now) {
			clearTimeout(dropTimers.get(id));
			dropTimers.delete(id);
			if (announced.has(id)) continue;
			announced.set(id, name);
			if (!quiet) toast(`📱 ${name} connected`);
		}
		const known = new Set(devices.map((d) => d.id));
		for (const [id, name] of announced) {
			if (now.has(id) || dropTimers.has(id)) continue;
			// Unpaired or remote switched off: gone for good, no need to wait.
			if (!known.has(id)) {
				announced.delete(id);
				continue;
			}
			dropTimers.set(
				id,
				setTimeout(() => {
					dropTimers.delete(id);
					announced.delete(id);
					toast(`📱 ${name} disconnected`);
				}, DROP_GRACE_MS),
			);
		}
	}
	function refreshIndicator() {
		if (!status) return;
		const here = isActiveShared();
		indicator.classList.toggle("shared", here);
		indicator.title = `Remote access: ${statusLine(status)}. ${here ? "This chat is shared with your phone" : "This chat is not shared with your phone"}`;
	}
	// Called by the renderer when the active chat changes or the tabs are redrawn.
	function onActiveChat() {
		refreshIndicator();
		fillMenu?.();
	}
	// The small phone icon on a tab: same drawing as the header button, DOM APIs only.
	function tabBadge(c) {
		if (!c || !shared.has(c.id)) return null;
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "10", height: "10", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
		const rect = document.createElementNS(ns, "rect");
		for (const [k, v] of Object.entries({ x: "4.5", y: "1.5", width: "7", height: "13", rx: "1.5" })) rect.setAttribute(k, v);
		const line = document.createElementNS(ns, "path");
		line.setAttribute("d", "M7 12.5h2");
		svg.append(rect, line);
		const b = el("span", "ct-remote");
		b.title = "Shared with your phone";
		b.append(svg);
		return b;
	}
	// One short line for the button title and the menu.
	function statusLine(s) {
		if (!s?.enabled) return "off";
		if (s.error) return s.error;
		if (!s.running) return "starting…";
		const t = s.tailscale;
		if (s.mode === "tailscale" && t && !t.serving) return "on, Tailscale still needs setting up";
		return `on, ${plural(s.clients || 0, "phone")} connected`;
	}

	// --- The button's menu: this chat, master switch, status, pair, settings -------------------
	let menu = null;
	let fillMenu = null;
	function closeMenu() {
		if (!menu) return;
		menu.remove();
		menu = fillMenu = null;
		indicator.setAttribute("aria-expanded", "false");
		removeEventListener("pointerdown", onOutside, true);
		removeEventListener("keydown", onKey, true);
	}
	const onOutside = (e) => {
		if (menu && !menu.contains(e.target) && !indicator.contains(e.target)) closeMenu();
	};
	const onKey = (e) => {
		if (!menu) return;
		const rows = [...menu.querySelectorAll(".pal-item")];
		const i = rows.indexOf(document.activeElement);
		if (e.key === "Tab") closeMenu();
		else if (e.key === "Escape") {
			e.stopPropagation();
			closeMenu();
			indicator.focus();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
		}
	};
	// On with no phone paired yet: open the full panel, which walks through setup and pairing.
	async function setEnabled(on) {
		const r = await call(crust.remote.setEnabled, on);
		if (on && !r?.error && !status?.devices?.length) {
			closeMenu();
			open();
		}
	}
	// Share or stop sharing the active chat. Sharing with no phone paired yet goes on to the panel, which guides pairing.
	async function shareActive(on) {
		const c = activeChat();
		if (!c) return;
		const r = await call(crust.remote.share, c.id, on);
		if (r && !r.error) applyStatus(r, true);
		if (on && r && !r.error && !r.devices?.length) {
			closeMenu();
			open({ pair: true });
		}
	}
	function openMenu() {
		closeMenu();
		menu = el("div", "slash-menu wt-menu remote-menu");
		menu.setAttribute("role", "menu");
		const item = (label, desc, run, role = "menuitem") => {
			const row = el("button", "pal-item");
			row.type = "button";
			row.setAttribute("role", role);
			row.append(el("span", "label", label), desc);
			row.onclick = run;
			return row;
		};
		const switchItem = (label, on, run) => {
			const knob = el("span", on ? "rm-switch on" : "rm-switch");
			knob.setAttribute("aria-hidden", "true");
			const row = item(label, knob, run, "menuitemcheckbox");
			row.setAttribute("aria-checked", String(on));
			return row;
		};
		fillMenu = () => {
			const focused = menu.contains(document.activeElement) ? [...menu.querySelectorAll(".pal-item")].indexOf(document.activeElement) : 0;
			const on = !!status?.enabled;
			const c = activeChat();
			const here = isActiveShared();
			const chatRow = switchItem(c ? "Use this chat from your phone" : "No chat open", here, () => shareActive(!here));
			if (!c) {
				chatRow.setAttribute("aria-disabled", "true");
				chatRow.onclick = null;
			}
			const toggle = switchItem("Remote access", on, () => setEnabled(!on));
			const line = el("div", status?.enabled && status?.error ? "rm-status rp-error" : "rm-status", status ? `${statusLine(status)[0].toUpperCase()}${statusLine(status).slice(1)}` : "Loading…");
			const rows = [chatRow, toggle, line];
			if (status?.running && !status?.error)
				rows.push(
					item("Pair a phone…", el("span", "desc", "QR code"), () => {
						closeMenu();
						open({ pair: true });
					}),
				);
			rows.push(
				item("Remote settings…", el("span", "desc", "/remote"), () => {
					closeMenu();
					open();
				}),
			);
			menu.replaceChildren(...rows);
			const items = menu.querySelectorAll(".pal-item");
			(items[Math.min(Math.max(focused, 0), items.length - 1)] || items[0])?.focus();
		};
		document.body.append(menu);
		fillMenu();
		const r = indicator.getBoundingClientRect();
		menu.style.top = `${r.bottom + 4}px`;
		menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
		indicator.setAttribute("aria-expanded", "true");
		addEventListener("pointerdown", onOutside, true);
		addEventListener("keydown", onKey, true);
		crust.remote.status().then((s) => s && applyStatus(s, true)).catch(() => {});
	}
	indicator.onclick = () => (menu ? closeMenu() : openMenu());
	crust.remote.onStatus((s) => s && applyStatus(s));
	// The first status after load: nothing counts as newly connected.
	crust.remote.status().then((s) => s && applyStatus(s, true)).catch(() => {});

	// --- Panel ------------------------------------------------------------------------------
	function open({ pair = false } = {}) {
		let pairing = null; // { code, url, expiresAt, qr } while a code is shown
		let unpairing = null; // device id waiting for its second click
		let tick = null;
		const panel = el("div", "remote-panel");

		const section = (title) => {
			const s = el("div", "rp-section");
			if (title) s.append(el("h3", "", title));
			panel.append(s);
			return s;
		};
		const row = (...kids) => {
			const r = el("div", "rp-row");
			r.append(...kids);
			return r;
		};
		const configure = (s, patch) => call(crust.remote.configure, { mode: s.mode, port: s.port, httpsPort: s.httpsPort, lanAddress: s.lan?.preferred || null, ...patch });

		const newPairing = async () => {
			const r = await call(crust.remote.newPairing);
			pairing = r && !r.error ? r : null;
			fill();
		};

		function fillPairing(sec) {
			const qr = el("img", "remote-qr");
			qr.src = pairing.qr;
			qr.alt = "QR code to pair a phone";
			const code = String(pairing.code).replace(/^(.{4})(.+)$/, "$1-$2");
			const left = el("span", "rp-muted");
			const update = () => {
				const n = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
				left.textContent = `Expires in ${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
			};
			update();
			clearInterval(tick);
			tick = setInterval(() => {
				if (!pairing || pairing.expiresAt <= Date.now()) {
					pairing = null;
					clearInterval(tick);
					return fill();
				}
				update();
			}, 1000);
			sec.append(qr, el("div", "rp-code", code), row(left, button("New code", newPairing)), row(el("code", "rp-url", pairing.url), copyButton(pairing.url)));
			sec.append(el("p", "rp-muted", "Scan the code, or open the address on your phone and type the code. On iPhone, add the page to your Home Screen first and pair inside the app (it keeps its own login)."));
		}

		function fill() {
			const s = status;
			panel.replaceChildren();
			if (!s) return panel.append(el("p", "rp-muted", "Loading…"));
			if (s.disabled) return panel.append(el("p", "rp-muted", "Remote access is not available here."));
			const tailscale = s.mode === "tailscale";

			// On / off
			let sec = section();
			const sw = el("input");
			sw.type = "checkbox";
			sw.checked = !!s.enabled;
			sw.onchange = async () => {
				sw.disabled = true;
				pairing = null;
				await call(crust.remote.setEnabled, sw.checked);
			};
			const lbl = el("label", "rp-switch");
			lbl.append(sw, el("span", "", s.enabled ? "On" : "Off"));
			sec.append(row(lbl, el("span", "rp-muted", "Chat with Pi from your phone. Nothing is exposed to the internet.")));

			// Shared chats
			sec = section("Shared chats");
			const sharedOpen = [...shared].filter((id) => chats.has(id));
			for (const id of sharedOpen) {
				const c = chats.get(id);
				sec.append(row(el("span", "rp-name", c ? chatLabel(c) : id), button("Stop sharing", () => call(crust.remote.share, id, false).then((r) => r && !r.error && applyStatus(r, true)))));
			}
			if (!sharedOpen.length) sec.append(el("p", "rp-muted", "Share a chat from the phone button in the chat header."));

			// Mode and port
			sec = section("Connection");
			const modes = el("div", "rp-modes");
			for (const [value, label] of [["tailscale", "Tailscale (recommended)"], ["lan", "Wi-Fi (LAN, http)"]]) {
				const radio = el("input");
				radio.type = "radio";
				radio.name = "remote-mode";
				radio.checked = s.mode === value;
				radio.onchange = () => configure(s, { mode: value });
				const l = el("label", "rp-radio");
				l.append(radio, el("span", "", label));
				modes.append(l);
			}
			const port = el("input", "rp-port");
			port.type = "number";
			port.min = "1024";
			port.max = "65535";
			port.value = s.port;
			port.onchange = () => configure(s, { port: Number(port.value) });
			const portLabel = el("label", "rp-radio");
			portLabel.append(el("span", "", "Port"), port);
			sec.append(modes, portLabel);
			if (!tailscale) {
				sec.append(el("p", "rp-warn", s.lan?.warning || "Plain HTTP on your Wi-Fi: no notifications, traffic is not encrypted"));
				// Several adapters can look like a LAN (VPNs, VMs): let the user say which one the phone is on.
				const cands = s.lan?.candidates || [];
				if (cands.length) {
					const sel = el("select", "rp-iface");
					for (const c of cands) {
						const o = el("option", "", `${c.name} \u2014 ${c.address}`);
						o.value = c.address;
						sel.append(o);
					}
					sel.value = s.lan?.address || cands[0].address;
					sel.onchange = () => configure(s, { lanAddress: sel.value });
					const l = el("label", "rp-radio");
					l.append(el("span", "", "Network"), sel);
					sec.append(l);
				} else sec.append(el("p", "rp-error", "No Wi-Fi or Ethernet address found. Connect to a network or use Tailscale."));
				if (s.lan?.address) sec.append(el("p", "rp-muted", `Listening on ${s.lan.interface ? `${s.lan.interface} ` : ""}${s.lan.address}`));
			}

			// Notifications (Tailscale mode only: Wi-Fi mode has no push)
			if (tailscale) {
				const pv = el("input");
				pv.type = "checkbox";
				pv.checked = s.pushPreview !== false;
				pv.onchange = () => configure(s, { pushPreview: pv.checked });
				const pl = el("label", "rp-radio");
				pl.append(pv, el("span", "", "Show message text in notifications"));
				sec.append(pl);
			}

			// Status line and URL
			if (s.enabled) {
				const line = s.error ? s.error : s.running ? `Running, ${plural(s.clients || 0, "phone")} connected` : "Starting…";
				sec.append(el("p", s.error ? "rp-error" : "rp-muted", line));
				if (s.url) sec.append(row(el("code", "rp-url", s.url), copyButton(s.url)));
			}

			// Tailscale help
			const t = s.tailscale;
			if (s.enabled && tailscale && t?.found && t.running) {
				sec = section("Tailscale account");
				const who = t.loginName ? `Signed in as ${t.loginName}` : "Signed in";
				sec.append(el("p", "rp-muted", t.tailnet ? `${who} on tailnet ${t.tailnet}` : who));
				if (t.otherUsers > 0) sec.append(el("p", "rp-error", `This tailnet has ${t.otherUsers} other ${t.otherUsers === 1 ? "person" : "people"} on it. They can reach Remote's address (they still need to pair). Use your personal Tailscale account if you don't want that.`));
			}
			if (s.enabled && tailscale && t && !(t.found && t.running && t.https && t.serving)) {
				sec = section("Set up Tailscale");
				const steps = el("ol", "rp-steps");
				const step = (text, ok) => steps.append(el("li", ok ? "done" : "", text));
				step("Install Tailscale on this computer and on your phone (tailscale.com/download), then sign in.", t.found);
				step("Sign in to your own Tailscale account (the same one) on both.", t.running);
				step("In the admin console, on the DNS page, turn on MagicDNS and HTTPS certificates.", t.https);
				step("Let Pi Crust publish the port on your tailnet:", t.serving);
				sec.append(steps);
				if (t.funnel) sec.append(el("p", "rp-error", "Tailscale Funnel is on for this port, which would put Remote on the public internet. Turn Funnel off first."));
				else if (t.conflict) sec.append(el("p", "rp-error", "Something else is already published on this HTTPS port in Tailscale Serve. Pick another port or remove it first."));
				const cmd = `tailscale serve --bg --https=${s.httpsPort || 443} http://127.0.0.1:${s.port}`;
				const actions = row(button("Set up Tailscale Serve", () => call(crust.remote.setupTailscale), "btn"));
				if (t.consentUrl) actions.append(button("Open Tailscale to allow Serve", () => call(crust.remote.openExternal, t.consentUrl)));
				sec.append(actions, row(el("code", "rp-url", cmd), copyButton(cmd)));
			}

			// Pairing
			if (s.running) {
				sec = section("Pair a phone");
				if (pairing && pairing.expiresAt > Date.now()) fillPairing(sec);
				else {
					pairing = null;
					sec.append(row(button("Pair a phone", newPairing, "btn")));
				}
			}

			// Devices
			if (s.devices?.length) {
				sec = section("Paired phones");
				for (const d of s.devices) {
					const dot = el("span", d.connected ? "rp-dot on" : "rp-dot");
					dot.title = d.connected ? "Connected" : "Not connected";
					const meta = el("span", "rp-muted", `${d.connected ? "connected" : `seen ${ago(d.lastSeenAt)}`}${d.push ? " · 🔔" : ""}${d.pairedVia === "lan" ? " (Wi-Fi pairing)" : ""}`);
					// Two clicks instead of a dialog: dialogs are queued behind this one.
					const confirming = unpairing === d.id;
					const un = button(
						confirming ? "Confirm" : "Unpair",
						async () => {
							if (!confirming) {
								unpairing = d.id;
								return fill();
							}
							unpairing = null;
							await call(crust.remote.unpair, d.id);
						},
						confirming ? "btn danger" : "btn secondary",
					);
					sec.append(row(dot, el("span", "rp-name", d.name), meta, un));
				}
			}

			// Activity
			if (s.activity?.length) {
				const det = el("details", "rp-activity");
				det.append(el("summary", "", "Recent activity"));
				const line = (a) => (typeof a === "string" ? a : [a.time, a.action, a.detail ? JSON.stringify(a.detail) : ""].filter(Boolean).join(" "));
				det.append(el("pre", "modal-pre", s.activity.map(line).join("\n")));
				panel.append(det);
			}
		}

		const done = showDialog({
			method: "custom",
			title: "Remote access",
			cancelLabel: "Close",
			render: (box) => {
				box.append(panel);
				render = fill;
				fill();
				if (pair && status?.running && (status.mode !== "tailscale" || status.tailscale?.serving)) newPairing(); // "Pair a phone…" in the menu: show the code straight away
			},
		});
		crust.remote.status().then((s) => s && applyStatus(s, true)).catch(() => {});
		done.then(() => {
			render = null;
			clearInterval(tick);
			crust.remote.cancelPairing().catch(() => {});
		});
	}

	window.crustRemote = { open, onActiveChat, tabBadge };

	const prevActions = window.crustPaletteActions;
	window.crustPaletteActions = () => {
		const list = [...(prevActions?.() || []), { label: "Remote access…", desc: "control chats from your phone", run: () => open() }];
		if (status && !status.disabled) {
			const here = isActiveShared();
			if (activeChat()) list.push({ label: here ? "Stop using this chat from your phone" : "Use this chat from your phone", desc: here ? "shared with your phone" : "show it on your phone", run: () => shareActive(!here) });
			const on = !!status.enabled;
			list.push({ label: on ? "Turn Remote access off" : "Turn Remote access on", desc: on ? statusLine(status) : "control chats from your phone", run: () => setEnabled(!on) });
		}
		return list;
	};
})();
