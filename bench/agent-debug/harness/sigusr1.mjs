/**
 * The harness runs with Node's `--disable-sigusr1` (RULE.md 1.4, rule 8).
 *
 * Why: on POSIX, SIGUSR1 makes a Node process open its debugger on
 * 127.0.0.1:9229. The harness is unconfined and holds the API key; if any
 * process could send it SIGUSR1 and then reach that port, it could run code
 * inside the harness. With `--disable-sigusr1` the signal opens nothing.
 *
 * How it is detected: Node gives no API that reports the flag back, so the
 * harness reads where the flag can come from: its own command line
 * (`process.execArgv`) or `NODE_OPTIONS`. `run.mjs` refuses to start a batch
 * when neither holds it.
 *
 * Measured on Node 24 (test/signals.test.mjs): with the flag, a SIGUSR1 sent
 * to the process neither opens the debugger nor ends the process; it is
 * ignored. Without the flag, Node tries to open the debugger.
 * Example: `node --disable-sigusr1 harness/run.mjs --rehearse --out <folder>`.
 */

export const FLAG = '--disable-sigusr1';

/** Whether this process runs with SIGUSR1's debugger disabled. */
export function sigusr1Disabled() {
  if (process.execArgv.includes(FLAG)) return true;
  const options = (process.env.NODE_OPTIONS ?? '').split(/\s+/);
  return options.includes(FLAG);
}
