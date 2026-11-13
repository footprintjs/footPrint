#!/usr/bin/env node
/**
 * The order desk command:
 *
 *   node src/run-order.mjs <order-file.json>
 *
 * Prints the result and sets the exit code; the work is in `cli.mjs`.
 */
import { main } from './cli.mjs';

const { stdout, stderr, code } = main(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
// exitCode, not exit(): lets a piped standard output finish writing first.
process.exitCode = code;
