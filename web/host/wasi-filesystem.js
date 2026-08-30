/*
 * wasi:filesystem/types@0.3.0 and wasi:filesystem/preopens@0.3.0.
 *
 * The component imports these because wasi-libc links fopen(), not because
 * the game needs a filesystem in the browser: SAVE and RESUME are compiled
 * out with -DADVENT_NOSAVE (see the Makefile) and answer with the game's own
 * "Save and resume are disabled."  Preopening nothing makes any remaining
 * fopen() fail inside libc, before a call reaches this module.
 *
 * A localStorage-backed filesystem is the natural thing to put here instead,
 * and the descriptor surface the component imports is small enough to
 * implement — seven methods.  It does not work with jco 1.32.1: an async host
 * import that returns a resource never delivers the handle to the guest, so
 * the first `descriptor.open-at` hands libc a dangling descriptor and the
 * component traps in fclose().  The same component saves and resumes
 * correctly under `wasmtime run --dir .` (48.0.0), so the gap is in the JS
 * host bindings rather than in the component or in wasi-libc.  When it is
 * fixed, `get-directories` below is where a browser-backed directory goes.
 */

class Descriptor {}

export const types = { Descriptor };

export const preopens = {
	getDirectories() {
		return [];
	},
};
