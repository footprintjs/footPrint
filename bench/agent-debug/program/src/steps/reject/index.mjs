/**
 * reject: the order is refused, because it would take the customer over a limit.
 *
 * Example: → `status = 'rejected'`.
 */

export const purpose = 'Refuse an order that goes over a customer limit.';

/** @param {any} scope */
export function run(scope) {
  scope.status = 'rejected';
  scope.reasons = ['over the credit or order limit'];
}
