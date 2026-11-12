/**
 * review: the order waits for a person, because it is large.
 *
 * Example: → `status = 'review'`.
 */

export const purpose = 'Send a large order to a person for review.';

/** @param {any} scope */
export function run(scope) {
  scope.status = 'review';
  scope.reasons = ['large order'];
}
