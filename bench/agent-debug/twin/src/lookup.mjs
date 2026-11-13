/**
 * Looking a code up in one of the reference tables.
 */

/**
 * Returns the table's entry for a code, or `undefined` when the table does not
 * list it.
 *
 * Two edges, both from the rule that codes are matched exactly, letter case
 * included (`Pickup` is not `pickup`):
 * - Only the table's OWN keys count. A plain `table[code]` would find
 *   inherited members, so a customer code of `constructor` or an item code of
 *   `toString` would be "found".
 * - Only a string is a code. `Object.hasOwn` turns its key into a string, so
 *   without this check the number 100 would match a key `"100"`, and the list
 *   `["C-100"]` would match the customer `C-100`.
 *
 * @template T
 * @param {Record<string, T>} table
 * @param {unknown} code
 * @returns {T | undefined}
 */
export function lookUp(table, code) {
  if (typeof code !== 'string' || !Object.hasOwn(table, code)) return undefined;
  return table[code];
}
