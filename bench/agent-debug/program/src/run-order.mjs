/**
 * Command line: runs the desk on one fixture file and prints the result as JSON.
 *
 * Example: `node src/run-order.mjs fixtures/small-pickup.json`
 */
import { readFile } from 'node:fs/promises';

import { runOrder } from './order-desk.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/run-order.mjs <fixture.json>');
  process.exit(2);
}
const fixture = JSON.parse(await readFile(file, 'utf8'));
const result = await runOrder(fixture.order);
console.log(JSON.stringify(result, null, 2));
