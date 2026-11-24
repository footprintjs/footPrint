/**
 * The order desk's business rules, one line each, so that a test can show
 * every rule is asked about at least once across the thirty questions
 * (each question lists the rules it needs in `rules`).
 *
 * Why here and in these words: they are the rules any implementation of the
 * desk has, written the way a person would say them; they name no part of
 * either program.
 */
export const RULES = Object.freeze({
  'line-price': 'A line costs quantity times catalog price; 10 or more units of one item take 5% off that line; the line is rounded to the cent once, after the discount.',
  subtotal: 'The subtotal is the sum of the line totals.',
  weight: 'The order weighs the sum of quantity times item weight.',
  coupon: 'A coupon takes a percentage (rounded to the cent) or a fixed amount (never more than the subtotal) off the subtotal.',
  loyalty: 'A customer of 5 or more years gets 2% of the subtotal off.',
  'net-amount': 'The amount after discounts is the subtotal minus the coupon and the loyalty discount.',
  'tax-rate': 'The tax rate is the rate of the region the order is delivered to; a region the table does not list pays the default rate.',
  tax: 'Tax is the amount after discounts times the rate, rounded to the cent.',
  'free-shipping': 'Shipping is free when the customer collects the order, or when the amount after discounts is 100 or more.',
  'shipping-charge': 'Otherwise shipping is a fixed fee plus a fee per kilogram, twice that for express, rounded to the cent.',
  'grand-total': 'The grand total is the amount after discounts plus tax plus shipping.',
  'stock-check': 'A line is short when the shelf holds fewer units of its item than the line orders.',
  'credit-check': 'The credit check fails when what the customer owes plus the grand total is over the credit limit, or the grand total is over the order limit.',
  outcome: 'A short line holds the order; else a failed credit check rejects it; else a grand total over 2000 sends it to review; else it is approved.',
  refusal: 'An unknown customer or item refuses the order with an error and no outcome.',
});
