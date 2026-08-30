# open-adventure (vendored)

The C sources for Colossal Cave Adventure, taken from Eric S. Raymond's
[open-adventure](https://gitlab.com/esr/open-adventure) (release 1.22), which
is in turn Crowther and Woods' Adventure 2.5 restored from the original
sources.  Licensed BSD-2-Clause; see `COPYING`.

Only what the WASI build needs is vendored: the game sources, `advent.h`,
`adventure.yaml` and the `make_dungeon.py` generator that turns it into
`dungeon.c`/`dungeon.h`, and the templates that generator uses.  The upstream
Makefile, test suite, documentation and packaging are not here — run the build
from the repository root instead.

The sources are unmodified.  Everything this port changes lives outside this
directory: `src/wasi-shim` replaces libedit's `readline()` and answers
`isatty()`, and the root `Makefile` drives the wasm32-wasip3 build.
