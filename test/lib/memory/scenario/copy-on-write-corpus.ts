/**
 * The copy-on-write reference corpus (9.29.0): programs from the three
 * differential families at fixed seeds, each run ONCE on the published
 * 9.28.0 and stored with a digest of every field it keeps. See
 * copy-on-write-byte-identity.test.ts for how it is checked and regenerated.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';

import {
  type Engine,
  borrowedProgramArb,
  chartProgramArb,
  nestedProgramArb,
  runBorrowed,
  runChart,
  runNested,
  writesThroughStagedValue,
} from '../property/copy-on-write-fixture.js';

export type Family = 'chart' | 'borrowed' | 'nested';
export type Entry = { family: Family; program: any; digests: Record<string, string> };

const here = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = join(here, 'reference', 'copy-on-write-9.28.0.json');

/** 64 bits of SHA-256 — enough to tell two outputs apart, small enough to check in. */
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Every field a program keeps on `engine`, digested. M8's `snapshots` are left out where it applies. */
export async function digestsOf(engine: Engine, family: Family, program: any): Promise<Record<string, string>> {
  const out =
    family === 'chart'
      ? (await runChart(engine, program)).out
      : family === 'borrowed'
      ? await runBorrowed(engine, program)
      : runNested(engine, program);
  if (family === 'nested' && writesThroughStagedValue(program)) delete out.snapshots;
  const digests: Record<string, string> = {};
  for (const field of Object.keys(out).sort()) digests[field] = digest(out[field]);
  return digests;
}

/** The corpus's programs: fixed seeds, JSON round-tripped (what is stored is exactly what runs). */
export function corpusPrograms(): Array<{ family: Family; program: any }> {
  const sample = <T>(arb: fc.Arbitrary<T>, seed: number, numRuns: number) =>
    fc.sample(arb, { seed, numRuns }).map((p) => JSON.parse(JSON.stringify(p)));
  return [
    ...sample(chartProgramArb, 9_280_001, 120).map((program) => ({ family: 'chart' as const, program })),
    ...sample(borrowedProgramArb, 9_280_002, 40).map((program) => ({ family: 'borrowed' as const, program })),
    ...sample(nestedProgramArb, 9_280_003, 120).map((program) => ({ family: 'nested' as const, program })),
  ];
}

/** Write the corpus from `engine` — ONLY ever the 9.28.0 baseline. */
export async function writeCorpus(engine: Engine): Promise<number> {
  const entries: Entry[] = [];
  for (const { family, program } of corpusPrograms()) {
    entries.push({ family, program, digests: await digestsOf(engine, family, program) });
  }
  const lines = entries.map((e) => JSON.stringify(e));
  writeFileSync(CORPUS_PATH, `{"generatedWith":"footprintjs@${engine.label}","entries":[\n${lines.join(',\n')}\n]}\n`);
  return entries.length;
}
