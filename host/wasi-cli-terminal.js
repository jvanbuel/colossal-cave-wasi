/*
 * wasi:cli/terminal-* @0.3.0.
 *
 * The terminal resources carry no methods in WASI 0.3 — they exist so a
 * component can ask "is this stream attached to a terminal?".  Handing back
 * live handles is the truthful answer here: the page really is a terminal.
 */

class TerminalInput {}
class TerminalOutput {}

const theInput = new TerminalInput();
const theOutput = new TerminalOutput();

export const terminalInput = { TerminalInput };
export const terminalOutput = { TerminalOutput };
export const terminalStdin = { getTerminalStdin: () => theInput };
export const terminalStdout = { getTerminalStdout: () => theOutput };
export const terminalStderr = { getTerminalStderr: () => theOutput };
