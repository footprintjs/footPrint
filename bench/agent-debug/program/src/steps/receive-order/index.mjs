/**
 * receive-order: the first step. It copies the order the desk was handed
 * into the run's state, one field per key, so every later step reads only
 * the field it needs.
 *
 * Why copy: the input of a run is frozen and not tracked; a key in state is
 * tracked, so the record can show which step used it.
 * Example: input `{ order: { orderId: 'A-1', lines: [...] } }` → `orderId = 'A-1'`.
 */

export const purpose = 'Copy the incoming order into the run, one field per key.';

/** @param {any} scope */
export function run(scope) {
  const { order } = scope.$getArgs();
  scope.orderId = order.orderId;
  scope.customerId = order.customerId;
  scope.shipRegion = order.shipRegion;
  scope.billingRegion = order.billingRegion;
  scope.shipMethod = order.shipMethod;
  scope.couponCode = order.couponCode ?? '';
  scope.lines = order.lines.map((line) => ({ sku: line.sku, qty: line.qty }));
}
