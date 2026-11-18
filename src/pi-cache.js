// Remembers where Pi was found, until told to look again. A missing Pi is remembered too (a cheap answer for the many
// callers), but `findPi({ fresh: true })` forgets it and looks again: after an install, "Pi not found" must not stay true
// until the app restarts.
"use strict";

function makeFindPi(locate) {
	let cache; // undefined = not looked yet; null = looked, not there
	return function findPi(opts) {
		if (opts && opts.fresh) cache = undefined;
		if (cache === undefined) cache = locate();
		return cache;
	};
}

module.exports = { makeFindPi };
