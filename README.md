# colossal-cave-wasi

Crowther and Woods' *Colossal Cave Adventure* compiled to a WebAssembly
component and played over **WASI Preview 3** — the version of WASI where
standard I/O is a pair of component-model `stream<u8>` values rather than
`fd_read`/`fd_write` on descriptors 0 and 1.

Two builds of the same C, so there is nothing to opt out of: a **WASI Preview
3 component** where the browser can drive it, and a **Preview 1 module** driven
by Asyncify where it cannot — Safari, anything on iOS, older Node.  The page
picks one and says which it got.  Once GitHub Pages is switched
on for this repository (Settings → Pages → Source: GitHub Actions), every push
to `main` publishes the browser build to
`https://jvanbuel.github.io/colossal-cave-wasi/`.

The interesting part is what *isn't* here.  A C program that blocks on a line
of input has always been the awkward case for the browser: the usual answers
are [Asyncify](https://emscripten.org/docs/porting/asyncify.html), which
rewrites the module to unwind and rewind its own stack, or a web worker that
parks on `Atomics.wait` and talks to the page over `SharedArrayBuffer`.  With
Preview 3 the component's call into `wasi:cli/stdin` is an async import: it
suspends, control returns to the browser's event loop, and it resumes when a
`keydown` handler pushes a line in.  There is no Asyncify pass, no worker, and
no `SharedArrayBuffer` — so no cross-origin isolation headers either.

```
              ┌───────────────────────────────────────┐
              │ vendor/open-adventure + src/wasi-shim │
              │ one set of C sources                  │
              └───────────────────────────────────────┘
                     │                 │
                     ▼                 ▼
┌────────────────────────────────┐      ┌──────────────────────────────┐
│ clang --target=wasm32-wasip3   │      │ clang --target=wasm32-wasip1 │
│ a component; jco transpile     │      │ wasm-opt --asyncify          │
│ dist/adventure.js + .core.wasm │      │ dist/adventure.p1.wasm       │
└────────────────────────────────┘      └──────────────────────────────┘
                     │                 │
                     └────────┬────────┘
                              ▼
        ┌───────────────────────────────────────────┐
        │ host/start.js  — JSPI? component : module │
        │ host/session.js — one queue, both hosts   │
        └───────────────────────────────────────────┘
                     │                 │
                     ▼                 ▼
        ┌─────────────┐           ┌──────────────────┐
        │ web/        │           │ cli/adventure.js │
        │ browser tab │           │ terminal         │
        └─────────────┘           └──────────────────┘
```

`host/` does not know which one it is running under.  A `Session` takes lines
in and hands output back; the browser fills it from an `<input>` and paints
into a `<div>`, the CLI fills it from `process.stdin` and writes to
`process.stdout`, and the WASI interface modules are the same either way.

## Build

Needs [wasi-sdk 34](https://github.com/WebAssembly/wasi-sdk/releases) (for the
`wasm32-wasip3` sysroot), Node 20+, and Python 3 with PyYAML.

```sh
npm install
make                     # component in build/, JS bindings in dist/
```

If wasi-sdk is somewhere else, pass it: `make WASI_SDK=/path/to/wasi-sdk-34.0`.

## Play

**In a browser.**  Where there is JSPI — `WebAssembly.Suspending` — the page
runs the component build; otherwise it runs the Preview 1 one, which needs
nothing beyond WebAssembly itself.  Add `?engine=preview1` to force the
fallback on a browser that could manage either.

Tested on Chromium 141 and Firefox 153, each on both builds, with JSPI removed
for the fallback runs so nothing can quietly leak through.  Safari and iOS are
what the fallback is for and are the untested case: Playwright's WebKit will
not launch here.  Android Chrome plays fine; the page keeps its input live
between turns so the on-screen keyboard stays put.

If the page cannot start at all — modules that will not load or parse — a
plain ES5 reporter in `index.html` says so rather than leaving the screen
blank.

```sh
make serve               # http://localhost:8080
```

**In a terminal, under Node.**  Any Node: 24 and up drives the component
through JSPI, older ones fall back to the Preview 1 build.

```sh
make play
node cli/adventure.js                        # once dist/ is built
ADVENTURE_ENGINE=preview1 node cli/adventure.js   # force the fallback
```

**In a terminal, without Node.**  The component is a plain WASI 0.3 command,
so any host that speaks Preview 3 can run it — no JavaScript involved:

```sh
make wasmtime                                  # or, by hand:
wasmtime run build/adventure.component.wasm
```

Needs wasmtime 46 or newer, which takes it as it is.  45 wants
`-W component-model-async` and still rejects it; 43 and earlier speak an
older draft of `wasi:cli@0.3.0` and fail on `get-arguments`.

## Tests

```sh
make check                        # everything below
make check-session                # the queue both hosts share
make check-browser                # the page, on the build it chooses
make check-preview1               # the page again, with JSPI taken away
make check-cli                    # the terminal, on every build this Node runs
make check-site                   # the page, against the published tree
make native                       # the same sources as a host binary
```

Each of those plays a few turns of the actual game.  `BROWSER=firefox` runs
the browser ones against Firefox instead, which CI does as well.  The terminal
test runs whichever builds the Node in front of it can manage, and says which.
Set `CHROME_PATH` if Playwright should use a Chromium other than its own.

## Publishing

`make site` assembles `_site/`: the repository's own `web/`, `dist/` and
`host/`, plus a root `index.html` that redirects into `web/`.  Keeping the
shape means the published tree is the one the tests already run against —
`make check-site` is the browser test pointed at `_site` — rather than a
rearranged copy that could break in ways nothing exercises.

`.github/workflows/pages.yml` builds that on every push to `main`, plays the
game in a real browser before publishing anything, and deploys.  It needs
Pages switched on once, by hand: **Settings → Pages → Build and deployment →
Source: GitHub Actions**.  Until then the workflow runs and fails at the
deploy step.

## How it fits together

**The component.**  `clang --target=wasm32-wasip3` links against the Preview 3
sysroot and emits a component directly — the `wasm-tools component new
--adapt wasi_snapshot_preview1.command.wasm` step that Preview 1 modules need
does not apply here; there is no preview1 module and no adapter.  `jco wit
build/adventure.component.wasm` prints the resulting world.

**The shim.**  Two small files in `src/wasi-shim` are all the game needed:

- `readline.c` stands in for libedit.  Line editing and history belong to the
  host now — the page has an `<input>` — so `readline()` is a prompt, an
  `fflush`, and `fgets`.
- `tty.c` defines `isatty()`.  wasi:cli's streams have no terminal attached,
  so libc says "not a tty", and the game reads that as "input is a script" and
  echoes every command before acting on it — which double-prints each line in
  a terminal that already shows what you typed.  The page *is* an interactive
  terminal, so this answers truthfully.

The game's own sources are unmodified.

**The hosts.**  `host/` implements both sides.  For Preview 3 the Makefile
points jco's `--map` at these modules instead of
`@bytecodealliance/preview3-shim` (whose browser build is still stubs), and
the whole of stdio is two async functions:

```js
// wasi:cli/stdin@0.3.0
//   read-via-stream: func() -> tuple<stream<u8>, future<result<_, error-code>>>
readViaStream() {
    const { chunks, ended } = currentSession().stdin();
    return [chunks, ended.then(() => ({ tag: 'ok', val: undefined }))];
}
```

`chunks` is an async generator that yields typed input and otherwise awaits a
promise — resolved by the page's submit handler, or by a `data` event on
`process.stdin`.  That await is the suspension point: `host/session.js` is
where the game stops and the rest of the program keeps running.

For Preview 1 there is no suspension to lean on: `fd_read` is an ordinary call
that has to come back with bytes.  `host/wasi-preview1.js` gets around that
with Asyncify, which rewrites the module so it can unwind its own call stack
into linear memory and rewind back into it later.  `fd_read`, finding no
input, starts an unwind and returns; the unwind propagates out through
`_start`; the host waits for the player; then it starts a rewind and calls
`_start` again, and execution reappears inside `fd_read` as though it had
never left.

Only the call path that reaches `fd_read` is instrumented — that is what
`--pass-arg=asyncify-imports@wasi_snapshot_preview1.fd_read` buys — so the
rewrite costs 3% of the module rather than the doubling Asyncify is usually
blamed for:

| | Preview 3 | Preview 1 |
|---|---|---|
| module | 727 KB | 503 KB |
| bindings | 489 KB of generated JS | 250 lines, hand-written |
| needs | JSPI | WebAssembly |

Asyncify writes the unwound frames without checking the bounds it was handed,
so an overflow would quietly corrupt whatever came next.  The deepest unwind
measured over a long walk through the cave is 332 bytes; the host gives it two
pages and fails loudly well before that is spent.

Both builds end up talking to the same `Session`, which is why the page and
the CLI do not know which one they got.  Preview 1 reaches into its input
queue where Preview 3 iterates it — the same bytes either way.

## Known gaps

**SAVE and RESUME are compiled out** (`-DADVENT_NOSAVE`), so they answer with
the game's own "Save and resume are disabled."  They go through `fopen()`, and
the browser has no filesystem; a localStorage-backed one is the obvious
substitute, and the descriptor surface the component imports is small enough
to implement — seven methods.  It does not work with jco 1.32.1: an async host
import that returns a *resource* never delivers the handle to the guest, so
the first `descriptor.open-at` hands libc a dangling descriptor and the
component traps in `fclose()`.  The same component saves and resumes correctly
under `wasmtime run --dir .` (48.0.0), so the gap is in the JS host bindings
rather than in the component or in wasi-libc.  `host/wasi-filesystem.js` has
the details and is where a browser-backed directory would go.

**Preview 3 is young.**  wasi-sdk 34, jco 1.32.1 and `@bytecodealliance/preview3-shim`
0.5.0 are all recent, `--async-mode` is still marked experimental in jco, and
the pinned versions are the ones this was built and tested against.

## Layout

```
vendor/open-adventure/   upstream game sources (BSD-2-Clause), unmodified
src/wasi-shim/           readline() and isatty() for the WASI build
host/                    the WASI 0.3 host: streams, clocks, exit, terminals
web/                     the page: terminal widget, styles, boot
cli/adventure.js         the terminal host
host/wasi-preview1.js    the Asyncify host, for browsers without JSPI
host/start.js            picks a build and runs it
dist/                    generated: both builds
_site/                   generated: the tree published to GitHub Pages
test/                    plays the game in Chromium, and in a terminal
scripts/serve.js         static server for local play and for the tests
```

## Licences

The game is BSD-2-Clause, © 1977, 2005 Will Crowther and Don Woods, with
later work by Eric S. Raymond and contributors; see
`vendor/open-adventure/COPYING`.  The port — the shim, the host and the page —
is under the same licence, in `LICENSE`.
