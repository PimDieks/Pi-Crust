// Registry of agent adapters. Phase 6 has one agent, Pi; its adapter registers when it exists (the process driver step).
// Nothing requires this file yet.
"use strict";

const { assertAdapter } = require("./adapter");

const DEFAULT_ID = "pi";

function createRegistry() {
	const adapters = new Map();
	return {
		register(adapter) {
			assertAdapter(adapter);
			if (adapters.has(adapter.id)) throw new Error(`agent "${adapter.id}" is already registered`);
			adapters.set(adapter.id, adapter);
			return adapter;
		},
		// The adapter for an id; the default (Pi) for undefined; null for an unknown id.
		get: (id = DEFAULT_ID) => adapters.get(id) || null,
		has: (id) => adapters.has(id),
		list: () => [...adapters.values()],
		ids: () => [...adapters.keys()],
	};
}

module.exports = { createRegistry, DEFAULT_ID };
