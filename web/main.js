/*
 * Boot the game: wire a DOM terminal to the component's WASI streams and run
 * it.
 */

import { Terminal } from './terminal.js';
import { ComponentExit, Session, setCurrentSession } from '../host/session.js';

const terminal = new Terminal();

function requireJspi() {
	if (typeof WebAssembly.Suspending === 'function') {
		return true;
	}
	terminal.setStatus('unsupported browser', 'ended');
	terminal.write(
		'This build needs JavaScript Promise Integration (JSPI) to let the ' +
			'component park on a read of stdin without blocking the page.\n\n' +
			'JSPI ships in Chrome and Edge 137 and later. In Firefox, enable ' +
			'javascript.options.wasm_js_promise_integration in about:config.\n',
		'notice',
	);
	return false;
}

async function main() {
	if (!requireJspi()) {
		return;
	}

	const session = new Session({
		onOutput: (text, stream) => terminal.write(text, stream),
		onBlocked: (blocked) => {
			terminal.setAcceptingInput(blocked);
			terminal.setStatus(
				blocked ? 'waiting for your command' : 'running',
				blocked ? 'waiting' : 'running',
			);
		},
	});
	setCurrentSession(session);
	terminal.onLine = (line) => session.sendLine(line);

	/* Loaded here rather than at the top of the module so the JSPI check
	 * runs before the bindings touch WebAssembly.Suspending. */
	const { run } = await import('../dist/adventure.js');

	terminal.setStatus('running', 'running');
	try {
		await run.run();
		finish('the game has ended');
	} catch (err) {
		if (err instanceof ComponentExit || err?.exitError === true) {
			finish(
				err.code === 0
					? 'the game has ended'
					: `the game exited with code ${err.code}`,
			);
			return;
		}
		finish('the component trapped');
		terminal.write(`\n${err?.stack ?? err}\n`, 'stderr');
		throw err;
	}
}

function finish(message) {
	terminal.setAcceptingInput(false);
	terminal.setStatus(message, 'ended');
	terminal.write(`\n[${message} — reload to play again]\n`, 'notice');
}

main();
