// Voice input: mic button / ⌘⇧Space records, Escape cancels, stop transcribes locally (whisper-cli, see voice-main.js)
// and inserts the text into the composer. Never auto-sends.
"use strict";

(() => {
	const btn = $("#mic");
	const input = $("#input");
	const RATE = 16000;
	let rec = null; // { stream, ctx, node, source, chunks, rate }
	let busy = false;
	let micOk = false;

	function setState(state) {
		btn.classList.toggle("recording", state === "recording");
		btn.classList.toggle("busy", state === "busy");
		btn.setAttribute("aria-pressed", String(state === "recording"));
	}

	function release() {
		if (!rec) return;
		try {
			rec.node.disconnect();
			rec.source.disconnect();
		} catch {}
		rec.node.onaudioprocess = null;
		rec.stream.getTracks().forEach((t) => t.stop());
		rec.ctx.close().catch(() => {});
	}

	async function start() {
		const st = await crust.voice.status();
		if (st.error) return toast(st.error, "error");
		if (!micOk) {
			const r = await crust.voice.askMic();
			if (!r.granted) return toast(r.error || "Microphone access was not granted", "error");
			micOk = true;
		}
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (e) {
			return toast(`Can't open the microphone: ${e.message || e}`, "error");
		}
		const ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(stream);
		const node = ctx.createScriptProcessor(4096, 1, 1);
		const chunks = [];
		node.onaudioprocess = (ev) => {
			const ch = ev.inputBuffer;
			const mono = new Float32Array(ch.length);
			for (let c = 0; c < ch.numberOfChannels; c++) {
				const d = ch.getChannelData(c);
				for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch.numberOfChannels;
			}
			chunks.push(mono);
		};
		source.connect(node);
		node.connect(ctx.destination); // required for onaudioprocess to fire; output buffer stays silent
		rec = { stream, ctx, node, source, chunks, rate: ctx.sampleRate };
		setState("recording");
	}

	async function resample(chunks, rate) {
		const total = chunks.reduce((n, c) => n + c.length, 0);
		const data = new Float32Array(total);
		let o = 0;
		for (const c of chunks) {
			data.set(c, o);
			o += c.length;
		}
		if (rate === RATE) return data;
		const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((total * RATE) / rate)), RATE);
		const buf = off.createBuffer(1, total, rate);
		buf.copyToChannel(data, 0);
		const src = off.createBufferSource();
		src.buffer = buf;
		src.connect(off.destination);
		src.start();
		return (await off.startRendering()).getChannelData(0);
	}

	function insert(text) {
		const v = input.value;
		const a = input.selectionStart ?? v.length;
		const b = input.selectionEnd ?? v.length;
		const before = v.slice(0, a);
		const after = v.slice(b);
		const lead = before && !/\s$/.test(before) ? " " : "";
		const trail = after && !/^\s/.test(after) ? " " : "";
		input.value = before + lead + text + trail + after;
		const pos = (before + lead + text).length;
		input.focus();
		input.setSelectionRange(pos, pos);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	async function finish(cancel) {
		const r = rec;
		if (!r) return;
		release();
		rec = null;
		if (cancel) return setState("idle");
		busy = true;
		setState("busy");
		try {
			const samples = await resample(r.chunks, r.rate);
			if (samples.length < RATE / 4) return; // under 0.25 s: nothing to transcribe
			const res = await crust.voice.transcribe(Voice.encodeWav(samples, RATE), "auto");
			if (res.error) toast(res.error, "error");
			else if (res.text) insert(res.text);
			else toast("No speech detected", "info");
		} catch (e) {
			toast(`Voice input failed: ${e.message || e}`, "error");
		} finally {
			busy = false;
			setState("idle");
		}
	}

	async function toggle() {
		if (busy) return;
		if (rec) return finish(false);
		busy = true;
		setState("busy");
		try {
			await start();
		} finally {
			busy = false;
			if (!rec) setState("idle");
		}
	}

	btn.addEventListener("click", toggle);
	window.addEventListener(
		"keydown",
		(e) => {
			if (e.key === "Escape" && rec) {
				e.preventDefault();
				e.stopPropagation();
				finish(true);
			} else if (modOnly(e) && e.shiftKey && !e.altKey && (e.code === "Space" || e.key === " ")) {
				e.preventDefault();
				e.stopPropagation();
				toggle();
			}
		},
		true,
	);
	window.addEventListener("beforeunload", release);
})();
