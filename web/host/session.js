/*
 * The bridge between the DOM and the component's WASI Preview 3 streams.
 *
 * A `Session` owns one run of the game.  The WASI interface modules in this
 * directory are stateless adapters over whichever session is current: jco's
 * generated bindings import them statically, so they cannot be handed a
 * session directly.
 */

/** @type {Session | null} */
let current = null;

/** The session the WASI host modules are currently serving. */
export function currentSession() {
	if (current === null) {
		throw new Error(
			'no active session: call setCurrentSession() before running the component',
		);
	}
	return current;
}

export function setCurrentSession(session) {
	current = session;
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Thrown by wasi:cli/exit to unwind the component. */
export class ComponentExit extends Error {
	exitError = true;

	constructor(code) {
		super(`component exited with code ${code}`);
		this.code = code;
	}
}

export class Session {
	/** Input bytes the game has not consumed yet. */
	#pending = [];
	/** Resolver for a read that is parked waiting on the player. */
	#parked = null;
	#inputClosed = false;
	#encoder = new TextEncoder();
	/* One decoder per output stream: a UTF-8 sequence can be split across
	 * chunks, and a stateful decoder stitches it back together. */
	#decoders = new Map();
	#blocked = false;

	/**
	 * @param {object} handlers
	 * @param {(text: string, stream: 'stdout'|'stderr') => void} handlers.onOutput
	 * @param {(blocked: boolean) => void} [handlers.onBlocked] called when the
	 *   game starts or stops waiting for input
	 */
	constructor({ onOutput, onBlocked } = {}) {
		this.onOutput = onOutput ?? (() => {});
		this.onBlocked = onBlocked ?? (() => {});
	}

	/** True while the component is parked on a read of stdin. */
	get isWaitingForInput() {
		return this.#blocked;
	}

	/** Feed one line typed by the player to the game. */
	sendLine(line) {
		this.send(`${line}\n`);
	}

	/** Feed raw text to the game's stdin. */
	send(text) {
		if (this.#inputClosed) {
			return;
		}
		this.#pending.push(this.#encoder.encode(text));
		this.#wake();
	}

	/** Signal end-of-input; the game sees EOF and exits. */
	closeInput() {
		this.#inputClosed = true;
		this.#wake();
	}

	#wake() {
		const parked = this.#parked;
		this.#parked = null;
		parked?.resolve();
	}

	#setBlocked(blocked) {
		if (this.#blocked !== blocked) {
			this.#blocked = blocked;
			this.onBlocked(blocked);
		}
	}

	/**
	 * stdin as an async iterable of byte chunks, plus a promise that settles
	 * when that iterable is exhausted.
	 *
	 * This is where Preview 3 earns its keep: awaiting here parks the
	 * component's task and returns control to the browser's event loop, so
	 * the page stays responsive while the game waits for a command.  There
	 * is no asyncify pass and no worker blocking on Atomics.wait.
	 */
	stdin() {
		const ended = deferred();
		const self = this;
		async function* chunks() {
			try {
				for (;;) {
					if (self.#pending.length > 0) {
						yield self.#pending.shift();
						continue;
					}
					if (self.#inputClosed) {
						return;
					}
					self.#parked = deferred();
					self.#setBlocked(true);
					await self.#parked.promise;
					self.#setBlocked(false);
				}
			} finally {
				self.#setBlocked(false);
				ended.resolve();
			}
		}
		return { chunks: chunks(), ended: ended.promise };
	}

	/** Called by the stdout/stderr adapters for each chunk the game writes. */
	receive(bytes, stream) {
		let decoder = this.#decoders.get(stream);
		if (decoder === undefined) {
			decoder = new TextDecoder('utf-8');
			this.#decoders.set(stream, decoder);
		}
		const text = decoder.decode(bytes, { stream: true });
		if (text !== '') {
			this.onOutput(text, stream);
		}
	}
}
