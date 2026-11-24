# The order desk: specification

The order desk takes one customer order and gives back a priced, checked outcome. It prices every line of the order, takes off any coupon and loyalty discount, adds sales tax and shipping, checks the shelf and the customer's credit, and ends with one of four outcomes: approved, sent to a person for review, rejected, or on hold.

This document says everything the desk does, in the order a person would explain a checkout. The reference tables it uses (catalog, coupons, customers, stock, tax rates) are written out in full in section 4 and are also supplied as data files beside this document; the two say the same thing.

## 1. Running the desk

The desk is a command-line program that takes exactly one argument: the path of a JSON file. The file holds one object with a member `order`, which is the order (section 2). Any other member of the file is ignored.

- **Success:** the result (section 3) is printed on standard output, nothing is printed on standard error, and the exit code is 0. An order that is held, rejected or sent to review is still a success: those are outcomes, not errors.
- **No argument:** a one-line usage message is printed on standard error, nothing on standard output, and the exit code is 2.
- **Refusal:** when the file cannot be read, is not valid JSON, or the order is refused (section 7), nothing is printed on standard output, an error message is printed on standard error, and the exit code is 1. Section 7 gives the exact message text where the desk itself refuses.

The same order always gives the same result: nothing depends on the clock, on randomness or on an earlier order.

## 2. The order (input)

Every order in practice carries all of these fields except `couponCode`; the last column says what the desk does when one is missing.

| Field | Type | Meaning | When missing |
|---|---|---|---|
| `orderId` | string | The order's identifier. Printed back unchanged. | the key is left out of the result (see below) |
| `customerId` | string | Which customer places the order; must be a code in the customer table. | refused as an unknown customer (section 7) |
| `shipRegion` | string | The region the goods are delivered to: `north`, `south`, `east`, `west` or `export`. Sets the tax rate. | the default tax rate (section 4) |
| `billingRegion` | string | The region the invoice goes to. It **plays no part in any figure or outcome**. | no effect |
| `shipMethod` | string | `standard`, `express` or `pickup` (the customer collects the goods at the store). | charged like `standard` (section 6.7) |
| `couponCode` | string | A coupon code. `null` or an empty string also mean no coupon. | no coupon |
| `lines` | list | The order lines, in order. Each line is an object with `sku` (string, an item code) and `qty` (a whole number of units). | refused as a malformed order (section 7) |

Any other field of the order or of a line is ignored and never printed.

Values are taken as given, without checking or cleaning. Codes are matched exactly, letter case included: `Pickup` is not `pickup`, and `spring10` is not the coupon `SPRING10`. The desk does not check that a quantity is positive or whole: a quantity of 0 gives a line worth 0 that weighs nothing and is never short on the shelf.

`orderId` is printed exactly as given, whatever JSON value it is (a number stays a number, `null` stays `null`). If the order has no `orderId` field at all, the `orderId` key is left out of the printed result; every other key is still printed, in the same order.

## 3. The result (output)

The result is one JSON object with exactly these nine keys, in this order:

| Key | Type | Meaning |
|---|---|---|
| `orderId` | as given | The order's identifier (section 2). |
| `status` | string | `approved`, `review`, `rejected` or `on-hold` (section 6.11). |
| `reasons` | list of strings | Why the order did not simply go through; empty when approved (section 6.11). |
| `subtotal` | number | The sum of the line totals (section 6.2). |
| `discount` | number | The coupon discount (section 6.3). |
| `loyaltyDiscount` | number | The loyalty discount (section 6.4). |
| `tax` | number | The sales tax (section 6.6). |
| `shipping` | number | The shipping charge (section 6.7). |
| `grandTotal` | number | What the customer pays (section 6.8). |

**How it is printed:** standard JSON with an indentation of two spaces: one key per line, each element of a non-empty list on its own line, an empty list written `[]`, and the whole followed by a single newline. Numbers are written in JSON's shortest form, with no trailing zeros: `6`, not `6.00`; `34.8`, not `34.80`. A negative zero is written `0`.

For example, the order in fixture `out-of-stock` prints exactly:

```
{
  "orderId": "A-1002",
  "status": "on-hold",
  "reasons": [
    "out of stock: DESK-LAMP"
  ],
  "subtotal": 255,
  "discount": 0,
  "loyaltyDiscount": 5.1,
  "tax": 19.99,
  "shipping": 0,
  "grandTotal": 269.89
}
```

## 4. The reference tables

**Catalog** (item code: name, price per unit, weight per unit in kilograms):

| `sku` | `name` | `price` | `weightKg` |
|---|---|---|---|
| `PEN-BLUE` | Blue pen | 1.20 | 0.02 |
| `NOTE-A5` | A5 notebook | 3.33 | 0.25 |
| `CABLE-USB` | USB cable | 8.75 | 0.10 |
| `PAPER-BOX` | Box of printer paper | 24.90 | 12 |
| `DESK-LAMP` | Desk lamp | 42.50 | 1.8 |
| `MONITOR-27` | 27-inch monitor | 279.99 | 6.5 |
| `CHAIR-ERGO` | Office chair | 389.00 | 14 |

**Coupons.** A coupon takes either a percentage (`percent`) or a fixed amount (`fixed`) off, never both:

| Code | Kind |
|---|---|
| `SPRING10` | `percent`: 10 (10% off) |
| `WELCOME5` | `fixed`: 5 (5.00 off) |
| `BULK50` | `fixed`: 50 (50.00 off) |

**Customers.** `creditLimit` is the most the customer may owe in total, open invoices included; `orderLimit` is the most one order may cost, whatever the customer owes; `openBalance` is what the customer owes today; `memberYears` is the whole number of years the customer has bought from us.

| `customerId` | `name` | `creditLimit` | `orderLimit` | `openBalance` | `memberYears` |
|---|---|---|---|---|---|
| `C-100` | Harbour Books | 5000 | 3000 | 1200 | 2 |
| `C-200` | Northside School | 12000 | 8000 | 0 | 7 |
| `C-300` | Corner Studio | 1500 | 1500 | 900 | 5 |
| `C-400` | Riverside Clinic | 9000 | 2600 | 6000 | 1 |
| `C-500` | Hill Street Cafe | 800 | 800 | 0 | 0 |

The customer's name is never used in any figure or printed.

**Stock** (units on the shelf): `PEN-BLUE` 500, `NOTE-A5` 120, `CABLE-USB` 60, `PAPER-BOX` 30, `DESK-LAMP` 4, `MONITOR-27` 12, `CHAIR-ERGO` 8. An item the stock table does not list counts as 0 units on the shelf.

**Tax rates** by delivery region: `north` 0.08, `south` 0.06, `east` 0.0725, `west` 0.05, `export` 0. A region the table does not list (or a missing region) uses the **default rate 0.08**. A listed region whose rate is 0 (`export`) uses 0, not the default.

## 5. Money, weight and rounding

**Rounding to the cent** is used for every amount of money the desk works out: multiply the amount by 100, round to the nearest whole number, and divide by 100. A value exactly halfway between two whole numbers rounds up, toward the larger number (so 212.5 becomes 213, and −2.5 becomes −2). All arithmetic is ordinary double-precision floating point, done in the order each formula below is written, so the result is whatever that arithmetic gives. Two consequences matter:

- An amount that looks like an exact half cent may not be one once it is a floating-point number: 1.005 becomes 1 (because 1.005 × 100 is 100.49999… in floating point), and 10 × 3.33 × 0.95 (written 31.635 on paper) becomes 31.63.
- The order of the operands matters. Write each formula exactly as given: for example, a line total is (quantity × price) × (1 − bulk share), not quantity × (price × (1 − bulk share)).

**Rounding to the gram** is used for weight: multiply the weight in kilograms by 1000, round to the nearest whole number (halves up, as above), and divide by 1000.

Where this document says "rounded", it means rounded to the cent; weight is always rounded to the gram. Nothing is rounded except where this document says so.

## 6. The rules, in checkout order

### 6.1 Accepting the order

The desk reads the order, then looks the customer up in the customer table. A customer code that is not in the table refuses the order (section 7). Then it prices the lines.

### 6.2 Pricing each line, the subtotal and the weight

For each line of the order, in the order given:

1. Look the item up in the catalog. An item code that is not in the catalog refuses the order (section 7).
2. **Bulk discount:** a line with a quantity of **10 or more** units gets 5% off that line. The bulk share is 0.05 when the quantity is 10 or more, otherwise 0. Ten units is inside (gets the discount); nine is not. The discount is per line, never per item across lines: two lines of 5 notebooks each get no bulk discount.
3. **Line total** = rounded((quantity × price) × (1 − bulk share)). The line is rounded once, after the discount. The line's unit price is the catalog price, unchanged.
4. **Subtotal:** starting from 0 before the first line, after each line the subtotal becomes rounded(subtotal so far + line total).
5. **Total weight:** starting from 0 before the first line, after each line the weight becomes rounded-to-the-gram(weight so far + quantity × weightKg).

Example (fixture `cafe-notebooks`): 12 × `NOTE-A5` at 3.33 is 39.96; 12 is 10 or more, so 39.96 × 0.95 = 37.962, rounded 37.96. The subtotal is 37.96 and the weight is 12 × 0.25 = 3 kg.

### 6.3 The coupon

The coupon discount is worked out on the **subtotal**:

- no code, an empty code, or a code not in the coupon table: discount 0 (not an error);
- a percentage coupon: discount = rounded((subtotal × percent) / 100). Example (fixture `harbour-cables`): `SPRING10` on 52.50 gives 5.25;
- a fixed coupon: discount = the smaller of the fixed amount and the subtotal, not rounded further. A fixed coupon never takes off more than the subtotal. Example (fixture `welcome-coupon`): `WELCOME5` on 26.25 gives 5.

### 6.4 The loyalty discount

A customer with **5 or more** `memberYears` gets 2% off the **subtotal**: loyalty discount = rounded(subtotal × 0.02). Five years is inside (fixture `studio-lamps`, customer `C-300` with exactly 5 years, gets 2.05 on 102.50). Fewer than 5 years: 0.

The loyalty discount is taken on the subtotal, not on what is left after the coupon, so a customer can get both discounts in full.

### 6.5 The amount after discounts

Net amount = rounded(subtotal − coupon discount − loyalty discount). Tax and free shipping are both judged on this amount, not on the subtotal.

The net amount can be negative. A fixed coupon is capped at the subtotal, but the loyalty discount is still taken on top: a loyal customer (5 years or more) using `BULK50` on a subtotal of 6.00 gets a discount of 6, a loyalty discount of 0.12, and a net amount of −0.12. Nothing stops this; the rules below carry on with the negative amount.

### 6.6 Tax

The tax rate is the rate of the **delivery region** (`shipRegion`), from the tax table, or the default 0.08 when the region is not listed. The billing region is never used.

Tax = rounded(net amount × rate).

Example (fixture `harbour-express-lamp`): the goods ship to `west` (5%) although billing is `north`; 42.50 × 0.05 = 2.125, rounded up to 2.13.

### 6.7 Shipping

Tried in this order, the first that holds settles it:

1. The customer collects the goods at the store (`shipMethod` is exactly `pickup`): shipping is 0.
2. The net amount is **100 or more**: shipping is 0, whatever the method, express included. Exactly 100.00 ships free.
3. Otherwise the order pays a fee of 4.95 plus 0.85 for each kilogram of total weight: fee = 4.95 + (0.85 × total weight). If `shipMethod` is exactly `express`, shipping = rounded(fee × 2); for any other method (`standard`, a missing method, or any other text), shipping = rounded(fee). The doubling covers the whole fee, base included, and rounding happens once, after the doubling.

Examples: fixture `harbour-express-lamp`, 1.8 kg express: 4.95 + 1.53 = 6.48, doubled 12.96. Fixture `school-paper`, 24 kg standard: 4.95 + 20.40 = 25.35.

### 6.8 Grand total

Grand total = rounded(net amount + tax + shipping).

### 6.9 The stock check

For each line of the order, the line is **short** when the units on the shelf for its item are fewer than the line's quantity. A quantity equal to the units on the shelf is fine (fixture `clinic-monitors` orders 4 desk lamps with 4 on the shelf: not short). The check is per line, not per item: two lines of 3 desk lamps each (6 in all, 4 on the shelf) are each fine, and the order is not held.

The short items are listed in the order of the lines, one entry per short line, so an item that is short on two lines appears twice. The stock is fine when no line is short.

### 6.10 The credit check

Two limits, both of which must hold:

- **Credit limit:** the customer's open balance + the grand total must be **at most** the credit limit (equal is within).
- **Order limit:** the grand total alone must be **at most** the order limit (equal is within).

These comparisons use the amounts as they are, with no further rounding. The credit is fine when both hold; it fails when either one is broken. The outcome does not say which one.

**Headroom** is how much more the customer could owe after this order before reaching the credit limit: rounded(credit limit − open balance − grand total). It is negative when the order goes over the credit limit. It looks only at the credit limit, never at the order limit, and it does not change the outcome or the printed result.

Both checks, stock and credit, are always made, after the grand total is known, whatever the other one finds; neither changes any figure.

### 6.11 The outcome

Tried in this order; the first that holds gives the outcome:

| # | When | `status` | `reasons` |
|---|---|---|---|
| 1 | the stock check found at least one short line | `on-hold` | one text per short line, in line order: `out of stock: ` followed by the item code, for example `["out of stock: DESK-LAMP"]` |
| 2 | the credit check failed (either limit) | `rejected` | `["over the credit or order limit"]` |
| 3 | the grand total is **more than** 2000 (exactly 2000.00 is not) | `review` | `["large order"]` |
| 4 | otherwise | `approved` | `[]` |

A held order is held even when it is also over a limit: being short on the shelf is tried first.

### 6.12 Figures the desk works out but does not print

For each line, its unit price and line total; the total weight; the net amount; the tax rate used; whether the stock is fine and which items are short; whether the credit is fine; the headroom; and the number of lines priced (always the number of lines in the order). None of these is printed, but each is part of the rules above and has the value they give.

## 7. Refusals

The desk refuses an order, in this order of checking (the first that applies is the one reported):

1. **A malformed order:** the file has no `order` member, the order is not an object, `lines` is missing or is not a list, or a line is `null`. Refused with an error message on standard error (its wording is not specified) and exit code 1.
2. **An unknown customer:** the `customerId` is not in the customer table (a missing `customerId` counts as unknown). Refused with an error whose message is exactly `unknown customer ` followed by the code as given (for example `unknown customer C-999`, or `unknown customer undefined` when the field is missing), printed on standard error; exit code 1. This is checked before any line is priced, so an order with both an unknown customer and an unknown item reports the customer.
3. **An order with no lines** (`lines` is an empty list): refused with an error message on standard error (its wording is not specified) and exit code 1. It is not priced as an empty order.
4. **An unknown item:** the lines are priced in the order given, and the first line whose `sku` is not in the catalog refuses the order with an error whose message is exactly `unknown item ` followed by the code as given (for example `unknown item NOPE`, or `unknown item undefined` when the line has no `sku`), printed on standard error; exit code 1.
5. **Too many lines:** an order may have at most 1,001 lines. When the lines are priced in order and a 1,002nd line is reached, the order is refused with an error message on standard error (its wording is not specified) and exit code 1. So an unknown item on one of the first 1,001 lines is reported as an unknown item, and one further down is never reached.

A refused order prints nothing on standard output.

## 8. Where the order of operations changes a result

Each example below is a real order; the figures are what the desk gives.

1. **Tax is charged on the amount after discounts, not on the subtotal.** Fixture `out-of-stock` (customer `C-200`, 7 years, 6 desk lamps, north): subtotal 6 × 42.50 = 255; loyalty 255 × 0.02 = 5.10; net 249.90; tax 249.90 × 0.08 = 19.992, rounded 19.99 (on the subtotal it would be 20.40); grand total 249.90 + 19.99 + 0 = 269.89.
2. **Free shipping is judged on the amount after discounts, not on the subtotal and not on the grand total.** Fixture `studio-lamps` (customer `C-300`, 5 years, west): subtotal 2 × 42.50 + 2 × 8.75 = 102.50; loyalty 2.05; net 100.45, still 100 or more, so shipping is 0; tax 100.45 × 0.05 = 5.0225, rounded 5.02; grand total 105.47. The other way round: the `school-paper` order sent express has a net amount of 48.80 and a grand total of 103.40, and still pays shipping (50.70), because the grand total is never what free shipping looks at.
3. **The coupon and the loyalty discount are both worked out on the subtotal.** The `out-of-stock` order with coupon `SPRING10` added: subtotal 255; coupon 25.50; loyalty 5.10 (2% of 255, not of 229.50); net 224.40; tax 17.95; grand total 242.35.
4. **Each line is rounded before it is added, and the subtotal is rounded after each line.** Fixture `harbour-three-items` (customer `C-100`, north): 2 × 279.99 = 559.98; 1 × 42.50 = 42.50; 4 × 389 = 1556; subtotal 2158.48; tax 172.6784, rounded 172.68; grand total 2331.16, more than 2000, so the order goes to review.
5. **Express doubles the whole fee, and rounding comes after the doubling.** Fixture `harbour-express-lamp`: (4.95 + 0.85 × 1.8) × 2 = 6.48 × 2 = 12.96.
6. **The credit check uses the grand total, after tax and shipping.** Fixture `cafe-chairs` (customer `C-500`, limits 800 and 800, owes 0): 3 chairs = 1167; tax south 70.02; shipping 0 (net 1167 is 100 or more); grand total 1237.02, over the order limit of 800 and (0 + 1237.02) over the credit limit of 800, so it is rejected. Headroom 800 − 0 − 1237.02 = −437.02.
7. **The stock check comes before the credit check in the outcome.** The `cafe-chairs` order with a line of 5 desk lamps added (4 on the shelf): grand total 1462.27, well over both limits, yet the outcome is `on-hold` with `["out of stock: DESK-LAMP"]`, because a short line is tried first.
8. **The credit check comes before the large-order review.** Fixture `clinic-monitors` (customer `C-400`, credit limit 9000, order limit 2600, owes 6000, south): 8 × 279.99 = 2239.92 plus 4 × 42.50 = 170, subtotal 2409.92; tax 144.5952, rounded 144.60; grand total 2554.52. Within the order limit (2554.52 ≤ 2600) and within the credit limit (6000 + 2554.52 = 8554.52 ≤ 9000; headroom 445.48), so the credit is fine; the grand total is more than 2000, so the outcome is `review`. Had either limit been broken, the outcome would have been `rejected` instead, large or not.
