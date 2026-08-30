# colossal-cave-wasi

Crowther and Woods' *Colossal Cave Adventure* compiled to a WebAssembly
component and played in the browser over **WASI Preview 3** — the version of
WASI where standard I/O is a pair of component-model `stream<u8>` values
rather than `fd_read`/`fd_write` on descriptors 0 and 1.

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
┌──────────────────────────────────────────────────────────┐
│  adventure.component.wasm                                │
│  open-adventure 1.22, clang --target=wasm32-wasip3       │
│  imports wasi:cli/{stdin,stdout,stderr}@0.3.0            │
│  exports wasi:cli/run@0.3.0                              │
└──────────────────────────────────────────────────────────┘
                          │  jco transpile
                          ▼
┌──────────────────────────────────────────────────────────┐
│  web/vendor/adventure/adventure.js  (generated bindings)  │
│  stream<u8>  ->  async iterable of Uint8Array            │
│  future<T>   ->  Promise                                  │
│  suspension  ->  WebAssembly.Suspending (JSPI)            │
└──────────────────────────────────────────────────────────┘
                          │  --map
                          ▼
┌──────────────────────────────────────────────────────────┐
│  web/host/*.js   the WASI 0.3 host, ~200 lines            │
│  web/terminal.js DOM transcript + input line              │
└──────────────────────────────────────────────────────────┘
```

## Build and play

Needs [wasi-sdk 34](https://github.com/WebAssembly/wasi-sdk/releases) (for the
`wasm32-wasip3` sysroot), Node 20+, Python 3 with PyYAML, and a browser with
JSPI — Chrome or Edge 137+, or Firefox with
`javascript.options.wasm_js_promise_integration` set.

```sh
npm install
make                     # component + transpiled bindings
make serve               # http://localhost:8080
```

If wasi-sdk is somewhere else, pass it: `make WASI_SDK=/path/to/wasi-sdk-34.0`.

```sh
make check               # play through a few turns in headless Chromium
make native              # the same sources as a host binary, for comparison
```

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

**The host.**  `web/host/` implements the imported interfaces against browser
APIs, and the Makefile points jco's `--map` at them instead of
`@bytecodealliance/preview3-shim` (whose browser build is still stubs).  The
whole of stdio is two async functions:

```js
// wasi:cli/stdin@0.3.0
//   read-via-stream: func() -> tuple<stream<u8>, future<result<_, error-code>>>
readViaStream() {
    const { chunks, ended } = currentSession().stdin();
    return [chunks, ended.then(() => ({ tag: 'ok', val: undefined }))];
}
```

`chunks` is an async generator that yields typed input and otherwise awaits a
promise resolved by the submit handler.  That await is the suspension point:
`web/host/session.js` is where the game stops and the page keeps running.

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
rather than in the component or in wasi-libc.  `web/host/wasi-filesystem.js`
has the details and is where a browser-backed directory would go.

**Preview 3 is young.**  wasi-sdk 34, jco 1.32.1 and `@bytecodealliance/preview3-shim`
0.5.0 are all recent, `--async-mode` is still marked experimental in jco, and
the pinned versions are the ones this was built and tested against.

## Layout

```
vendor/open-adventure/   upstream game sources (BSD-2-Clause), unmodified
src/wasi-shim/           readline() and isatty() for the WASI build
web/host/                the WASI 0.3 host: streams, clocks, exit, terminals
web/                     the page: terminal widget, styles, boot
test/play.test.mjs       plays the game in headless Chromium
scripts/serve.js         static server for web/
```

## Licences

The game is BSD-2-Clause, © 1977, 2005 Will Crowther and Don Woods, with
later work by Eric S. Raymond and contributors; see
`vendor/open-adventure/COPYING`.  The port — the shim, the host and the page —
is under the same licence, in `LICENSE`.
