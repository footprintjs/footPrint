/**
 * The scoring child: runs the scored copy's program on each hidden order and
 * prints ONE JSON document of results after a marker line. It computes; it
 * never judges. The expected results never enter this process: they stay in
 * the benchmark folder and the parent compares (harness/score.mjs).
 *
 * Usage (confined, read-only): `node run-orders.mjs <scored copy> <orders file>`.
 * Output: `\n<MARKER>\n{"results":{"<name>":{…}|{"error":"…"}}}\n`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = '\u0000agent-debug-scoring-results\u0000';
const [copy, ordersFile] = process.argv.slice(2);
const orders = JSON.parse(readFileSync(ordersFile, 'utf8'));
const { runOrder } = await import(pathToFileURL(join(copy, 'src', 'order-desk.mjs')).href);
/** @type {Record<string, unknown>} */
const results = {};
for (const [name, order] of Object.entries(orders)) {
  try {
    results[name] = await runOrder(order);
  } catch (error) {
    results[name] = { error: error instanceof Error ? error.message : String(error) };
  }
}
process.stdout.write(`\n${MARKER}\n${JSON.stringify({ results })}\n`);
