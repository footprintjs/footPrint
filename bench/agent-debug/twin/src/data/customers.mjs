/**
 * The customers the order desk knows.
 *
 * - `creditLimit`: the most the customer may owe us in total, open invoices included.
 * - `orderLimit`: the most one order may cost, whatever the customer owes.
 * - `openBalance`: what the customer owes us today.
 * - `memberYears`: whole years the customer has bought from us.
 *
 * Example: `CUSTOMERS['C-100'].creditLimit` → `5000`.
 *
 * @type {Record<string, { name: string, creditLimit: number, orderLimit: number, openBalance: number, memberYears: number }>}
 */
export const CUSTOMERS = {
  'C-100': { name: 'Harbour Books', creditLimit: 5000, orderLimit: 3000, openBalance: 1200, memberYears: 2 },
  'C-200': { name: 'Northside School', creditLimit: 12000, orderLimit: 8000, openBalance: 0, memberYears: 7 },
  'C-300': { name: 'Corner Studio', creditLimit: 1500, orderLimit: 1500, openBalance: 900, memberYears: 5 },
  'C-400': { name: 'Riverside Clinic', creditLimit: 9000, orderLimit: 2600, openBalance: 6000, memberYears: 1 },
  'C-500': { name: 'Hill Street Cafe', creditLimit: 800, orderLimit: 800, openBalance: 0, memberYears: 0 },
};
