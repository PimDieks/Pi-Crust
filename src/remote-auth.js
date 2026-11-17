// Remote access: one-time pairing codes and per-device tokens. Pure (no Electron); storage is injected.
// Only hashes are kept: the code lives in memory as sha256, a device token is stored as sha256 (the token itself is
// 256 random bits, so a fast hash is enough and lets us look it up without a salt).
"use strict";

const crypto = require("node:crypto");

// Crockford base32 without I, L, O, U: easy to read off a screen and type on a phone.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;
const CODE_TTL_MS = 5 * 60_000;
const MAX_PAIR_FAILURES = 10;
const SEEN_EVERY_MS = 60_000;
const NINETY_DAYS = 90 * 24 * 3600_000;
// A Wi-Fi pairing goes over plain http, so its token is short-lived (absolute, not renewed by use).
const LAN_TOKEN_TTL_MS = 30 * 24 * 3600_000;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const sha256Hex = (s) => sha256(s).toString("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Case, spaces and dashes don't matter when typing a code.
function normalizeCode(code) {
	return String(code ?? "")
		.toUpperCase()
		.replace(/[\s-]+/g, "");
}

function sanitizeDeviceName(s) {
	const clean = String(s ?? "")
		.replace(/[^\P{C}]/gu, " ") // control characters
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40)
		.trim();
	return clean || "Phone";
}

const equalHex = (a, b) => {
	const x = Buffer.from(String(a), "hex");
	const y = Buffer.from(String(b), "hex");
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

const publicDevice = (d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, push: !!d.push, pairedVia: d.pairedVia === "lan" ? "lan" : "tailscale" });

function createTokenStore({ load, save, now = Date.now, random = crypto.randomBytes } = {}) {
	let devices = [];
	try {
		const loaded = load?.();
		if (Array.isArray(loaded)) devices = loaded.filter((d) => d && typeof d.id === "string" && typeof d.tokenHash === "string").map((d) => ({ ...d }));
	} catch {}
	const persist = () => {
		try {
			save?.(devices.map((d) => ({ ...d })));
		} catch {}
	};

	let pairing = null; // { hash: Buffer, expiresAt, failures }

	// Unbiased: 32 symbols divide 256 evenly, so a byte's low 5 bits are uniform.
	function randomCode() {
		const bytes = random(CODE_LEN);
		let out = "";
		for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] & 31];
		return out;
	}

	function newPairing() {
		const code = randomCode();
		pairing = { hash: sha256(code), expiresAt: now() + CODE_TTL_MS, failures: 0 };
		return { code, expiresAt: pairing.expiresAt };
	}

	function pairingInfo() {
		if (pairing && now() >= pairing.expiresAt) pairing = null;
		return pairing ? { expiresAt: pairing.expiresAt } : null;
	}

	// via: how the phone reached us, "lan" (http) or "tailscale" (https).
	function redeem(code, deviceName, via = "tailscale") {
		if (!pairingInfo()) return { error: "No pairing in progress or the code expired. Create a new one on the desktop.", status: 401 };
		const ok = crypto.timingSafeEqual(sha256(normalizeCode(code)), pairing.hash);
		if (!ok) {
			// Behind tailscale serve every client is 127.0.0.1, so the limit is global for the code.
			if (++pairing.failures >= MAX_PAIR_FAILURES) {
				pairing = null;
				return { error: "Too many wrong codes. Create a new one on the desktop.", status: 429 };
			}
			return { error: "Wrong code", status: 401 };
		}
		pairing = null; // one-time
		const token = b64url(random(32));
		const t = now();
		const device = { id: random(8).toString("hex"), name: sanitizeDeviceName(deviceName), tokenHash: sha256Hex(token), createdAt: t, lastSeenAt: t, push: null, pairedVia: via === "lan" ? "lan" : "tailscale" };
		devices.push(device);
		persist();
		return { token, device: publicDevice(device) };
	}

	function verify(token) {
		if (typeof token !== "string" || !token || token.length > 256) return null;
		const hash = sha256(token);
		let found = null;
		// No early exit: the time taken doesn't depend on which device matched.
		for (const d of devices) if (equalHex(d.tokenHash, hash.toString("hex"))) found = d;
		if (!found) return null;
		const t = now();
		if (found.pairedVia === "lan" && t - (found.createdAt || 0) >= LAN_TOKEN_TTL_MS) return null;
		if (t - (found.lastSeenAt || 0) >= SEEN_EVERY_MS) {
			found.lastSeenAt = t;
			persist();
		}
		return publicDevice(found);
	}

	function revoke(deviceId) {
		const n = devices.length;
		devices = devices.filter((d) => d.id !== deviceId);
		if (devices.length !== n) persist();
		return devices.length !== n;
	}

	function setPush(deviceId, sub) {
		const d = devices.find((x) => x.id === deviceId);
		if (!d) return false;
		d.push = sub ? { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys?.p256dh), auth: String(sub.keys?.auth) } } : null;
		persist();
		return true;
	}

	const devicesWithPush = () => devices.filter((d) => d.push).map((d) => ({ id: d.id, name: d.name, push: d.push }));

	// Drop devices that haven't been seen for a long time (a lost phone's token shouldn't live forever).
	function pruneStale(maxAgeMs = NINETY_DAYS) {
		const cutoff = now() - maxAgeMs;
		const n = devices.length;
		devices = devices.filter((d) => (d.lastSeenAt || d.createdAt || 0) >= cutoff && !(d.pairedVia === "lan" && now() - (d.createdAt || 0) >= LAN_TOKEN_TTL_MS));
		if (devices.length !== n) persist();
		return n - devices.length;
	}

	return { newPairing, cancelPairing: () => void (pairing = null), pairingInfo, redeem, verify, revoke, list: () => devices.map(publicDevice), setPush, devicesWithPush, pruneStale };
}

module.exports = { createTokenStore, sanitizeDeviceName, normalizeCode, sha256Hex, CODE_ALPHABET, CODE_LEN, CODE_TTL_MS, MAX_PAIR_FAILURES, LAN_TOKEN_TTL_MS };
