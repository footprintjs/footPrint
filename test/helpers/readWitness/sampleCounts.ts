/** Fixed-seed census pins are filled only from an actual checked-in hosted run. */
const EXPECTED: Readonly<Record<string, number>> = {};
export function assertExactDomainCount(programs: number, excluded: number, expected: number): void {
  if (
    ![programs, excluded, expected].every(Number.isSafeInteger) ||
    programs < 1 ||
    excluded < 0 ||
    excluded > programs ||
    expected < 0 ||
    expected > programs ||
    excluded !== expected
  )
    throw new Error(`Oracle domain count differs: ${excluded}/${programs}, expected ${expected}.`);
}
export function assertDomainCount(family: string, programs: number, excluded: number, fixed: boolean): void {
  if (
    !Number.isSafeInteger(programs) ||
    programs < 1 ||
    !Number.isSafeInteger(excluded) ||
    excluded < 0 ||
    excluded > programs
  )
    throw new Error('Invalid oracle-domain census.');
  console.log(`ORACLE-DOMAIN-COUNT ${JSON.stringify({ family, programs, excluded, fixed })}`);
  if (!fixed) return;
  const expected = EXPECTED[`${family}:${programs}`];
  if (expected === undefined)
    throw new Error(`Unmeasured fixed-seed oracle-domain profile: ${family}:${programs}, observed ${excluded}.`);
  assertExactDomainCount(programs, excluded, expected);
}
