/**
 * approve: the order goes through.
 *
 * Example: → `status = 'approved'`, `reasons = []`.
 */

export const purpose = 'Mark the order approved.';

/** @param {any} scope */
export function run(scope) {
  scope.status = 'approved';
  scope.reasons = [];
}
