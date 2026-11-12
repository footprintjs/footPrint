/**
 * load-customer: looks the customer up and keeps the four facts the desk
 * uses later: credit limit, order limit, what they owe today, and how many
 * years they have bought from us.
 *
 * Example: `customerId = 'C-100'` → `customer.creditLimit = 5000`.
 */
import { CUSTOMERS } from '../../data/customers.mjs';

export const purpose = 'Look up the customer and keep their limits, balance and years.';

/** @param {any} scope */
export function run(scope) {
  const found = CUSTOMERS[scope.customerId];
  if (!found) throw new Error(`unknown customer ${scope.customerId}`);
  scope.customer = {
    creditLimit: found.creditLimit,
    orderLimit: found.orderLimit,
    openBalance: found.openBalance,
    memberYears: found.memberYears,
  };
}
