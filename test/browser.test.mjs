/*
 * End-to-end test: load the page in Chromium, play a few turns, and check the
 * game answered.  Run with `make check`.
 *
 * SITE_ROOT points it at an assembled site instead of the repository, so
 * `make check-site` runs exactly this against the tree GitHub Pages gets.
 * BROWSER picks the browser (chromium, firefox); ENGINE picks the build
 * (preview3, preview1, or unset to let the page choose); CHROME_PATH overrides
 * the Chromium binary, for environments where Playwright's own download is not
 * the one to use.  SLOW_MODULE delays the page's entry module, which is how a
 * cold CI runner behaves and how the races this file has to survive show up on
 * a fast machine.
 */

import assert from 'node:assert/strict';
import * as playwright from 'playwright';
import { serve } from '../scripts/serve.js';

const ENGINE = process.env.BROWSER ?? 'chromium';
/* Forcing preview1 also removes JSPI, so the run proves the fallback needs
 * nothing the browser might have quietly supplied. */
const BUILD = process.env.ENGINE ?? '';
const server = await serve(0, process.env.SITE_ROOT);
const { port } = server.address();
const browser = await playwright[ENGINE].launch({
	...(process.env.CHROME_PATH && ENGINE === 'chromium'
		? { executablePath: process.env.CHROME_PATH }
		: {}),
	...(ENGINE === 'chromium' ? { args: ['--no-sandbox'] } : {}),
});
console.log(`# ${ENGINE} ${browser.version()}${BUILD ? `, ${BUILD}` : ''}`);

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

if (BUILD === 'preview1') {
	await page.addInitScript(() => {
		delete WebAssembly.Suspending;
	});
}
if (process.env.SLOW_MODULE) {
	await page.route('**/main.js', async (route) => {
		await new Promise((resume) => setTimeout(resume, 1500));
		await route.continue();
	});
}
await page.goto(`http://localhost:${port}/${BUILD ? `web/?engine=${BUILD}` : ''}`);

/* The masthead starts on a placeholder and is filled in once the page has
 * chosen a build, so wait for that rather than reading it straight after the
 * navigation: goto resolves on the redirect page in site mode, and the module
 * behind it takes as long as the machine takes. */
const engineLabel = await page
	.locator('#engine')
	.filter({ hasNotText: 'choosing' })
	.first()
	.textContent({ timeout: 30_000 })
	.catch(async () => {
		throw new Error(
			`the page never named a build; masthead still reads ` +
				`"${await page.locator('#engine').textContent()}"`,
		);
	});
assert.match(
	engineLabel,
	BUILD === 'preview1' ? /asyncify/ : /jspi|asyncify/i,
	'expected the page to name the build it is running',
);

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
console.log(`ok - the ${BUILD === 'preview1' ? 'module' : 'component'} exited cleanly`);

/* On a phone the on-screen keyboard takes half the screen, and what is left
 * has to hold both the prompt and the last thing the game said.  Chromium's
 * visual viewport follows the window, so shrinking it stands in for the
 * keyboard opening. */
{
	const full = page.viewportSize();

	/* Everything this needs to know, measured in the page. */
	const fit = () => ({
		viewport: window.visualViewport.height,
		prompt: document.getElementById('prompt').getBoundingClientRect().bottom,
		/* Distance from the transcript's newest line. */
		fromNewest: (() => {
			const el = document.getElementById('screen');
			return el.scrollHeight - el.scrollTop - el.clientHeight;
		})(),
		pageScroll: document.body.scrollHeight - window.innerHeight,
		statusShown:
			getComputedStyle(document.querySelector('.status')).display !== 'none',
	});
	const settled = (m) =>
		m.prompt <= m.viewport + 1 &&
		m.fromNewest <= 2 &&
		m.pageScroll <= 1 &&
		!m.statusShown;

	await page.setViewportSize({ width: 390, height: 330 });
	/* Wait for the layout to have reacted, not merely for the viewport to
	 * have changed: the page resizes itself from a visualViewport handler, so
	 * asserting on the resize alone races it. */
	await page
		.waitForFunction(
			([fitSrc, settledSrc]) => {
				const measure = new Function(`return (${fitSrc})()`);
				const ok = new Function('m', `return (${settledSrc})(m)`);
				return ok(measure());
			},
			[fit.toString(), settled.toString()],
			{ timeout: 10_000 },
		)
		.catch(async () => {
			const measured = await page.evaluate(fit);
			throw new Error(
				`the keyboard-sized viewport did not settle: ${JSON.stringify(measured)}`,
			);
		});
	console.log('ok - prompt and newest output survive an on-screen keyboard');

	await page.setViewportSize(full);
}

/* A browser with no JSPI at all should still play, on the preview1 build,
 * without being told to go and find another browser. */
const bare = await browser.newPage();
await bare.addInitScript(() => {
	delete WebAssembly.Suspending;
});
await bare.goto(`http://localhost:${port}/`);
await bare
	.locator('#screen')
	.filter({ hasText: /standing at the end of a road|Welcome to Adventure/ })
	.first()
	.waitFor({ timeout: 30_000 });
assert.match(
	await bare.locator('#engine').textContent(),
	/asyncify/,
	'expected a browser without JSPI to fall back to the preview1 build',
);
console.log('ok - a browser without JSPI falls back and plays anyway');
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
