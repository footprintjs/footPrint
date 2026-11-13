# Order desk

The order desk takes one customer order and prices it: line totals with the bulk discount, coupon and loyalty discounts, sales tax and shipping. It then checks the shelf and the customer's credit, and ends with one outcome: approved, review, rejected or on-hold.

**Layout.** `src/run-order.mjs` is the command and `src/cli.mjs` handles arguments, files and exit codes. `src/order-desk.mjs` runs the steps in checkout order. The rules are in `accept.mjs` (shape and customer checks), `pricing.mjs` (lines, subtotal, weight), `discounts.mjs` (coupon, loyalty, net amount), `charges.mjs` (tax, shipping, grand total), `checks.mjs` (stock, credit) and `outcome.mjs` (status and reasons). The helpers are `rounding.mjs`, `lookup.mjs` and `refusal.mjs`, and the reference tables are in `src/data/`.

**Run one order:** `node ./src/run-order.mjs ./fixtures/<name>.json`. It prints the result as JSON and exits 0, or prints a message on standard error and exits 1 when the order is refused (2 when no file is given).

**Test:** `npm test` (or `node --test`) runs everything; `node --test ./test/visible.test.mjs` runs the quick pre-commit suite.

**Result keys, in order:** `orderId`, `status`, `reasons`, `subtotal`, `discount`, `loyaltyDiscount`, `tax`, `shipping`, `grandTotal`.
