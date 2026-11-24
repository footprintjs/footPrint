/**
 * The order desk's command line, as a function. It takes exactly one
 * argument, the path of a JSON file whose `order` member is the order.
 *
 * Exit codes: 0 with the result on standard output (held, rejected and review
 * are outcomes, not errors); 1 with a message on standard error when the file
 * cannot be read, is not JSON, or the order is refused; 2 with a usage line
 * when the argument is missing.
 *
 * It returns what to print instead of touching `process`, so it can be tested
 * directly; `run-order.mjs` does the printing.
 */
import { readFileSync } from 'node:fs';
import { formatResult, runOrder, toResult } from './order-desk.mjs';
import { OrderRefusal } from './refusal.mjs';

/** The one-line usage message. */
export const USAGE = 'usage: node src/run-order.mjs <order-file.json>';

/**
 * Runs the desk on its command-line arguments.
 *
 * @param {string[]} args the arguments after the script name
 * @returns {{ stdout: string, stderr: string, code: number }}
 */
export function main(args) {
  // A missing argument is a usage error (exit 2); more than one is treated
  // the same way, since the desk takes exactly one.
  if (args.length !== 1) return { stdout: '', stderr: `${USAGE}\n`, code: 2 };

  let input;
  try {
    input = JSON.parse(readFileSync(args[0], 'utf8'));
  } catch (error) {
    return { stdout: '', stderr: `cannot read order file ${args[0]}: ${error.message}\n`, code: 1 };
  }

  try {
    return { stdout: formatResult(toResult(runOrder(input))), stderr: '', code: 0 };
  } catch (error) {
    // Only a refusal is an expected outcome; anything else is a bug and must
    // keep its stack trace.
    if (error instanceof OrderRefusal) return { stdout: '', stderr: `${error.message}\n`, code: 1 };
    throw error;
  }
}
