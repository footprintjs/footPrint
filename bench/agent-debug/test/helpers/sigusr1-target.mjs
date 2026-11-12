/**
 * Stands in for the harness process: says it is ready, waits, and says it
 * is still alive. signals.test.mjs runs it with and without
 * `--disable-sigusr1` and sends it SIGUSR1 once it is ready.
 */
console.log('ready');
setTimeout(() => console.log('alive'), 1500);
