/*
 * Pick a way to run the game and run it.
 *
 * There are two builds of the same C sources in dist/, and which one can run
 * depends on the browser or the Node in front of us:
 *
 *   preview3  the WebAssembly component, driven through jco's bindings.  Needs
 *             JSPI, so it is Chrome, Edge, Firefox or Node 24 and up.
 *   preview1  a core module rewritten by Asyncify, driven by our own host.
 *             Needs nothing beyond WebAssembly, which is what makes it the
 *             fallback for Safari, for anything on iOS, and for older Node.
 *
 * Both end up talking to the same Session, so nothing above this line has to
 * know which one it got.
 */

import { ComponentExit, currentSession, setCurrentSession } from './session.js';

/** True where the component build can run. */
export function hasJspi() {
	return typeof WebAssembly.Suspending === 'function';
}

/** Which build `start` would use: 'preview3' or 'preview1'. */
export function chooseEngine() {
	return hasJspi() ? 'preview3' : 'preview1';
}

async function loadModule(url) {
	if (url.protocol === 'file:') {
		/* Node: fetch does not read file URLs.  The browser never gets here,
		 * so the import is inside the branch. */
		const { readFile } = await import('node:fs/promises');
		return WebAssembly.compile(await readFile(url));
	}
	return WebAssembly.compileStreaming(fetch(url));
}

async function startPreview3() {
	const { run } = await import('../dist/adventure.js');
	try {
		await run.run();
		return 0;
	} catch (err) {
		if (err instanceof ComponentExit || err?.exitError === true) {
			return err.code;
		}
		throw err;
	}
}

async function startPreview1(session) {
	const [{ instantiate }, module] = await Promise.all([
		import('./wasi-preview1.js'),
		loadModule(new URL('../dist/adventure.p1.wasm', import.meta.url)),
	]);
	const { run } = await instantiate(module, session);
	return run();
}

/**
 * Run the game against `session`, resolving with its exit code.
 *
 * @param {import('./session.js').Session} session
 * @param {{engine?: 'preview1'|'preview3'}} [options] to force a build,
 *   which the tests use to exercise both on one machine
 */
export async function start(session, { engine = chooseEngine() } = {}) {
	setCurrentSession(session);
	if (engine === 'preview3') {
		if (!hasJspi()) {
			throw new Error('the preview3 build needs JSPI');
		}
		return startPreview3();
	}
	return startPreview1(currentSession());
}
