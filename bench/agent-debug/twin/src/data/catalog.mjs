/**
 * The catalog: what each item costs and weighs.
 *
 * Why data and not code: prices change often, and a price change must never
 * touch the rules. Example: `CATALOG['NOTE-A5'].price` → `3.33`.
 *
 * @type {Record<string, { name: string, price: number, weightKg: number }>}
 */
export const CATALOG = {
  'PEN-BLUE': { name: 'Blue pen', price: 1.2, weightKg: 0.02 },
  'NOTE-A5': { name: 'A5 notebook', price: 3.33, weightKg: 0.25 },
  'CABLE-USB': { name: 'USB cable', price: 8.75, weightKg: 0.1 },
  'PAPER-BOX': { name: 'Box of printer paper', price: 24.9, weightKg: 12 },
  'DESK-LAMP': { name: 'Desk lamp', price: 42.5, weightKg: 1.8 },
  'MONITOR-27': { name: '27-inch monitor', price: 279.99, weightKg: 6.5 },
  'CHAIR-ERGO': { name: 'Office chair', price: 389, weightKg: 14 },
};
