/*
 * isatty() for the WASI build.
 *
 * wasi:cli's standard streams are plain byte streams with no terminal
 * attached, so wasi-libc reports isatty() == 0 for all three.  The game reads
 * that as "input is a script" and echoes every command back before acting on
 * it, which double-prints each line in a terminal that already shows what the
 * player typed.  We are in fact driving an interactive terminal, so answer
 * truthfully for the standard streams and defer to nothing else: no other fd
 * in this build is a terminal.
 *
 * Defining isatty here overrides the wasi-libc one, which lives in libc.a and
 * is only pulled in when the symbol is still undefined at link time.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

#include <unistd.h>

int isatty(int fd) { return fd == STDIN_FILENO || fd == STDOUT_FILENO || fd == STDERR_FILENO; }
