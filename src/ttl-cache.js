// Small time-based cache. Negative results are cached too: store null, check with has().
"use strict";

function createTtlCache(ttlMs, now = Date.now) {
	const map = new Map(); // key -> { value, at }
	return {
		has(key) {
			const e = map.get(key);
			if (e && now() - e.at < ttlMs) return true;
			map.delete(key);
			return false;
		},
		get: (key) => map.get(key)?.value,
		set(key, value) {
			const t = now();
			for (const [k, e] of map) if (t - e.at >= ttlMs) map.delete(k); // prune what expired
			map.set(key, { value, at: t });
		},
		delete: (key) => void map.delete(key),
		deletePrefix(prefix) {
			for (const k of map.keys()) if (k.startsWith(prefix)) map.delete(k);
		},
	};
}

module.exports = { createTtlCache };
