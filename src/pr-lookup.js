// Cached pull request lookups that can't be made stale by a slow call. fetch(key) -> { value, cacheable }:
// only cacheable results are kept (a found PR, a definite "no PR"), never a network or gh failure.
// Every lookup in flight is remembered per key; invalidate() forgets it, so a result that arrives afterwards isn't stored.
"use strict";
const { createTtlCache } = require("./ttl-cache");

function createPrLookup(fetch, ttlMs, now = Date.now) {
	const cache = createTtlCache(ttlMs, now);
	const inflight = new Map(); // key -> { promise }
	async function get(key) {
		if (cache.has(key)) return cache.get(key);
		const running = inflight.get(key);
		if (running) return running.promise;
		const entry = {};
		entry.promise = (async () => {
			try {
				const r = await fetch(key);
				if (r.cacheable && inflight.get(key) === entry) cache.set(key, r.value);
				return r.value;
			} finally {
				if (inflight.get(key) === entry) inflight.delete(key);
			}
		})();
		inflight.set(key, entry);
		return entry.promise;
	}
	function invalidatePrefix(prefix = "") {
		cache.deletePrefix(prefix);
		for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
	}
	return { get, invalidate: (key) => (cache.delete(key), inflight.delete(key)), invalidatePrefix };
}

module.exports = { createPrLookup };
