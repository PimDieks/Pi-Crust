// Voice input, main side: finds whisper-cli + a model, transcribes a 16 kHz WAV sent by the UI, mic permission.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, systemPreferences, session } = require("electron");
const { cleanTranscript, pickModel, PREFERRED_MODEL } = require("./voice");

const modelsDir = () => path.join(app.getPath("userData"), "models");
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${PREFERRED_MODEL}`;

const IS_WIN = process.platform === "win32";
// Windows: PATH, %LOCALAPPDATA%\Programs\whisper.cpp (also its Release folder, as the release zip unpacks), next to the models.
const winDirs = () => {
	const own = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "whisper.cpp") : null;
	return [...(process.env.PATH || "").split(path.delimiter), ...(own ? [own, path.join(own, "Release")] : []), modelsDir(), path.dirname(modelsDir())];
};

function findBinary() {
	for (const dir of IS_WIN ? winDirs() : ["/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH || "").split(path.delimiter)]) {
		if (!dir) continue;
		const p = path.join(dir, IS_WIN ? "whisper-cli.exe" : "whisper-cli");
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {}
	}
	return null;
}

function findModel() {
	try {
		const name = pickModel(fs.readdirSync(modelsDir()));
		return name ? path.join(modelsDir(), name) : null;
	} catch {
		return null;
	}
}

function problem(binary, model) {
	const parts = [];
	if (!binary && IS_WIN)
		parts.push("whisper-cli.exe not found. Download the whisper.cpp Windows release zip from https://github.com/ggml-org/whisper.cpp/releases and put whisper-cli.exe on PATH (or unpack it to %LOCALAPPDATA%\\Programs\\whisper.cpp).");
	else if (!binary) parts.push("whisper-cli not found. Install it with: brew install whisper-cpp");
	if (!model && IS_WIN) parts.push(`No whisper model found in ${modelsDir()}. Download one with: curl.exe -L --create-dirs -o "${path.join(modelsDir(), PREFERRED_MODEL)}" ${MODEL_URL}`);
	else if (!model) parts.push(`No whisper model found in ${modelsDir()}. Download one with: mkdir -p "${modelsDir()}" && curl -L -o "${path.join(modelsDir(), PREFERRED_MODEL)}" ${MODEL_URL}`);
	return parts.join("\n");
}

const status = () => {
	const binary = findBinary();
	const model = findModel();
	return { binary, model, error: problem(binary, model) || null };
};

function register({ ipcMain }) {
	// The main UI (file://) may use the microphone; the dev browser session keeps its own, stricter handlers.
	// session.defaultSession only exists once the app is ready.
	const isUi = (url) => String(url || "").startsWith("file://");
	app.whenReady().then(() => {
		const ses = session.defaultSession;
		ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
			if (permission === "media") {
				const audioOnly = !(details?.mediaTypes || []).includes("video");
				return callback(isUi(details?.requestingUrl) && audioOnly);
			}
			callback(true); // unchanged default for everything else
		});
		ses.setPermissionCheckHandler((_wc, permission, origin) => (permission === "media" ? isUi(origin) : true));
	});

	ipcMain.handle("voice:status", () => status());

	ipcMain.handle("voice:askMic", async () => {
		if (process.platform !== "darwin") return { granted: true };
		const s = systemPreferences.getMediaAccessStatus("microphone");
		if (s === "granted") return { granted: true };
		if (s === "denied" || s === "restricted") {
			return { granted: false, error: "Microphone access is denied. Enable Pi Crust in System Settings → Privacy & Security → Microphone." };
		}
		return { granted: await systemPreferences.askForMediaAccess("microphone") };
	});

	ipcMain.handle("voice:transcribe", async (_e, wav, lang) => {
		const { binary, model, error } = status();
		if (error) return { error };
		const file = path.join(os.tmpdir(), `crust-voice-${process.pid}-${Date.now()}.wav`);
		try {
			fs.writeFileSync(file, Buffer.from(wav));
			const language = typeof lang === "string" && /^[a-z]{2,3}$/i.test(lang) ? lang : "auto";
			const stdout = await new Promise((resolve, reject) => {
				execFile(binary, ["-m", model, "-f", file, "-l", language, "-nt", "-np"], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out, errOut) => {
					if (err) reject(new Error((errOut || "").trim().split("\n").slice(-3).join("\n") || err.message));
					else resolve(out);
				});
			});
			return { text: cleanTranscript(stdout) };
		} catch (err) {
			return { error: `Transcription failed: ${err.message || err}` };
		} finally {
			fs.rm(file, { force: true }, () => {});
		}
	});
}

module.exports = { register, findBinary, findModel };
