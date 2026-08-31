/*
 * End-to-end test for the terminal host: run cli/adventure.js as a child
 * process, play a few turns down its stdin, and check the game answered.
 *
 * Runs once per build this Node can manage: the preview1 one always, and the
 * component too where there is JSPI to drive it (Node 24 and up).
 */

import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli/adventure.js', import.meta.url));

const COMMANDS = ['no', 'in', 'take lamp', 'plugh', 'suspend', 'quit', 'y'];

const ENGINES = ['preview1'];
if (typeof WebAssembly.Suspending === 'function') {
	ENGINES.push('preview3');
} else {
	console.log(
		`# Node ${process.versions.node} has no JSPI, so only the preview1 ` +
			'build is exercised here',
	);
}

let stdout = '';
let stderr = '';
let child;

for (const engine of ENGINES) {
	stdout = '';
	stderr = '';
	child = spawn(process.execPath, [CLI], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ADVENTURE_ENGINE: engine },
	});
	child.stdout.setEncoding('utf8').on('data', (text) => {
		stdout += text;
	});
	child.stderr.setEncoding('utf8').on('data', (text) => {
		stderr += text;
	});

	/* Feed the commands one at a time, each only once the game has printed a
	 * fresh prompt, so this also checks that it comes back and asks for every
	 * one of them. */
	for (const line of COMMANDS) {
		const mark = stdout.length;
		await waitFor(
			() => stdout.length > mark && stdout.endsWith('> '),
			`a prompt before "${line}" (${engine})`,
		);
		child.stdin.write(`${line}\n`);
	}
	child.stdin.end();

	const code = await new Promise((done) => child.on('close', done));
	check(engine, code);
}

console.log('\nall checks passed');

function waitFor(condition, what, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (condition()) {
				resolve();
			} else if (Date.now() > deadline) {
				reject(new Error(`timed out waiting for ${what}\n--- got ---\n${stdout}`));
			} else {
				setTimeout(tick, 20);
			}
		};
		tick();
	});
}

function check(engine, code) {
	const expect = (pattern, what) => {
		assert.match(
			stdout,
			pattern,
			`expected ${what} (${engine})\n--- transcript ---\n${stdout}`,
		);
		console.log(`ok - ${what} (${engine})`);
	};

	expect(/Welcome to Adventure/, 'the welcome banner');
	expect(/standing at the end of a road/, 'the opening location');
	expect(/shiny brass lamp/, 'the well house');
	expect(/Foof/, 'the magic word working');
	expect(/Save and resume are disabled/, 'save and resume disabled');
	expect(/You scored \d+ out of a possible 430/, 'the final score');

	assert.equal(stderr, '', `unexpected output on stderr (${engine}):\n${stderr}`);
	assert.equal(code, 0, `expected a clean exit from ${engine}, got ${code}`);
	console.log(`ok - it exited cleanly (${engine})`);
}
