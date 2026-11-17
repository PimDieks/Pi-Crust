// Web Push without dependencies: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), node:crypto + node:https only.
"use strict";

const crypto = require("node:crypto");
const https = require("node:https");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s), "base64url");
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));

function generateVapidKeys() {
	const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	const privateJwk = privateKey.export({ format: "jwk" });
	const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(privateJwk.x), fromB64url(privateJwk.y)]));
	return { publicKey, privateJwk };
}

function vapidHeaders({ endpoint, publicKey, privateJwk, subject, now = Date.now, expSeconds = 12 * 3600 }) {
	const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
	const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + expSeconds, sub: subject }));
	const data = `${header}.${claims}`;
	// ieee-p1363 = the raw r||s form JWS wants (Node's default is DER).
	const sig = crypto.sign("sha256", Buffer.from(data), { key: crypto.createPrivateKey({ key: privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
	return { Authorization: `vapid t=${data}.${b64url(sig)}, k=${publicKey}` };
}

// Single-record aes128gcm body: salt(16) | rs(4) | idlen(1) | as_public(65) | AES-GCM(plaintext | 0x02).
function encryptPayload({ plaintext, p256dh, auth, salt = crypto.randomBytes(16), asPrivateKey, rs = 4096 }) {
	// 16 tag + 1 delimiter + 86 header bytes must fit in the record size push services accept.
	if (plaintext.length > rs - 16 - 1 - 86) throw new Error("Push payload too large");
	const uaPub = fromB64url(p256dh);
	const authSecret = fromB64url(auth);
	const ecdh = crypto.createECDH("prime256v1");
	if (asPrivateKey) ecdh.setPrivateKey(asPrivateKey);
	else ecdh.generateKeys();
	const asPub = ecdh.getPublicKey();
	const shared = ecdh.computeSecret(uaPub);
	const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32);
	const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
	const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
	const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const head = Buffer.alloc(21);
	salt.copy(head, 0);
	head.writeUInt32BE(rs, 16);
	head[20] = asPub.length;
	return Buffer.concat([head, asPub, body]);
}

// A subscription comes from the (paired) phone, so only talk to the real push services: no SSRF to the LAN.
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_SUFFIXES = [".notify.windows.com", ".push.apple.com"];
function isAllowedPushEndpoint(url) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return false;
	}
	if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
	const h = u.hostname.toLowerCase();
	return PUSH_HOSTS.has(h) || PUSH_SUFFIXES.some((s) => h.endsWith(s));
}

// p256dh is an uncompressed P-256 point (65 bytes, 0x04 first); auth is 16 random bytes. Strict base64url, no padding.
function isValidSubscriptionKeys(p256dh, auth) {
	const dec = (s) => (typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s) ? fromB64url(s) : null);
	const k = dec(p256dh);
	const a = dec(auth);
	return !!k && k.length === 65 && k[0] === 4 && !!a && a.length === 16;
}

function sendPush(subscription, payload, { vapid, subject, ttl = 3600, urgency = "normal", topic, request = https.request } = {}) {
	return new Promise((resolve, reject) => {
		try {
			const endpoint = subscription?.endpoint;
			if (!isAllowedPushEndpoint(endpoint)) throw new Error("Push endpoint not allowed");
			const body = encryptPayload({ plaintext: Buffer.from(payload), p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
			const u = new URL(endpoint);
			const headers = {
				...vapidHeaders({ endpoint, publicKey: vapid.publicKey, privateJwk: vapid.privateJwk, subject }),
				TTL: String(ttl),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				"Content-Length": String(body.length),
				Urgency: urgency,
			};
			if (topic) headers.Topic = String(topic).slice(0, 32);
			const req = request({ method: "POST", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: 10_000 }, (res) => {
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode }));
				res.on("error", reject);
			});
			req.on("timeout", () => req.destroy(new Error("Push request timed out")));
			req.on("error", reject);
			req.end(body);
		} catch (e) {
			reject(e);
		}
	});
}

module.exports = { generateVapidKeys, vapidHeaders, encryptPayload, sendPush, isAllowedPushEndpoint, isValidSubscriptionKeys };
