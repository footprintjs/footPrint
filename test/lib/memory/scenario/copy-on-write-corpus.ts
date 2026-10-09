/**
 * The copy-on-write reference corpus (9.29.0): programs from the four
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
  type WriteBackProgram,
  borrowedProgramArb,
  chartProgramArb,
  nestedProgramArb,
  runBorrowed,
  runChart,
  runNested,
  runWriteBack,
  writeBackProgramArb,
  writesThroughStagedValue,
  writesThroughWriteBack,
  writesThroughWriteBackOrSet,
} from '../property/copy-on-write-fixture.js';

export type Family = 'chart' | 'borrowed' | 'nested' | 'writeback';
export type Entry = { family: Family; program: any; digests: Record<string, string> };

const here = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = join(here, 'reference', 'copy-on-write-9.28.0.json');

/** 64 bits of SHA-256 — enough to tell two outputs apart, small enough to check in. */
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Every field a program keeps on `engine`, digested. M8's `snapshots` are left out where it applies. */
export async function digestsOf(engine: Engine, family: Family, program: any): Promise<Record<string, string>> {
  return digestKept(await keptOf(engine, family, program));
}

/** The digest of every kept field — what the corpus stores. */
export function digestKept(out: Record<string, string>): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const field of Object.keys(out).sort()) digests[field] = digest(out[field]);
  return digests;
}

/** Every field a program keeps on `engine`, as bytes — what {@link digestsOf} digests. */
export async function keptOf(engine: Engine, family: Family, program: any): Promise<Record<string, string>> {
  const out =
    family === 'chart'
      ? (await runChart(engine, program)).out
      : family === 'borrowed'
      ? await runBorrowed(engine, program)
      : family === 'nested'
      ? runNested(engine, program)
      : runWriteBack(engine, program);
  if (family === 'nested' && writesThroughStagedValue(program)) delete out.snapshots;
  if (family === 'writeback' && writesThroughWriteBackOrSet(program)) delete out.snapshots;
  return out;
}

/**
 * The B2 shape, shrunk: the recheck's WRITE-BACK counterexample under both B2
 * injections (the frame's read without `detachBase` — `RecordFrame · read`, `StageContext · readState`
 * before C3; `detachBase` a no-op). The
 * stage deletes `x`, deletes it again, reads it — served from live state —
 * pushes onto it in place and sets it back: 9.28.0 records `x = [0]`; with the
 * base left shared, the build recorded no row. The first write-back entry.
 */
export const B2_WRITE_BACK: WriteBackProgram = {
  initial: { x: [] },
  stages: [
    {
      runId: '',
      ops: [
        { t: 'del', path: 0, k: 'x' },
        { t: 'delReadBack', path: 0, k: 'x', n: 0, how: 'set' },
      ],
    },
  ],
  commitValues: 'full',
  mutate: true,
};

/** The corpus's programs: fixed seeds, JSON round-tripped (what is stored is exactly what runs). */
export function corpusPrograms(): Array<{ family: Family; program: any }> {
  const sample = <T>(arb: fc.Arbitrary<T>, seed: number, numRuns: number) =>
    fc.sample(arb, { seed, numRuns }).map((p) => JSON.parse(JSON.stringify(p)));
  // M3 programs are never sampled into the write-back family (fixture · `writesThroughWriteBack`).
  const writeBack = [
    B2_WRITE_BACK,
    ...sample(writeBackProgramArb, 9_280_004, 60).filter((p) => !writesThroughWriteBack(p)),
  ];
  return [
    ...sample(chartProgramArb, 9_280_001, 120).map((program) => ({ family: 'chart' as const, program })),
    ...sample(borrowedProgramArb, 9_280_002, 40).map((program) => ({ family: 'borrowed' as const, program })),
    ...sample(nestedProgramArb, 9_280_003, 120).map((program) => ({ family: 'nested' as const, program })),
    ...writeBack.slice(0, 40).map((program) => ({ family: 'writeback' as const, program })),
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
