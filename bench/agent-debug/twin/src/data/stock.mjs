/**
 * Units on the shelf for each item, as the warehouse last reported them.
 *
 * Why a plain table: the order desk only needs to know whether an order can
 * ship today. Example: `STOCK['DESK-LAMP']` → `4`.
 *
 * @type {Record<string, number>}
 */
export const STOCK = {
  'PEN-BLUE': 500,
  'NOTE-A5': 120,
  'CABLE-USB': 60,
  'PAPER-BOX': 30,
  'DESK-LAMP': 4,
  'MONITOR-27': 12,
  'CHAIR-ERGO': 8,
};
