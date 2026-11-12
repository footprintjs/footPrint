# Order desk

Takes an order and gives back a priced, checked outcome: approved, sent for review, rejected, or on hold.

The program is a flowchart built with `footprintjs`. `./src/chart.mjs` holds only the wiring: which step runs after which. Each step is a folder under `./src/steps/<step>/` with one small function and a one-line `purpose`. The tax sub-flowchart lives in `./src/subflows/tax/`, with what crosses into and out of it in `mappers.mjs`. Prices, stock, customers, coupons and tax rates are plain tables in `./src/data/`.

- Run one order: `node ./src/run-order.mjs ./fixtures/<name>.json` prints the result as JSON.
- Run the tests: `node --test ./test/visible.test.mjs`.

The result's keys are `orderId`, `status`, `reasons`, `subtotal`, `discount`, `loyaltyDiscount`, `tax`, `shipping` and `grandTotal` (`./src/order-desk.mjs · RESULT_KEYS`).
