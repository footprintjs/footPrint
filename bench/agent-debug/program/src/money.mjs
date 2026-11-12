/**
 * Money helpers shared by every step that prices something.
 *
 * Why one place: a price is shown to the cent, and every step must round the
 * same way, or the totals stop adding up. Example: `roundCents(34.7985)` → `34.8`.
 */

/**
 * Rounds an amount of money to whole cents.
 * @param {number} amount
 * @returns {number}
 */
export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

/**
 * Rounds a weight to whole grams, so that adding many light items does not
 * leave a long tail of digits. Example: `roundGrams(0.1 + 0.2)` → `0.3`.
 * @param {number} kg
 * @returns {number}
 */
export function roundGrams(kg) {
  return Math.round(kg * 1000) / 1000;
}
