/*
 * End-to-end test: load the page in Chromium, play a few turns, and check the
 * game answered.  Run with `make check`.
 *
 * SITE_ROOT points it at an assembled site instead of the repository, so
 * `make check-site` runs exactly this against the tree GitHub Pages gets.
 * BROWSER picks the engine (chromium, firefox, webkit); CHROME_PATH overrides
 * the Chromium binary, for environments where Playwright's own download is not
 * the one to use.
 */

import assert from 'node:assert/strict';
import * as playwright from 'playwright';
import { serve } from '../scripts/serve.js';

const ENGINE = process.env.BROWSER ?? 'chromium';
const server = await serve(0, process.env.SITE_ROOT);
const { port } = server.address();
const browser = await playwright[ENGINE].launch({
	...(process.env.CHROME_PATH && ENGINE === 'chromium'
		? { executablePath: process.env.CHROME_PATH }
		: {}),
	...(ENGINE === 'chromium' ? { args: ['--no-sandbox'] } : {}),
});
console.log(`# ${ENGINE} ${browser.version()}`);

let failures = 0;
const page = await browser.newPage();
page.on('pageerror', (err) => {
	failures++;
	console.error('page error:', err);
});
page.on('console', (msg) => {
	if (msg.type() === 'error') {
		failures++;
		console.error('console error:', msg.text());
	}
});

const transcript = () => page.locator('#screen').innerText();
/* The status light, not the input, says whether the game is waiting: the
 * input stays enabled so that typing ahead works. */
const waitForPrompt = () =>
	page.waitForFunction(
		() => document.getElementById('light').dataset.state === 'waiting',
		null,
		{ timeout: 30_000 },
	);

async function command(text) {
	await waitForPrompt();
	await page.fill('#command', text);
	await page.press('#command', 'Enter');
}

async function expectOutput(pattern, what) {
	await page
		.locator('#screen')
		.filter({ hasText: pattern })
		.first()
		.waitFor({ timeout: 30_000 })
		.catch(async () => {
			throw new Error(
				`expected ${what} in transcript, got:\n${await transcript()}`,
			);
		});
	console.log(`ok - ${what}`);
}

await page.goto(`http://localhost:${port}/`);

/* The game opens by asking whether you want instructions. */
await expectOutput(/Welcome to Adventure/, 'the welcome banner');
await waitForPrompt();
console.log('ok - stdin parked and the page handed control back');

await command('no');
await expectOutput(/standing at the end of a road/, 'the opening location');

await command('in');
await expectOutput(/inside a building/, 'the well house');

await command('take lamp');
await command('plugh');
await expectOutput(/Foof/, 'the magic word working');

/* Typing ahead is the terminal's job: two commands with no wait between them
 * should both land, in order, because the session queues whatever arrives
 * before the game asks for it. */
await waitForPrompt();
await page.fill('#command', 'inventory');
await page.press('#command', 'Enter');
await page.fill('#command', 'score');
await page.press('#command', 'Enter');
await expectOutput(/Brass lantern/, 'the first of two commands typed ahead');
await expectOutput(/You have garnered/, 'the second of two commands typed ahead');

/* SAVE/RESUME are compiled out for the browser; the game should say so
 * rather than fail on a filesystem that isn't there. */
await command('suspend');
await expectOutput(/Save and resume are disabled/, 'save and resume disabled');

await command('quit');
await expectOutput(/Do you really want to quit/, 'the quit confirmation');

await command('y');
await expectOutput(/You scored/, 'the final score');
await page.waitForFunction(
	() => document.getElementById('light').dataset.state === 'ended',
	null,
	{ timeout: 30_000 },
);
console.log('ok - the component exited cleanly');

/* What a browser without JSPI gets: an explanation, not a stack trace.  The
 * page checks before it touches the bindings, so remove the constructor and
 * the check should fire. */
const bare = await browser.newPage();
await bare.addInitScript(() => {
	delete WebAssembly.Suspending;
});
await bare.goto(`http://localhost:${port}/`);
await bare
	.locator('#screen')
	.filter({ hasText: /no JavaScript Promise Integration/ })
	.first()
	.waitFor({ timeout: 30_000 });
assert.equal(
	await bare.locator('#light').getAttribute('data-state'),
	'ended',
	'expected the status light to show an unsupported browser',
);
assert.ok(
	await bare.locator('#command').isDisabled(),
	'expected the input to stay disabled when there is no game to type at',
);
console.log('ok - a browser without JSPI is told why');
await bare.close();

/* And what a browser that cannot run main.js at all gets — one too old to
 * parse it, or a half-deployed site: the same explanation from the plain-ES5
 * reporter in the page, rather than a blank screen. */
for (const [what, handler] of [
	['a script that will not load', (route) => route.abort()],
	[
		'a script this browser cannot parse',
		(route) =>
			route.fulfill({
				contentType: 'text/javascript',
				body: 'class T { #x = 1; static { throw 0 } } await 1;;;(',
			}),
	],
]) {
	const broken = await browser.newPage();
	await broken.route('**/main.js', handler);
	await broken.goto(`http://localhost:${port}/`);
	await broken
		.locator('#screen')
		.filter({ hasText: /This page could not start/ })
		.first()
		.waitFor({ timeout: 30_000 })
		.catch(() => {
			throw new Error(`expected an explanation for ${what}`);
		});
	assert.equal(
		await broken.locator('#status-text').textContent(),
		'could not start',
		'expected the status line to report the failure',
	);
	console.log(`ok - ${what} says so instead of going blank`);
	await broken.close();
}

const text = await transcript();
assert.match(text, /brass lamp/, 'expected the well house inventory');
assert.doesNotMatch(text, /Can't open file/, 'unexpected filesystem failure');

/* isatty() reports a terminal, so the game must not echo commands back on
 * top of the ones the page already printed. */
const echoes = text.match(/take lamp/g) ?? [];
assert.equal(echoes.length, 1, `command echoed ${echoes.length} times`);
console.log('ok - commands are echoed exactly once');

await browser.close();
server.close();

if (failures > 0) {
	console.error(`\n${failures} page error(s)`);
	process.exit(1);
}
console.log('\nall checks passed');
