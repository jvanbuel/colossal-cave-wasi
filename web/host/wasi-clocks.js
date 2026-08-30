/*
 * wasi:clocks/monotonic-clock@0.3.0 and wasi:clocks/system-clock@0.3.0.
 */

const NS_PER_MS = 1_000_000n;

/* performance.timeOrigin lets the monotonic clock keep counting sensibly
 * across the page's lifetime without leaking wall-clock time. */
export const monotonicClock = {
	now() {
		return BigInt(Math.round(performance.now() * 1e6));
	},
	getResolution() {
		/* performance.now() is clamped to ~5µs in most browsers. */
		return 5_000n;
	},
	async waitFor(howLong) {
		const ms = Number(howLong / NS_PER_MS);
		await new Promise((resolve) => setTimeout(resolve, ms));
	},
	async waitUntil(when) {
		const ms = Number((when - monotonicClock.now()) / NS_PER_MS);
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
	},
};

export const systemClock = {
	now() {
		const ms = Date.now();
		return {
			seconds: BigInt(Math.floor(ms / 1000)),
			nanoseconds: (ms % 1000) * 1e6,
		};
	},
	getResolution() {
		return { seconds: 0n, nanoseconds: 1e6 };
	},
};

export const types = {};
