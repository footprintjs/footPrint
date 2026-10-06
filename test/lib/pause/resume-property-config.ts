interface ResumePropertyParameters {
  seed: number;
  numRuns: number;
  path?: string;
  endOnFailure?: true;
}

/** A fresh signed 32-bit seed: every run explores a new batch; the test name prints it for replay. */
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32) - 2 ** 31;
}

/** Test-local configuration; no process reads or global fast-check settings. */
export function resumePropertyParameters(
  env: Readonly<Record<string, string | undefined>>,
  drawSeed: () => number = randomSeed,
): ResumePropertyParameters {
  const seedText = env.RESUME_PROPERTY_SEED;
  const seed = seedText === undefined ? drawSeed() : Number(seedText);
  if (
    seedText !== undefined &&
    (!/^-?\d+$/.test(seedText) || !Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647)
  ) {
    throw new Error('RESUME_PROPERTY_SEED must be a signed 32-bit decimal integer');
  }

  const path = env.RESUME_PROPERTY_PATH;
  if (path === undefined) return { seed, numRuns: 160 };
  if (seedText === undefined) throw new Error('RESUME_PROPERTY_PATH requires RESUME_PROPERTY_SEED');
  if (!/^\d+(?::\d+)*$/.test(path) || !path.split(':').every((part) => Number.isSafeInteger(Number(part)))) {
    throw new Error('RESUME_PROPERTY_PATH must contain colon-separated nonnegative safe integers');
  }

  // Explicit replay selects one counterexample, including a root-only path.
  // Normal runs retain all 160 cases, shrinking and fast-check's native reporter.
  return { seed, numRuns: 1, path, endOnFailure: true };
}
