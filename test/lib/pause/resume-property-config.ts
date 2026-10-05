interface ResumePropertyParameters {
  seed: number;
  numRuns: number;
  path?: string;
  endOnFailure?: true;
}

/** Test-local configuration; no process reads or global fast-check settings. */
export function resumePropertyParameters(
  mode: 'same' | 'cross',
  env: Readonly<Record<string, string | undefined>>,
): ResumePropertyParameters {
  const seedText = env.RESUME_PROPERTY_SEED;
  const seed = seedText === undefined ? (mode === 'same' ? 20261005 : 20261006) : Number(seedText);
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
