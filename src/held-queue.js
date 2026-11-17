// Held messages: what was queued in Pi when you pressed Stop. Pi's queue is emptied (else it would run them right
// away) and the texts wait here, per chat, until someone sends, edits or removes them. One list for the desktop and
// the phone: both go through this store. Pure: Pi and the notification are passed in.
"use strict";

function createHeldQueue({ request, emit }) {
	const held = new Map(); // chatId -> string[]
	const get = (id) => held.get(id) || [];
	const changed = (id) => emit(id, [...get(id)]);

	return {
		list: (id) => [...get(id)],
		// Clear first so Pi doesn't start the queued messages when the run is aborted, then abort.
		async stop(id) {
			const cleared = await request(id, "clear_queue");
			const q = cleared?.data || {};
			const items = [...(q.steering || []), ...(q.followUp || [])].filter((s) => typeof s === "string" && s);
			if (items.length) {
				held.set(id, [...get(id), ...items]);
				changed(id);
			}
			await request(id, "abort", {}, 120_000);
			return { held: items.length };
		},
		// Removes and returns the text. expectedText guards against the other side having changed the list meanwhile.
		take(id, index, expectedText) {
			const list = get(id);
			if (!Number.isInteger(index) || index < 0 || index >= list.length || (expectedText !== undefined && list[index] !== expectedText)) {
				return { error: "That message is gone or has moved", status: 409 };
			}
			const [text] = list.splice(index, 1);
			if (list.length) held.set(id, list);
			else held.delete(id);
			changed(id);
			return { text };
		},
		clear(id) {
			if (held.delete(id)) changed(id);
		},
	};
}

module.exports = { createHeldQueue };
