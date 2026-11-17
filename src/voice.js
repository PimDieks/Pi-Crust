// Pure voice-input helpers. UMD: `Voice` in the UI, `require("./voice")` in the main process and tests.
//  - encodeWav(Float32Array samples, sampleRate) -> ArrayBuffer   (16-bit PCM mono WAV)
//  - cleanTranscript(raw) -> string   (whisper-cli stdout without timestamps/artefacts like [BLANK_AUDIO] or (music))
//  - pickModel(fileNames) -> name | null   (preferred model first, else first *.bin; .part files ignored)
(function (root, make) {
	const api = make();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.Voice = api;
})(typeof self !== "undefined" ? self : this, function () {
	const PREFERRED_MODEL = "ggml-large-v3-turbo-q5_0.bin";

	function encodeWav(samples, sampleRate) {
		const buf = new ArrayBuffer(44 + samples.length * 2);
		const v = new DataView(buf);
		const str = (o, s) => {
			for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
		};
		str(0, "RIFF");
		v.setUint32(4, 36 + samples.length * 2, true);
		str(8, "WAVE");
		str(12, "fmt ");
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true); // PCM
		v.setUint16(22, 1, true); // mono
		v.setUint32(24, sampleRate, true);
		v.setUint32(28, sampleRate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		str(36, "data");
		v.setUint32(40, samples.length * 2, true);
		for (let i = 0; i < samples.length; i++) {
			const s = Math.max(-1, Math.min(1, samples[i]));
			v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
		return buf;
	}

	function cleanTranscript(raw) {
		const lines = String(raw || "")
			.split(/\r?\n/)
			.map((l) => l.replace(/^\s*\[\d\d:\d\d[:.\d]*\s*-->\s*[\d:.]+\]\s*/, "").trim())
			// whole line is only a bracketed/parenthesised annotation: [BLANK_AUDIO], (music), [Music]
			.filter((l) => l && !/^(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)(\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+))*$/.test(l));
		return lines.join(" ").replace(/\s+/g, " ").trim();
	}

	function pickModel(names) {
		const bins = (names || []).filter((n) => n.endsWith(".bin")).sort();
		if (bins.includes(PREFERRED_MODEL)) return PREFERRED_MODEL;
		return bins[0] || null;
	}

	return { encodeWav, cleanTranscript, pickModel, PREFERRED_MODEL };
});
