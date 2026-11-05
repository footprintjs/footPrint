/**
 * 9.29.0 — copy-on-write changes WORK, never BYTES: the pinned corpus.
 *
 * `reference/copy-on-write-9.28.0.json` holds 320 programs from the four
 * families of copy-on-write-fixture.ts (in-contract charts through the typed
 * scope, subflows, forks and every dial; reads mutated in place after the
 * first write, dev mode on; `StageContext` at nested and namespaced paths;
 * the B2 write-back — a read served from live state after the first write,
 * edited in place and written back), each run on the PUBLISHED 9.28.0
 * package (the `footprintjs-baseline` alias) and stored with a 64-bit SHA-256
 * digest of every field it keeps: the commit log, live state, the fold base,
 * the execution tree, subflow results, the redacted mirror, the fold at every
 * stop, the reads a stage made, the warnings, every error. This build must
 * reproduce every digest. (M8's `stageWrites` are left out of the nested and
 * write-back programs that write through a value the same stage set — the one
 * named difference.) The first 280 entries were generated on 2026-10-01; the
 * 40 write-back entries (the recheck's shrunk B2 counterexample first) were
 * appended on 2026-10-02 by the same command, which reproduced the 280
 * byte for byte.
 *
 * The live differential (../property/copy-on-write-differential.property.test.ts)
 * explores new programs against the baseline package; this corpus pins these
 * programs forever, whatever the baseline alias or fast-check later become.
 *
 * 9.30.0 — THE ADMITTED RECORD. The entries in `ADMITTED` below no longer
 * reproduce 9.28.0's digests, by design: each is a program at which 9.28.0
 * committed rows that did not fold back to what the stage read (a merge
 * delta replayed across a hard write, an `[]` clear, a kind change, a union
 * deduplicated by reference, an L-1 shell, an in-place edit of a merged or
 * set value — C2 to C5). The digests are NOT regenerated: each listed entry
 * is proven, every run, by the WITNESS (../property/copy-on-write-fixture.ts
 * · `witnessClause`) — the first commit at which the two engines' logs
 * differ is a 9.28.0 bundle that did not fold back, and every commit the
 * build made did. The list is pinned both ways: an entry that starts or
 * stops differing fails. Counts: chart 5 of 120, borrowed 2 of 40, nested 55
 * of 120 (StageContext merges at nested paths through primitives), write-back
 * 12 of 40; the B2 entry is not among them. Every other entry reproduces
 * every digest, and the witness checks that every commit the build made on
 * it folded back.
 *
 * R13 — THE MOUNT NAMES ITS OWN ACTS. `runChart` sees the baseline through
 * the fixture's R13 view (restamped merge-backs and seeds; the merge-back
 * rows' `readKeys` and the tracking R13 moved left out on both engines —
 * fixture, above `ChartRun`), so the corpus was regenerated once from the
 * 9.28.0 baseline through that view: 62 chart entries with a subflow moved,
 * in their commitLog / executionTree / subflowResults / redactedSubflows
 * digests only; every other entry, and every ADMITTED index, is unchanged.
 *
 * C-F5 — THE SEED COMMITS UNDER THE RUN POLICY. The baseline is also seen
 * with every subflow seed row given `readKeys: []` under `writeProvenance:
 * 'reads-prefix'` (fixture · `cf5Seeds`), and the corpus was regenerated once
 * more from the 9.28.0 baseline through that view: 30 chart entries moved
 * (a subflow with a non-empty seed, under reads-prefix), in their
 * subflowResults / redactedSubflows digests only (39 digests); nothing else.
 *
 * Regenerate ONLY from the 9.28.0 baseline, never from the new code:
 *   npx tsx -e "Promise.all([import('./test/lib/memory/scenario/copy-on-write-corpus.ts'),
 *     import('./test/lib/memory/property/copy-on-write-fixture.ts')])
 *     .then(([c, f]) => (c.default ?? c).writeCorpus((f.default ?? f).BASELINE)).then((n) => console.log(n))"
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { firstCommit124 } from '../../../helpers/firstCommit124.js';
import { type ObservedKept, joinedRun } from '../../../helpers/readBindings.js';
import { readLawPorts } from '../../../helpers/readLawPorts.js';
import { type Decision, formatWitnessDecision } from '../../../helpers/witnessDecision.js';
import {
  type Engine,
  type Witnessed,
  BASELINE,
  BUILD,
  firstDifference,
  judgeWitness,
  observing,
  witnessing,
} from '../property/copy-on-write-fixture.js';
import {
  type Entry,
  type Family,
  B2_WRITE_BACK,
  CORPUS_PATH,
  corpusPrograms,
  digestKept,
  digestsOf,
  keptOf,
} from './copy-on-write-corpus.js';

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { generatedWith: string; entries: Entry[] };

/** The entries 9.30.0 changes, by index — each proven by the witness on every run (header). */
const ADMITTED: Record<Family, readonly number[]> = {
  chart: [1, 32, 45, 85, 92],
  borrowed: [136, 140],
  nested: [
    160, 161, 162, 169, 171, 172, 173, 174, 176, 177, 181, 184, 185, 186, 189, 191, 194, 195, 196, 197, 202, 209, 211,
    215, 218, 220, 221, 224, 225, 228, 231, 233, 235, 236, 237, 238, 239, 241, 243, 247, 248, 253, 254, 256, 257, 259,
    262, 264, 268, 270, 273, 275, 276, 277, 278,
  ],
  writeback: [282, 283, 285, 286, 288, 292, 296, 300, 302, 303, 316, 319],
};

/** No index is admitted from intake counts. Each later addition requires its actual named proof. */
const READ_AFTER_DELETE_124: Record<Family, readonly number[]> = {
  chart: [16, 28, 77, 81, 93, 112],
  borrowed: [],
  nested: [],
  writeback: [280, 294],
};

type CorpusRun = { kept: Record<string, string>; seen: Witnessed[]; observed?: ObservedKept };
/** keptOf remains the sole owner of the exact output projection and existing M8 omissions. */
async function observedCorpus(engine: Engine, entry: Entry): Promise<CorpusRun> {
  if (entry.family === 'borrowed') {
    // No operation coordinates exist for this family. It keeps the old witness and cannot claim #124.
    const [kept, seen] = await witnessing(engine, () => keptOf(engine, entry.family, entry.program));
    return { kept, seen };
  }
  const run = await observing(engine, entry.program, 'run', (operations) =>
    keptOf(engine, entry.family, entry.program, operations),
  );
  return { kept: run.value, seen: [...run.commits], observed: joinedRun(run, run.value) };
}

function observedDecision(a: CorpusRun, b: CorpusRun, entry: Entry, differs: boolean, redacted: boolean) {
  const proof =
    entry.family === 'borrowed'
      ? {}
      : (() => {
          if (!a.observed || !b.observed) throw new Error('Missing actual corpus observation.');
          return readLawPorts(a.observed, b.observed, entry.family, firstCommit124);
        })();
  return judgeWitness(a.seen, b.seen, differs, redacted, proof);
}

function named124(decision: Decision): boolean {
  if (decision.kind !== 'cause' || decision.name !== 'read-after-delete-124') return false;
  return decision.shape === 'first-commit'
    ? decision.coordinate.kind === 'fixture-operation' && decision.coordinate.at.length > 0
    : decision.coordinates.length > 0 && decision.coordinates.every((at) => at.length > 0);
}
const bounded = (text: string, limit = 2_048) =>
  text.length <= limit ? text : `${text.slice(0, limit)} [${text.length - limit} more characters omitted]`;

describe('copy-on-write — the 9.28.0 corpus, byte for byte', () => {
  it('new #124 entries are explicit, unique, correctly located and separate from old ADMITTED entries', () => {
    for (const family of ['chart', 'borrowed', 'nested', 'writeback'] as const) {
      const indices = READ_AFTER_DELETE_124[family];
      expect(new Set(indices).size).toBe(indices.length);
      for (const index of indices) {
        expect(Number.isSafeInteger(index) && index >= 0 && index < corpus.entries.length).toBe(true);
        expect(corpus.entries[index].family).toBe(family);
        expect(ADMITTED[family].includes(index)).toBe(false);
      }
    }
    // This family has no actual operation/read bindings and cannot be admitted by a neighbouring family.
    expect(READ_AFTER_DELETE_124.borrowed).toEqual([]);
  });
  it('fixed seeds reproduce the exact committed programs without regenerating any reference bytes', () => {
    expect(corpusPrograms()).toEqual(corpus.entries.map(({ family, program }) => ({ family, program })));
  });

  it('the baseline digest generator reproduces one stored entry from every family', async () => {
    for (const family of ['chart', 'borrowed', 'nested', 'writeback'] as const) {
      const entry = corpus.entries.find((candidate) => candidate.family === family)!;
      expect(await digestsOf(BASELINE, family, entry.program)).toEqual(entry.digests);
    }
  });

  it('the corpus is what it claims: 9.28.0, all four families, the fields that matter', () => {
    expect(corpus.generatedWith).toBe('footprintjs@9.28.0');
    const families = new Map<string, number>();
    for (const e of corpus.entries) families.set(e.family, (families.get(e.family) ?? 0) + 1);
    expect(Object.fromEntries(families)).toEqual({ chart: 120, borrowed: 40, nested: 120, writeback: 40 });
    // The B2 shape is pinned as itself, not left to a sample.
    expect(corpus.entries.find((e) => e.family === 'writeback')!.program).toEqual(B2_WRITE_BACK);
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

  it.each(['chart', 'borrowed', 'nested', 'writeback'] as const)(
    'every %s program reproduces 9.28.0’s digests — or is a listed admitted-record change the witness proves',
    async (family) => {
      let lawOnly = 0;
      let failed = 0;
      const failures: string[] = [];
      const provenButUnlisted: number[] = [];
      const provedSamples: Array<{ index: number; cause: string }> = [];
      for (const [i, e] of corpus.entries.entries()) {
        if (e.family !== family) continue;
        const where = `entry ${i} (${family})`;
        try {
          const build = await observedCorpus(BUILD, e);
          const same = JSON.stringify(digestKept(build.kept)) === JSON.stringify(e.digests);
          const listed = ADMITTED[family].includes(i);
          const listed124 = READ_AFTER_DELETE_124[family].includes(i);
          if (same) {
            if (listed) throw new Error(`${where} reproduces 9.28.0 again — take it off ADMITTED`);
            if (listed124) throw new Error(`${where} reproduces 9.28.0 again — take it off READ_AFTER_DELETE_124`);
            // Even exact bytes never bypass the BUILD half of the old witness.
            const broken = formatWitnessDecision(judgeWitness([], build.seen, false));
            if (broken) throw new Error(`${where}: ${broken}`);
            continue;
          }
          const baseline = await observedCorpus(BASELINE, e);
          // This must happen BEFORE ANY #124 port is consulted. A moved alias cannot justify new corpus bytes.
          expect(digestKept(baseline.kept), `${where}: live 9.28.0 baseline drifted from stored bytes`).toEqual(
            e.digests,
          );
          // Existing redaction relation only; live heap/checkpoint comparisons remain exact at firstDifference.
          const redacted = e.program?.cfg?.policy === true;
          const diff = firstDifference(baseline.kept, build.kept, redacted);
          if (diff === '') {
            if (listed)
              throw new Error(`${where} differs from 9.28.0 by the redaction law alone — take it off ADMITTED`);
            if (listed124)
              throw new Error(`${where} differs by the redaction law alone — take it off READ_AFTER_DELETE_124`);
            lawOnly += 1;
          }
          const decision = observedDecision(baseline, build, e, diff !== '', redacted);
          const broken = formatWitnessDecision(decision);
          if (broken)
            throw new Error(
              `${where}: ${broken}${
                decision.kind === 'broken' && decision.detail ? `: ${decision.detail}` : ''
              }\n${diff}`,
            );
          if (listed && (decision.kind !== 'cause' || decision.name !== 'admitted-record-9.30'))
            throw new Error(`${where}: old ADMITTED entry no longer proves its original 9.30 first cause`);
          if (listed124 && (!diff || !named124(decision)))
            throw new Error(`${where}: #124 entry no longer differs and proves its named actual coordinate`);
          if (diff && !listed && !listed124) {
            if (named124(decision)) {
              provenButUnlisted.push(i);
              if (provedSamples.length < 16)
                provedSamples.push({ index: i, cause: bounded(JSON.stringify(decision), 1_024) });
            }
            throw new Error(
              `${where}: UNLISTED difference remains a failure\n${diff}\nnamed decision: ${bounded(
                JSON.stringify(decision),
              )}`,
            );
          }
        } catch (error) {
          failed += 1;
          // Finish the finite, unchanged family to expose other candidate indices; never turn failure into success.
          if (failures.length < 16)
            failures.push(
              `${where}: ${bounded(error instanceof Error ? error.message : 'Non-Error failure')}\nprogram: ${bounded(
                JSON.stringify(e.program),
              )}`,
            );
        }
      }
      if (failed)
        throw new Error(
          `${family}: ${failed} failing entries; showing ${failures.length}\n${failures.join(
            '\n\n',
          )}\nPROVEN-BUT-UNLISTED #124 INTAKE ONLY (does not edit/authorize the list): ${JSON.stringify({
            indices: provenButUnlisted,
            sampleCount: provedSamples.length,
            samples: provedSamples,
          })}`,
        );
      // The law's relation is exercised, not vacuous: the corpus's policy programs reach it.
      if (family === 'chart') expect(lawOnly).toBeGreaterThan(0);
    },
    300_000,
  );
});
