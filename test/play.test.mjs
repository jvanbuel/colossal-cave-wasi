/*
 * End-to-end test: load the page in Chromium, play a few turns, and check the
 * game answered.  Run with `make check`.
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../scripts/serve.js';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';

const server = await serve(0);
const { port } = server.address();
const browser = await chromium.launch({
	executablePath: CHROME,
	args: ['--no-sandbox'],
});

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
const waitForPrompt = () =>
	page.waitForFunction(() => !document.getElementById('command').disabled, null, {
		timeout: 30_000,
	});

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
