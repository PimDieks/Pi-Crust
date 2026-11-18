// In-app updates from GitHub releases (installed builds with piCrustBuild "release", see update-mode.js).
// A small state machine around electron-updater: it only produces the card statuses the UI shows. The updater object is passed
// in (electron-updater's autoUpdater, or a fake in tests), so this file imports neither Electron nor electron-updater and has no git code.
// Statuses: { state: "none" } | { state: "available", version, notesUrl } | { state: "downloading", version, percent }
//   | { state: "ready", version, notesUrl } | { state: "restarting" } | { state: "offline" } | { state: "uptodate", version }
//   | { state: "error", kind, message, details }
// The only place that installs is restart(), and only from "ready". Nothing quits the app by itself here.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RELEASES_URL = "https://github.com/PimDieks/Pi-Crust/releases";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const LOG_MAX_BYTES = 256 * 1024;
const LOG_RING = 200;

// The one plain line per failure kind (wording agreed in the phase 3 plan, section 3.2).
const MESSAGES = {
	download: "Couldn't download the update. Check your connection and try again.",
	damaged: "The download was damaged, so it was not installed. This version still works.",
	blocked: "Windows or your antivirus blocked the update file.",
	locked: "Couldn't replace Pi Crust because a file is in use. Close other Pi Crust windows and retry.",
	signature: "The update is not signed by Nullvorm, so it was not installed.",
	unknown: "The update stopped. Use Copy details if you ask for help.",
};
const NETWORK = /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_(REFUSED|RESET|TIMED_OUT|CLOSED)|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TIMED_OUT|NETWORK_ACCESS_DENIED)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/;

// Raw error -> { kind, message }. kind is one of the MESSAGES keys or "offline" (a check that could not reach GitHub).
// Anything unrecognised becomes the fallback line; the raw text only goes into the details.
function mapError(err, phase = "check") {
	const code = String((err && err.code) || "");
	const text = String((err && err.message) || err || "");
	let kind = "unknown";
	if (code === "ERR_CHECKSUM_MISMATCH" || /sha512 checksum mismatch/i.test(text)) kind = "damaged";
	else if (code === "ERR_UPDATER_INVALID_SIGNATURE" || /not signed by the application owner/i.test(text)) kind = "signature";
	else if (code === "EBUSY" || /\bEBUSY\b|resource busy or locked|being used by another process/i.test(text)) kind = "locked";
	else if (code === "EACCES" || code === "EPERM" || /\b(EACCES|EPERM)\b|contains a virus/i.test(text)) kind = "blocked";
	else if (/operation not permitted/i.test(text) && /\.(exe|blockmap|tmp)|pending|installer/i.test(text)) kind = "blocked";
	else if (NETWORK.test(code + " " + text)) kind = phase === "check" ? "offline" : "download";
	return { kind, message: kind === "offline" ? "" : MESSAGES[kind] };
}

// A logger for electron-updater that keeps the last lines in memory and in a file that never grows past maxBytes.
function createLogger(file, maxBytes = LOG_MAX_BYTES) {
	const ring = [];
	const write = (level, msg) => {
		const line = `${new Date().toISOString()} ${level} ${String(msg).replace(/\s+$/, "")}`;
		ring.push(line);
		if (ring.length > LOG_RING) ring.shift();
		if (!file) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			let size = 0;
			try {
				size = fs.statSync(file).size;
			} catch {}
			if (size + line.length + 1 > maxBytes) {
				// keep the newest lines that fit in half the cap
				const keep = [];
				let n = 0;
				for (let i = ring.length - 1; i >= 0 && n + ring[i].length + 1 <= maxBytes / 2; i--) {
					keep.unshift(ring[i]);
					n += ring[i].length + 1;
				}
				fs.writeFileSync(file, keep.join("\n") + "\n");
			}
			else fs.appendFileSync(file, line + "\n");
		} catch {}
	};
	return { info: (m) => write("INFO", m), warn: (m) => write("WARN", m), error: (m) => write("ERROR", m), debug: () => {}, lines: (n = 20) => ring.slice(-n) };
}

// Text for "Copy details": no home folder, user name, temp, resources or install folder (any case, either slash, 8.3 short forms).
const reEscape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function redact(text) {
	let t = String(text);
	const pairs = [];
	const add = (p, label) => {
		if (p && String(p).length > 2) pairs.push([String(p).replace(/[\\/]+$/, ""), label]);
	};
	add(os.tmpdir(), "<temp folder>");
	add(process.resourcesPath, "<app resources>");
	add(process.execPath && path.dirname(process.execPath), "<install folder>");
	for (const n of [os.homedir(), process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA]) add(n, "<user folder>");
	pairs.sort((x, y) => y[0].length - x[0].length); // the longest (most specific) folder first
	for (const [p, label] of pairs) {
		const re = new RegExp(p.split(/[\\/]+/).map(reEscape).join("[\\\\/]+"), "gi");
		t = t.replace(re, label);
	}
	try {
		const user = os.userInfo().username;
		if (user && user.length > 2) t = t.replace(new RegExp(reEscape(user), "gi"), "<user>");
	} catch {}
	return t.replace(/\b[A-Z0-9_]{1,6}~\d\b/gi, "<user>");
}

function create({ updater, version, onStatus = () => {}, logFile = null, logger = createLogger(logFile) }) {
	let status = { state: "none" };
	let busy = false;
	let lastError = null; // { code, message } of the last failure, for details
	let foundVersion = null;

	updater.autoDownload = false;
	updater.autoInstallOnAppQuit = true;
	updater.allowPrerelease = false;
	updater.allowDowngrade = false;
	updater.logger = logger;
	// electron-updater emits "error" as well as rejecting; an EventEmitter with no listener would throw. The rejection is what we act on.
	updater.on("error", (e) => logger.error(`updater error: ${(e && e.code) || ""} ${(e && e.message) || e}`));
	updater.on("download-progress", (p) => {
		if (status.state === "downloading") set({ ...status, percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) });
	});

	const notesUrl = (v) => (SEMVER.test(String(v)) ? `${RELEASES_URL}/tag/v${v}` : RELEASES_URL);
	function set(s) {
		status = s;
		onStatus(status);
	}
	function fail(err, phase) {
		const m = mapError(err, phase);
		lastError = { code: (err && err.code) || "", message: String((err && err.message) || err || "") };
		logger.error(`${phase} failed (${m.kind}): ${lastError.code} ${lastError.message}`);
		return m;
	}

	// manual: the user pressed a button. Background checks stay quiet when offline and when up to date.
	async function check({ manual = false } = {}) {
		if (busy || ["downloading", "ready", "restarting"].includes(status.state)) return status;
		busy = true;
		try {
			const r = await updater.checkForUpdates();
			if (r && r.isUpdateAvailable && r.updateInfo) {
				foundVersion = r.updateInfo.version;
				set({ state: "available", version: foundVersion, notesUrl: notesUrl(foundVersion) });
			} else if (manual) set({ state: "uptodate", version: String(version) });
			else if (status.state === "uptodate" || status.state === "offline") set({ state: "none" });
		} catch (e) {
			const m = fail(e, "check");
			if (!manual) {
				// background check: never a card, whatever the reason (offline, 403/404, rate limit, no release yet); it is in the log
				if (status.state === "uptodate" || status.state === "offline") set({ state: "none" });
			} else if (m.kind === "offline") set({ state: "offline" });
			else set({ state: "error", phase: "check", kind: m.kind, message: m.message, details: details() });
		} finally {
			busy = false;
		}
		return status;
	}

	async function download() {
		const retry = status.state === "error" && status.phase === "download" && foundVersion; // Retry after a failed download
		if (busy || (status.state !== "available" && !retry)) return status;
		busy = true;
		const v = retry ? foundVersion : status.version;
		set({ state: "downloading", version: v, percent: 0 });
		try {
			await updater.downloadUpdate();
			set({ state: "ready", version: v, notesUrl: notesUrl(v) });
		} catch (e) {
			const m = fail(e, "download");
			set({ state: "error", phase: "download", kind: m.kind === "offline" ? "download" : m.kind, message: m.kind === "offline" ? MESSAGES.download : m.message, details: details() });
		} finally {
			busy = false;
		}
		return status;
	}

	// The only call that installs. Silent install, then start the new version.
	function restart() {
		if (status.state !== "ready") return false;
		set({ state: "restarting" });
		updater.quitAndInstall(true, true);
		return true;
	}

	function dismiss() {
		if (!["downloading", "restarting"].includes(status.state)) set({ state: "none" });
		return status;
	}

	function details() {
		const lines = [
			`Pi Crust ${version}${foundVersion ? ` (update to ${foundVersion})` : ""}`,
			`Windows ${os.release()} ${process.arch}`,
			`Error code: ${(lastError && lastError.code) || "none"}`,
			lastError ? `Error: ${lastError.message.split("\n")[0]}` : "",
			"Updater log (last 20 lines):",
			...(logger.lines ? logger.lines(20) : []),
		];
		return redact(lines.filter((l) => l !== "").join("\n"));
	}

	return { status: () => status, check, download, restart, dismiss, details };
}

module.exports = { create, mapError, createLogger, redact, MESSAGES, RELEASES_URL };
