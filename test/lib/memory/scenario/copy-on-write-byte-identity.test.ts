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
 *
 * THE READ KEPT ONCE. A read is retained once for each object a key holds, not at every read
 * (`memory/keptReads.ts`). The record of a program that keeps to the contract does not move: 316
 * of the 320 entries are as before. Four BORROWED entries move (`KEPT_ONCE` below), in what a stage
 * that edits a read value in place is said to have read, and one of them in what dev mode reports. No
 * digest is regenerated: the law is asserted on each such entry and taken out before the comparison
 * (`../../engine/scenario/read-kept-once-law.ts`), and the list is pinned both ways.
 *
 * THE READ WINDOW (foottrace 1.13.0). A step's first bundle carries `beganAt` (and `sawUntil` when it
 * looked again) where another step committed while it ran; 9.28.0 cannot write either field. The fixture
 * takes them out of the BUILD's bytes before anything is compared or digested, each checked to sit beside
 * another step's commit (`runChart`, `../../engine/scenario/read-window-law.ts`); no digest is regenerated.
 * In these programs only fork children run side by side, so every stamp must be on one, and the chart
 * entries that carry any are pinned both ways (`READ_WINDOWS` below), so a build that loses the stamps, or
 * stamps a step that ran alone, fails here.
 *
 * THE VIEW MARK (foottrace 1.14.0). A `set` row the record's writer built on the stage's view carries
 * `builtOnView: true` (and its bundle `viewAt`, when another commit landed since the view was pinned);
 * 9.28.0 cannot write either field. The fixture takes them out of the BUILD's bytes in every family
 * before anything is compared or digested, each checked first (`comparedRecord`,
 * `../../engine/scenario/view-mark-law.ts`); no digest is regenerated. Every marked row of the corpus
 * is pinned by its step, its place in the log and its path, both ways (`VIEW_MARKS` below), so a build
 * that loses a mark, or marks a row it should not, fails here. No entry carries a `viewAt`.
 *
 * #124 oracle domain: the historical cross-engine claims above apply only
 * where the native 9.28 run does not return a defined value after an
 * unreestablished same-frame tombstone. Other programs keep BUILD fold-back,
 * native undefined-read and the original valid generation/alias/checkpoint
 * obligations; exclusion counts/lists are pinned from actual fixed-seed runs.
 * A bug confined to excluded programs and escaping those laws/direct witnesses
 * is no longer caught by this differential. Generated operations stay unchanged.
 * The build's side of that law is asked of every entry, for a `set` as for a delete
 * (`assertBuildHardWrittenReadsUndefined`): no entry of this corpus is excused by it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertBuildDeletedReadsUndefined,
  assertBuildHardWrittenReadsUndefined,
  oracleDomain,
} from '../../../helpers/readWitness.js';
import { withoutKeptOnce } from '../../engine/scenario/read-kept-once-law.js';
import { mayMoveIn } from '../property/borrowed-edits.js';
import {
  BASELINE,
  BUILD,
  firstDifference,
  FORK_CHILD,
  observing,
  witnessClause,
} from '../property/copy-on-write-fixture.js';
import {
  type Entry,
  type Family,
  type TakenOut,
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

/**
 * The borrowed entries the read-kept-once law moves, each with the in-place edits dev mode now reports
 * on the moved reads (`stage key`; 9.28.0 reported none of them). In 126, 132 and 159 the stage wrote
 * the key afterwards, so its edit is in the record and nothing is reported. In 139 the stage never
 * wrote `b` or `obj`: both edits are lost to the record, and both are reported now.
 */
const KEPT_ONCE: Readonly<Record<number, readonly string[]>> = {
  126: [],
  132: [],
  139: ['S1 b', 'S1 obj'],
  159: [],
};

/**
 * The chart entries whose build record carries read windows (header: THE READ WINDOW) — each a program with a
 * fork whose later child read state before an earlier sibling committed. Measured on foottrace 1.13.0 by
 * running every chart entry on both foottrace 1.11.1 and 1.13.0: these 52 differ by the stamps alone.
 */
const READ_WINDOWS: readonly number[] = [
  3, 7, 9, 11, 15, 16, 19, 21, 22, 24, 25, 29, 30, 32, 34, 35, 36, 37, 38, 41, 45, 47, 50, 52, 53, 54, 58, 60, 62, 65,
  73, 80, 81, 82, 83, 84, 85, 90, 91, 93, 96, 100, 101, 102, 106, 108, 111, 112, 115, 117, 118, 119,
];

/**
 * Every marked row of the corpus (header: THE VIEW MARK), by entry: `<runtimeStageId>@<idx> <path>`, the
 * path's segments joined with `/` for reading. The stage-context families do not name their steps, so
 * their rows begin with `@`. Measured on foottrace 1.14.0. Why the exact rows and not a count: the law
 * file refuses a mark on a row that is not a `set`, and cannot know from a record alone whether a `set`
 * row should carry one. A mark that moved to another row would pass every byte comparison (it is taken
 * out before them), so WHERE the marks sit is pinned here.
 *
 * Each marked commit was compared with 9.28.0's, with the marks taken out, and two kinds showed:
 *
 *   - a row the writer READ BACK: 9.28.0's rows there did not fold back to what the stage read, and the
 *     build writes a marked `set` in their place. Chart 85 (9.28.0 wrote `merge a`), borrowed 136
 *     (`merge obj`), nested 173 and write-back 319 (same verbs, another value). The chart and borrowed
 *     families met the mark in no other way, and the test asks that of them (`MARKED_ONLY_ON_READ_BACK`).
 *   - a row on a commit whose bytes are otherwise 9.28.0's: nested 225, at its first commit. Under
 *     'delta' the stage merged into a key and wrote a path inside it.
 *
 * All five entries are on `ADMITTED`, each for a commit that differs from 9.28.0's (in 225 a later one
 * than the marked commit). So their logs are judged by the witness, not byte for byte, and this
 * corpus would have passed with the marks left in its logs. What it could not have passed with is a
 * mark in the WITNESS's own bytes (fixture · `patchWitness`): entry 225 then fails with "commit 0
 * differs, but 9.28.0's bundle there folded back". The differential families are where a mark left in
 * a log fails (nested and write-back).
 */
const VIEW_MARKS: Record<Family, Readonly<Record<number, readonly string[]>>> = {
  chart: { 85: ['stage-3#6@7 a'] },
  borrowed: { 136: ['s0#1@1 obj'] },
  nested: { 173: ['@2 runs/r1/list/y', '@2 runs/r1/list'], 225: ['@0 obj/list/list', '@0 obj/list'] },
  writeback: { 319: ['@1 runs/r1/obj/deep/0', '@1 runs/r1/obj/deep'] },
};
const MARKED_ONLY_ON_READ_BACK: readonly Family[] = ['chart', 'borrowed'];

/** Measured by checked-in ffa78c8b CI42092283312 on BOTH Node22/24; unchanged corpus bytes. */
const OUT_OF_ORACLE_DOMAIN: Record<Family, readonly number[]> = {
  chart: [6, 11, 14, 16, 28, 37, 38, 42, 45, 48, 65, 76, 77, 80, 81, 93, 95, 97, 106, 112, 113, 117, 118, 119],
  borrowed: [],
  nested: [],
  writeback: [280, 294, 316],
};

describe('copy-on-write — the 9.28.0 corpus, byte for byte', () => {
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
      const excluded: number[] = [];
      const keptOnce: Record<number, readonly string[]> = {};
      const windowed: number[] = [];
      const viewMarked: Record<number, readonly string[]> = {};
      const viewDated: number[] = [];
      for (const [i, e] of corpus.entries.entries()) {
        if (e.family !== family) continue;
        // The frozen baseline digests remain checked even when that baseline is not an oracle for BUILD.
        const [base, baselineSeen, baselineNative] = await observing(BASELINE, () =>
          keptOf(BASELINE, e.family, e.program),
        );
        expect(digestKept(base), `baseline corpus entry ${i}`).toEqual(e.digests);
        const taken: TakenOut = { readWindows: [], viewMarks: [] };
        const [ran, buildSeen, buildNative] = await observing(BUILD, () => keptOf(BUILD, e.family, e.program, taken));
        assertBuildDeletedReadsUndefined(buildNative);
        assertBuildHardWrittenReadsUndefined(buildNative);
        // The read-window law (header): taken out of `ran` by the fixture; on fork children only.
        for (const w of taken.readWindows) expect(w.runtimeStageId, `entry ${i}: a read window`).toMatch(FORK_CHILD);
        if (taken.readWindows.length > 0) windowed.push(i);
        // The view-mark law (header): taken out of `ran` by the fixture; every marked row, by its place.
        const markedRows = taken.viewMarks.flatMap((mark) =>
          mark.paths.map((path) => `${mark.runtimeStageId}@${mark.idx} ${path.split('\u001f').join('/')}`),
        );
        if (markedRows.length > 0) viewMarked[i] = markedRows;
        for (const mark of taken.viewMarks) if (mark.viewAt !== undefined) viewDated.push(i);
        // The read-kept-once law: asserted, then taken out of what the build kept (header).
        const law = family === 'borrowed' ? withoutKeptOnce(base, ran, mayMoveIn(e.program)) : undefined;
        const kept = law?.build ?? ran;
        if (law !== undefined && law.moved.length > 0) {
          expect(law.reportedBefore, `entry ${i}: 9.28.0 reported none of the moved reads`).toEqual([]);
          keptOnce[i] = law.reported;
        }
        const buildFailure = witnessClause([], buildSeen, false);
        if (buildFailure) throw new Error(`entry ${i}: ${buildFailure}`);
        const listed = ADMITTED[family].includes(i);
        const where = `entry ${i} (${family})`;
        if (oracleDomain(baselineNative).kind === 'out-of-domain') {
          excluded.push(i);
          if (listed)
            expect(
              baselineSeen.some((row) => !row.foldsBack),
              `${where}: independent old9.30 evidence`,
            ).toBe(true);
          continue;
        }
        const same = JSON.stringify(digestKept(kept)) === JSON.stringify(e.digests);
        if (same && listed) throw new Error(`${where} reproduces 9.28.0 again — take it off ADMITTED`);
        const redacted = e.program?.cfg?.policy === true;
        let differs = !same;
        if (!same) {
          const diff = firstDifference(base, kept, redacted);
          if (diff === '') {
            if (listed) throw new Error(`${where} differs by the redaction law alone — take it off ADMITTED`);
            lawOnly += 1;
            differs = false;
          } else if (!listed) throw new Error(`${where} ${diff}\nprogram: ${JSON.stringify(e.program)}`);
        }
        const broken = witnessClause(baselineSeen, buildSeen, differs, redacted);
        if (broken) throw new Error(`${where}: ${broken}\nprogram: ${JSON.stringify(e.program)}`);
      }
      console.log(`ORACLE-DOMAIN-CORPUS ${JSON.stringify({ family, excluded })}`);
      expect(keptOnce, 'the read-kept-once list is pinned both ways').toEqual(family === 'borrowed' ? KEPT_ONCE : {});
      expect(excluded, 'explicit oracle-domain list is pinned both ways').toEqual(OUT_OF_ORACLE_DOMAIN[family]);
      expect(windowed, 'the read-window list is pinned both ways').toEqual(family === 'chart' ? READ_WINDOWS : []);
      expect(viewMarked, 'the view-mark list is pinned both ways').toEqual(VIEW_MARKS[family]);
      expect(viewDated, 'no corpus entry carries a viewAt').toEqual([]);
      if (MARKED_ONLY_ON_READ_BACK.includes(family))
        for (const i of Object.keys(viewMarked))
          expect(ADMITTED[family], `entry ${i}: its mark sits on a commit the writer read back`).toContain(Number(i));
      // The law's relation is exercised, not vacuous: the corpus's policy programs reach it.
      if (family === 'chart') expect(lawOnly).toBeGreaterThan(0);
    },
    300_000,
  );
});
