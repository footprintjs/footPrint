/**
 * 9.29.0 — copy-on-write changes WORK, never BYTES: the pinned corpus.
 *
 * `reference/copy-on-write-9.28.0.json` holds 280 programs from the three
 * families of copy-on-write-fixture.ts (in-contract charts through the typed
 * scope, subflows, forks and every dial; reads mutated in place after the
 * first write, dev mode on; `StageContext` at nested and namespaced paths),
 * each run on the PUBLISHED 9.28.0 package (the `footprintjs-baseline` alias)
 * on 2026-10-01 and stored with a 64-bit SHA-256 digest of every
 * field it keeps: the commit log, live state, the fold base, the execution
 * tree, subflow results, the redacted mirror, the fold at every stop, the
 * reads a stage made, the warnings, every error. This build must reproduce
 * every digest. (M8's `stageWrites` are left out of the nested programs that
 * write through a value the same stage set — the one named difference.)
 *
 * The live differential (../property/copy-on-write-differential.property.test.ts)
 * explores new programs against the baseline package; this corpus pins these
 * programs forever, whatever the baseline alias or fast-check later become.
 *
 * Regenerate ONLY from the 9.28.0 baseline, never from the new code:
 *   npx tsx -e "Promise.all([import('./test/lib/memory/scenario/copy-on-write-corpus.ts'),
 *     import('./test/lib/memory/property/copy-on-write-fixture.ts')])
 *     .then(([c, f]) => (c.default ?? c).writeCorpus((f.default ?? f).BASELINE)).then((n) => console.log(n))"
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BUILD } from '../property/copy-on-write-fixture.js';
import { type Entry, CORPUS_PATH, digestsOf } from './copy-on-write-corpus.js';

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { generatedWith: string; entries: Entry[] };

describe('copy-on-write — the 9.28.0 corpus, byte for byte', () => {
  it('the corpus is what it claims: 9.28.0, all three families, the fields that matter', () => {
    expect(corpus.generatedWith).toBe('footprintjs@9.28.0');
    const families = new Map<string, number>();
    for (const e of corpus.entries) families.set(e.family, (families.get(e.family) ?? 0) + 1);
    expect(Object.fromEntries(families)).toEqual({ chart: 120, borrowed: 40, nested: 120 });
    const chart = corpus.entries.find((e) => e.family === 'chart')!;
    expect(Object.keys(chart.digests)).toEqual(
      expect.arrayContaining(['commitLog', 'sharedState', 'executionTree', 'subflowResults', 'folds', 'initialState']),
    );
    // Both encodings, a mirror, a subflow and a fork are all in it.
    const cfgs = corpus.entries.filter((e) => e.family === 'chart').map((e) => e.program);
    expect(new Set(cfgs.map((p) => p.cfg.commitValues))).toEqual(new Set(['full', 'delta']));
    expect(cfgs.some((p) => p.cfg.policy)).toBe(true);
    expect(cfgs.some((p) => p.sub)).toBe(true);
    expect(cfgs.some((p) => p.fork)).toBe(true);
  });

  it.each(['chart', 'borrowed', 'nested'] as const)(
    'every %s program reproduces 9.28.0’s digests',
    async (family) => {
      for (const [i, e] of corpus.entries.entries()) {
        if (e.family !== family) continue;
        const now = await digestsOf(BUILD, e.family, e.program);
        if (JSON.stringify(now) !== JSON.stringify(e.digests)) {
          const field = Object.keys(e.digests).find((k) => now[k] !== e.digests[k]);
          throw new Error(`entry ${i} (${family}) differs at ${field}\nprogram: ${JSON.stringify(e.program)}`);
        }
      }
    },
    300_000,
  );
});
