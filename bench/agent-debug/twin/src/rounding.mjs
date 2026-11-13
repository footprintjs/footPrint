/**
 * Rounding for money and weight (SPEC.md, section 5).
 *
 * Both use `Math.round`, which rounds a value exactly halfway between two
 * whole numbers toward the larger one: 212.5 → 213 and −2.5 → −2. That is the
 * spec's rule, so no custom half-handling is needed.
 *
 * The arithmetic is plain double-precision on purpose: 1.005 rounds to 1,
 * because 1.005 × 100 is 100.49999… in floating point. Do not "fix" this with
 * an epsilon or decimal arithmetic; the expected results depend on it.
 */

/**
 * Rounds an amount of money to the cent: × 100, round half up, ÷ 100.
 * @param {number} amount
 * @returns {number}
 */
export function roundToCent(amount) {
  return Math.round(amount * 100) / 100;
}

/**
 * Rounds a weight in kilograms to the gram: × 1000, round half up, ÷ 1000.
 * @param {number} kg
 * @returns {number}
 */
export function roundToGram(kg) {
  return Math.round(kg * 1000) / 1000;
}
