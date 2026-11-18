"use strict";
// Claude key store (phase 7, T4): a fake safeStorage and a temp folder. No Electron, no real key.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createKeystore, KeystoreError, FILE_NAME } = require("../src/agents/claude/keystore");

const FAKE_KEY = "fake-test-key-0123456789";
const tmpDirs = [];
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mkdir = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ks-"));
	tmpDirs.push(d);
	return d;
};

// A fake with the async safeStorage shape. "Encryption" is reversible scrambling, so the blob holds no readable value.
function fakeSafeStorage({ available = true, backend = "gnome_libsecret", damage = false, reEncrypt = false } = {}) {
	const calls = [];
	return {
		calls,
		isAsyncEncryptionAvailable: async () => available,
		getSelectedStorageBackend: async () => backend,
		encryptStringAsync: async (s) => {
			calls.push("encrypt");
			return Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a));
		},
		decryptStringAsync: async (buf) => {
			calls.push("decrypt");
			if (damage) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
			return { shouldReEncrypt: reEncrypt, result: Buffer.from(Buffer.from(buf).map((b) => b ^ 0x5a)).toString("utf8") };
		},
		// the sync calls must never be used
		encryptString: () => {
			throw new Error("sync call used");
		},
		decryptString: () => {
			throw new Error("sync call used");
		},
		isEncryptionAvailable: () => {
			throw new Error("sync call used");
		},
	};
}
const make = (over = {}) => {
	const dir = over.dir || mkdir();
	const safeStorage = over.safeStorage || fakeSafeStorage();
	return { dir, safeStorage, ks: createKeystore({ safeStorage, dir, env: over.env || {}, platform: over.platform || "win32" }) };
};

test("set then status 'stored' and read returns the key; status never carries it", async () => {
	const { ks } = make();
	assert.deepEqual(await ks.status(), { source: "none" });
	assert.deepEqual(await ks.set(FAKE_KEY), { ok: true });
	const s = await ks.status();
	assert.deepEqual(s, { source: "stored" });
	assert.ok(!JSON.stringify(s).includes(FAKE_KEY));
	assert.deepEqual(await ks.read(), { source: "stored", key: FAKE_KEY });
});
test("the blob on disk holds no readable trace of the key", async () => {
	const { ks, dir } = make();
	await ks.set(FAKE_KEY);
	const blob = fs.readFileSync(path.join(dir, FILE_NAME));
	assert.ok(!blob.toString("latin1").includes(FAKE_KEY));
	assert.ok(!blob.toString("utf8").includes("fake-test-key"));
});
test("only the async safeStorage calls are used (the fake throws on a sync call)", async () => {
	const safeStorage = fakeSafeStorage();
	const { ks } = make({ safeStorage });
	await ks.set(FAKE_KEY);
	await ks.status();
	await ks.read();
	assert.deepEqual(safeStorage.calls.filter((c, i, a) => a.indexOf(c) === i).sort(), ["decrypt", "encrypt"]);
});
test("clear removes the key; clearing again is fine", async () => {
	const { ks, dir } = make();
	await ks.set(FAKE_KEY);
	await ks.clear();
	assert.equal(fs.existsSync(path.join(dir, FILE_NAME)), false);
	assert.deepEqual(await ks.status(), { source: "none" });
	assert.deepEqual(await ks.clear(), { ok: true });
});
test("env: ANTHROPIC_API_KEY alone gives 'env'; a stored key wins; clear falls back to env", async () => {
	const env = { ANTHROPIC_API_KEY: "  env-test-key  " };
	const { ks } = make({ env });
	assert.deepEqual(await ks.status(), { source: "env" });
	assert.deepEqual(await ks.read(), { source: "env", key: "env-test-key" });
	await ks.set(FAKE_KEY);
	assert.deepEqual(await ks.status(), { source: "stored" });
	assert.equal((await ks.read()).key, FAKE_KEY);
	await ks.clear();
	assert.deepEqual(await ks.status(), { source: "env" });
	for (const v of ["", "   ", undefined]) assert.deepEqual(await make({ env: { ANTHROPIC_API_KEY: v } }).ks.status(), { source: "none" });
});
test("unavailable encryption: set throws a readable 'cannot store' error and writes nothing", async () => {
	const { ks, dir } = make({ safeStorage: fakeSafeStorage({ available: false }) });
	await assert.rejects(ks.set(FAKE_KEY), (e) => e instanceof KeystoreError && /^Cannot store the key/.test(e.message) && e.code === "UNAVAILABLE" && !e.message.includes(FAKE_KEY));
	assert.equal(fs.existsSync(path.join(dir, FILE_NAME)), false);
});
test("Linux basic_text backend counts as unavailable; a real backend does not; other platforms ignore the backend", async () => {
	const bad = make({ safeStorage: fakeSafeStorage({ backend: "basic_text" }), platform: "linux" });
	await assert.rejects(bad.ks.set(FAKE_KEY), /Cannot store the key.*(no secret store|keyring)/);
	assert.deepEqual(await make({ safeStorage: fakeSafeStorage({ backend: "kwallet5" }), platform: "linux" }).ks.set(FAKE_KEY), { ok: true });
	assert.deepEqual(await make({ safeStorage: fakeSafeStorage({ backend: "basic_text" }), platform: "win32" }).ks.set(FAKE_KEY), { ok: true });
});
test("a safeStorage that cannot be checked, or throws while encrypting, is a readable error with no key in it", async () => {
	const dir = mkdir();
	const broken = { isAsyncEncryptionAvailable: async () => { throw new Error("boom " + FAKE_KEY); } };
	await assert.rejects(createKeystore({ safeStorage: broken, dir }).set(FAKE_KEY), (e) => /Cannot store/.test(e.message) && !e.message.includes(FAKE_KEY));
	const enc = { ...fakeSafeStorage(), encryptStringAsync: async () => { throw new Error("enc " + FAKE_KEY); } };
	await assert.rejects(createKeystore({ safeStorage: enc, dir }).set(FAKE_KEY), (e) => /Cannot store/.test(e.message) && !e.message.includes(FAKE_KEY));
});
test("empty or non-string keys are refused", async () => {
	const { ks } = make();
	for (const k of ["", "   ", undefined, null, 5, {}]) await assert.rejects(ks.set(k), KeystoreError, String(k));
	assert.deepEqual(await ks.status(), { source: "none" });
});
test("a damaged blob reads as none with a reason (and env still wins over it)", async () => {
	const dir = mkdir();
	const good = make({ dir });
	await good.ks.set(FAKE_KEY);
	const bad = make({ dir, safeStorage: fakeSafeStorage({ damage: true }) });
	const s = await bad.ks.status();
	assert.equal(s.source, "none");
	assert.match(s.reason, /damaged|another user/);
	const r = await bad.ks.read();
	assert.equal(r.source, "none");
	assert.equal(r.key, null);
	assert.ok(r.reason);
	assert.ok(!JSON.stringify([s, r]).includes(FAKE_KEY));
	assert.deepEqual(await make({ dir, safeStorage: fakeSafeStorage({ damage: true }), env: { ANTHROPIC_API_KEY: "e" } }).ks.status(), { source: "env" });
	// an empty file and a decrypt that returns nothing are damage too
	fs.writeFileSync(path.join(dir, FILE_NAME), Buffer.alloc(0));
	const empty = createKeystore({ safeStorage: { ...fakeSafeStorage(), decryptStringAsync: async () => ({ result: "" }) }, dir });
	assert.equal((await empty.status()).source, "none");
});
test("shouldReEncrypt rewrites the blob without losing the key", async () => {
	const dir = mkdir();
	await make({ dir }).ks.set(FAKE_KEY);
	const safeStorage = fakeSafeStorage({ reEncrypt: true });
	const { ks } = make({ dir, safeStorage });
	assert.equal((await ks.read()).key, FAKE_KEY);
	assert.ok(safeStorage.calls.includes("encrypt"));
	assert.equal((await make({ dir }).ks.read()).key, FAKE_KEY);
});
test("nothing is logged: console output stays empty through every call, including failures", async () => {
	const seen = [];
	const saved = {};
	for (const m of ["log", "info", "warn", "error", "debug"]) {
		saved[m] = console[m];
		console[m] = (...a) => seen.push(a.join(" "));
	}
	const out = [];
	const w = process.stdout.write;
	process.stdout.write = (...a) => (out.push(String(a[0])), true);
	try {
		const { ks, dir } = make();
		await ks.set(FAKE_KEY);
		await ks.status();
		await ks.read();
		fs.writeFileSync(path.join(dir, FILE_NAME), "junk");
		await make({ dir, safeStorage: fakeSafeStorage({ damage: true }) }).ks.read();
		await ks.clear();
	} finally {
		process.stdout.write = w;
		for (const m of Object.keys(saved)) console[m] = saved[m];
	}
	assert.deepEqual(seen, []);
	assert.ok(!out.join("").includes(FAKE_KEY));
});
test("the module has no IPC or logging in it, and read() is not wired anywhere in src outside the keystore", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "claude", "keystore.js"), "utf8");
	assert.ok(!/ipcMain|ipcRenderer|console\.|require\(["']electron["']\)/.test(src));
});
test("createKeystore needs safeStorage and a folder", () => {
	assert.throws(() => createKeystore({}), TypeError);
	assert.throws(() => createKeystore({ safeStorage: fakeSafeStorage() }), TypeError);
});
