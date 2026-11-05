/** Fixed-seed census pins are Measured by checked-in ffa78c8b CI42092283312 on BOTH Node22/24; see PR158 proof. */
const EXPECTED: Readonly<Record<string, number>> = {
  'property:pause:500': 60,
  'witness:NESTED:200': 0,
  'witness:CHART:200': 26,
  'property:chart:500': 53,
  'property:borrowed:500': 0,
  'property:nested:500': 1,
  'property:nested-102938:2000': 4,
  'property:write-back:500': 28,
};
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
