/*
 * A WASI Preview 1 host, for browsers without JSPI.
 *
 * Preview 1 has no notion of suspension: fd_read is an ordinary call that has
 * to come back with bytes.  Asyncify gets around that by rewriting the module
 * so it can unwind its own call stack into linear memory and rewind back into
 * it later.  So fd_read, finding no input, starts an unwind and returns; the
 * unwind propagates out through _start; the host waits for the player; then it
 * starts a rewind and calls _start again, and execution reappears inside
 * fd_read as though it had never left.
 *
 * Only the call path that reaches fd_read is instrumented (see the Makefile's
 * asyncify-imports argument), which is why the rewrite costs about 3% of the
 * module rather than the doubling Asyncify is usually blamed for.
 *
 * The session this drives is the same one the Preview 3 host uses; it just
 * reaches into the input queue rather than iterating it.
 */

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_SPIPE = 70;
const ERRNO_NOTCAPABLE = 76;
const FILETYPE_CHARACTER_DEVICE = 2;

const PAGE = 65536;
/* Room for the unwound stack.  The deepest unwind measured over a long walk
 * through the cave was 332 bytes -- the chain from _start down to fd_read is
 * short -- so two pages is a few hundred times the headroom needed, and
 * checkStack below turns anything approaching it into a clear error rather
 * than quiet corruption. */
const STACK_PAGES = 2;

const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;

/** Thrown by proc_exit to unwind out of the guest. */
export class ExitError extends Error {
	exitError = true;

	constructor(code) {
		super(`the game exited with code ${code}`);
		this.code = code;
	}
}

/**
 * @param {WebAssembly.Module} module an asyncified wasm32-wasip1 command
 * @param {import('./session.js').Session} session
 * @returns {Promise<{run: () => Promise<number>}>}
 */
export async function instantiate(module, session) {
	/** running | unwinding | rewinding */
	let state = 'running';
	let memory;
	let exports;
	let stack = { data: 0, start: 0, end: 0 };

	const view = () => new DataView(memory.buffer);
	const bytes = () => new Uint8Array(memory.buffer);

	/** Read an iovec array into [{ptr, len}, ...]. */
	function iovecs(ptr, count) {
		const data = view();
		const out = [];
		for (let i = 0; i < count; i++) {
			out.push({
				ptr: data.getUint32(ptr + i * 8, true),
				len: data.getUint32(ptr + i * 8 + 4, true),
			});
		}
		return out;
	}

	const preview1 = {
		args_sizes_get(argcPtr, sizePtr) {
			const data = view();
			data.setUint32(argcPtr, 1, true);
			data.setUint32(sizePtr, 'advent\0'.length, true);
			return ERRNO_SUCCESS;
		},

		args_get(argvPtr, bufPtr) {
			view().setUint32(argvPtr, bufPtr, true);
			bytes().set(new TextEncoder().encode('advent\0'), bufPtr);
			return ERRNO_SUCCESS;
		},

		/* id 0 is the realtime clock, anything else a monotonic one. */
		clock_time_get(id, precision, resultPtr) {
			const ms = id === 0 ? Date.now() : performance.now();
			view().setBigUint64(resultPtr, BigInt(Math.round(ms * 1e6)), true);
			return ERRNO_SUCCESS;
		},

		fd_fdstat_get(fd, resultPtr) {
			if (fd > STDERR) {
				return ERRNO_BADF;
			}
			const data = view();
			data.setUint8(resultPtr, FILETYPE_CHARACTER_DEVICE);
			data.setUint16(resultPtr + 2, 0, true);
			data.setBigUint64(resultPtr + 8, 0n, true);
			data.setBigUint64(resultPtr + 16, 0n, true);
			return ERRNO_SUCCESS;
		},

		fd_fdstat_set_flags: () => ERRNO_SUCCESS,
		fd_close: () => ERRNO_SUCCESS,
		/* A terminal is not seekable. */
		fd_seek: () => ERRNO_SPIPE,
		/* Nothing is preopened, so libc fails paths before asking us to open
		 * one; SAVE and RESUME are compiled out either way. */
		fd_prestat_get: () => ERRNO_BADF,
		fd_prestat_dir_name: () => ERRNO_BADF,
		path_open: () => ERRNO_NOTCAPABLE,

		fd_write(fd, iovsPtr, iovsLen, writtenPtr) {
			if (fd !== STDOUT && fd !== STDERR) {
				return ERRNO_BADF;
			}
			let written = 0;
			for (const { ptr, len } of iovecs(iovsPtr, iovsLen)) {
				if (len > 0) {
					/* Copy rather than view: the session holds on to this
					 * past the next time memory grows. */
					session.receive(
						bytes().slice(ptr, ptr + len),
						fd === STDOUT ? 'stdout' : 'stderr',
					);
					written += len;
				}
			}
			view().setUint32(writtenPtr, written, true);
			return ERRNO_SUCCESS;
		},

		fd_read(fd, iovsPtr, iovsLen, readPtr) {
			if (fd !== STDIN) {
				return ERRNO_BADF;
			}
			if (state === 'rewinding') {
				/* Back from an unwind: the input we parked for is here. */
				exports.asyncify_stop_rewind();
				state = 'running';
			} else if (!session.hasInput() && !session.isInputClosed) {
				state = 'unwinding';
				exports.asyncify_start_unwind(stack.data);
				/* The return value is discarded: the guest is unwinding, and
				 * this call gets made again after the rewind. */
				return ERRNO_SUCCESS;
			}

			let read = 0;
			for (const { ptr, len } of iovecs(iovsPtr, iovsLen)) {
				const chunk = session.takeInput(len);
				if (chunk === null) {
					break;
				}
				bytes().set(chunk, ptr);
				read += chunk.length;
				if (chunk.length < len) {
					break;
				}
			}
			/* read === 0 with input closed is end of file, which is how the
			 * game learns the player has gone. */
			view().setUint32(readPtr, read, true);
			return ERRNO_SUCCESS;
		},

		proc_exit(code) {
			throw new ExitError(code);
		},
	};

	const instance = await WebAssembly.instantiate(module, {
		wasi_snapshot_preview1: preview1,
	});
	exports = instance.exports;
	memory = exports.memory;

	/* Put the unwound stack in pages of our own past everything the program
	 * knows about, so it cannot collide with the heap. */
	const base = memory.grow(STACK_PAGES) * PAGE;
	stack = { data: base, start: base + 8, end: base + STACK_PAGES * PAGE };
	const data = view();
	data.setUint32(stack.data, stack.start, true);
	data.setUint32(stack.data + 4, stack.end, true);

	/* Asyncify writes the unwound frames without checking the bounds it was
	 * given, so an overflow would quietly corrupt whatever came next.  The
	 * high-water mark says how close it came; a loud failure beats that. */
	function checkStack() {
		const used = view().getUint32(stack.data, true) - stack.start;
		const size = stack.end - stack.start;
		if (used > size * 0.75) {
			throw new Error(
				`asyncify stack nearly exhausted (${used} of ${size} bytes); ` +
					'raise STACK_PAGES in host/wasi-preview1.js',
			);
		}
		return used;
	}

	let deepest = 0;

	return {
		/** The most asyncify stack any one unwind has needed, in bytes. */
		get deepestUnwind() {
			return deepest;
		},

		/** Runs to completion, resolving with the game's exit code. */
		async run() {
			for (;;) {
				try {
					exports._start();
				} catch (err) {
					if (err instanceof ExitError) {
						return err.code;
					}
					throw err;
				}
				if (state !== 'unwinding') {
					/* _start returned of its own accord: main() is done. */
					return 0;
				}
				exports.asyncify_stop_unwind();
				deepest = Math.max(deepest, checkStack());
				state = 'running';
				await session.waitForInput();
				state = 'rewinding';
				exports.asyncify_start_rewind(stack.data);
			}
		},
	};
}
