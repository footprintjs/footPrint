/**
 * The error the desk throws when it refuses an order: a malformed order, an
 * unknown customer, an order with no lines, an unknown item, or more than
 * 1,001 lines.
 *
 * A refusal is not a bug: the command line prints its message alone on
 * standard error and exits with 1. Any other error is a fault in the program
 * and is left to crash with its stack trace.
 */
export class OrderRefusal extends Error {
  /** @param {string} message the text printed on standard error */
  constructor(message) {
    super(message);
    this.name = 'OrderRefusal';
  }
}
