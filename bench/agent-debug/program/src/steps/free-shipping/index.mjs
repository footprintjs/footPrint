/**
 * free-shipping: the order ships at no charge.
 *
 * Example: → `shipping = 0`.
 */

export const purpose = 'Charge nothing for shipping.';

/** @param {any} scope */
export function run(scope) {
  scope.shipping = 0;
}
