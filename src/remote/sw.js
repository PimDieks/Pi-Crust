"use strict";
// Push notifications only. No fetch handler and no caching: API data must never be cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The payload is never trusted for navigation: the only thing we take from it is a chat id of the exact shape we issue.
const chatIdOf = (id) => (typeof id === "string" && /^chat-\d{1,9}$/.test(id) ? id : null);

self.addEventListener("push", (event) => {
	let d = {};
	try {
		d = event.data ? event.data.json() : {};
	} catch {
		d = { title: "Pi Crust", body: event.data ? event.data.text() : "" };
	}
	const chatId = chatIdOf(d.chatId);
	event.waitUntil(
		self.registration.showNotification(String(d.title || "Pi Crust"), {
			body: String(d.body || ""),
			tag: chatId || undefined,
			renotify: !!chatId,
			data: { chatId },
			icon: "/icon.png",
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const chatId = chatIdOf((event.notification.data || {}).chatId);
	const url = chatId ? `/#chat=${encodeURIComponent(chatId)}` : "/";
	event.waitUntil(
		(async () => {
			const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = all.find((c) => new URL(c.url).origin === self.location.origin);
			if (open) {
				await open.focus();
				open.postMessage({ open: chatId });
			} else {
				await self.clients.openWindow(url);
			}
		})(),
	);
});
