// API key store for the Claude agent: a thin wrapper around Electron's safeStorage (async calls only; the sync ones go away in Electron 46).
// Electron and the folder are passed in, so a fake can stand in for tests. No IPC, no logging. The key leaves this module only
// through read(), which is for the main process alone (it goes into the SDK's env, nothing else). status() never returns the key.
//   set(key)   -> { ok: true }, or throws KeystoreError ("cannot store"). Never puts the key in a message.
//   status()   -> { source: "stored" | "env" | "none", reason? }
//   clear()    -> { ok: true }
//   read()     -> { source, key } or { source: "none", key: null, reason }
"use strict";

const fs = require("node:fs/promises");
const nodePath = require("node:path");

const FILE_NAME = "claude-api-key.bin";
const ENV_NAME = "ANTHROPIC_API_KEY";

class KeystoreError extends Error {
	constructor(message, code) {
		super(message);
		this.name = "KeystoreError";
		this.code = code;
	}
}

function createKeystore({ safeStorage, dir, env = process.env, fsApi = fs, platform = process.platform } = {}) {
	if (!safeStorage || typeof dir !== "string" || !dir) throw new TypeError("createKeystore needs safeStorage and a folder");
	const file = nodePath.join(dir, FILE_NAME);

	// null when encryption is usable, else a readable reason.
	async function unavailable() {
		try {
			if (typeof safeStorage.isAsyncEncryptionAvailable !== "function" || !(await safeStorage.isAsyncEncryptionAvailable())) {
				return "This computer has no secure place to keep a key (the system's encryption is unavailable).";
			}
			if (platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function") {
				const backend = await safeStorage.getSelectedStorageBackend();
				if (backend === "basic_text") return "This computer has no secret store (no keyring), so a key cannot be kept safely. Use the ANTHROPIC_API_KEY environment variable instead.";
			}
			return null;
		} catch {
			return "The system's encryption could not be checked.";
		}
	}

	const envKey = () => {
		const v = env && env[ENV_NAME];
		return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
	};

	// Decrypts the stored blob. { key } | { missing: true } | { reason }.
	async function load() {
		let blob;
		try {
			blob = await fsApi.readFile(file);
		} catch (e) {
			if (e && e.code === "ENOENT") return { missing: true };
			return { reason: "The stored key could not be read from disk." };
		}
		const why = await unavailable();
		if (why) return { reason: why };
		try {
			const r = await safeStorage.decryptStringAsync(blob);
			const key = r && typeof r === "object" ? r.result : r;
			if (typeof key !== "string" || key === "") return { reason: "The stored key is damaged. Enter it again." };
			if (r && r.shouldReEncrypt) {
				try {
					await writeBlob(await safeStorage.encryptStringAsync(key));
				} catch {}
			}
			return { key };
		} catch {
			return { reason: "The stored key is damaged or belongs to another user or computer. Enter it again." };
		}
	}

	async function writeBlob(blob) {
		await fsApi.mkdir(dir, { recursive: true });
		const tmp = file + ".tmp";
		await fsApi.writeFile(tmp, blob, { mode: 0o600 });
		await fsApi.rename(tmp, file);
	}

	return {
		async set(key) {
			if (typeof key !== "string" || key.trim() === "") throw new KeystoreError("Enter a key to store.", "EMPTY");
			const why = await unavailable();
			if (why) throw new KeystoreError("Cannot store the key: " + why, "UNAVAILABLE");
			try {
				await writeBlob(await safeStorage.encryptStringAsync(key.trim()));
			} catch {
				throw new KeystoreError("Cannot store the key: the encryption or the write to disk failed.", "WRITE_FAILED");
			}
			return { ok: true };
		},
		async status() {
			const s = await load();
			if (s.key) return { source: "stored" };
			if (envKey()) return { source: "env" };
			return s.reason ? { source: "none", reason: s.reason } : { source: "none" };
		},
		async clear() {
			try {
				await fsApi.rm(file, { force: true });
			} catch {
				throw new KeystoreError("The stored key could not be removed.", "CLEAR_FAILED");
			}
			return { ok: true };
		},
		// Main process only: never wire this to IPC.
		async read() {
			const s = await load();
			if (s.key) return { source: "stored", key: s.key };
			const e = envKey();
			if (e) return { source: "env", key: e };
			return { source: "none", key: null, ...(s.reason ? { reason: s.reason } : {}) };
		},
	};
}

module.exports = { createKeystore, KeystoreError, FILE_NAME, ENV_NAME };
