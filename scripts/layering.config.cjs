'use strict';
/**
 * layering.config.cjs — the footprintjs layer table, as data.
 *
 * ONE owner for the fence. Three readers, none keeps a copy:
 *   - `.eslintrc.js`                        → `import/no-restricted-paths` zones (`layerZones`)
 *   - `scripts/check-layering.mjs`          → value-level cycles + upward edges + the closed record
 *   - `test/architecture/layering.test.ts`  → the same analysis, inside the suite
 *
 * THE RULE — a file imports only files at its own layer or BELOW it. Every file has
 * exactly one layer: the most specific pattern that matches it (an exact path beats
 * `dir/**`; a deeper directory beats a shallower one). A file no pattern matches is an
 * error, not a default — `memory/` in particular has no directory entry, because that one
 * directory spans L0 to L4 and a new file in it must be placed by hand.
 *
 *   L0 values and leaves        address, compare, summarise a value; the dev-mode flag
 *   L1 verbs                    the one law that turns a trace row into a value
 *   L2 staging and commit       one stage's ops → one net-change bundle; the next generation; the log's scrub
 *   L3 the log as a read model  what a finished log can honestly say (slice/, time-travel/), and the
 *                               log itself with the one step that lands a commit on it (recordCommit)
 *                               and the record half of a stage's frame that takes it there (RecordFrame)
 *   L4 the frame and run policy one stage's frame inside a run (it composes a RecordFrame); the runtime;
 *                               the redaction verdict (it decides; the record frame writes the bytes)
 *   L5 scope, recorders, hooks  what a stage may do; how every event reaches every recorder
 *   L6 engine                   walking the chart: one phase chain, one id grammar
 *   L7 builder and executor     the DSL and the run lifecycle
 *   L8 entry points             src/*.ts — the public barrels; may import anything
 *
 * Only RUNTIME edges are the law. A type-only import is erased by tsc and is not an edge;
 * the script ignores it. ESLint's `import/no-restricted-paths` cannot tell the two apart,
 * so the few upward type-only imports that exist today are named in TYPE_ONLY_ALLOWANCES.
 * That list only ever shrinks.
 *
 * HISTORICAL RECORD BOUNDARY (C6) — the record names nothing outside itself. RECORD_FILES identifies
 * the old paths for historical readiness/co-change analysis and pre-extraction fixture trees.
 * E3's live engine fence instead rejects these paths and checks named imports on foottrace's three
 * public doors. scripts/trace-extraction.json pins the exact 44 files and 74 tests that moved.
 * Before extraction, RECORD_FILES is the record:
 * the files a trace package would hold. A record file imports only record files, and here EVERY
 * import counts, `import type` included: a package cut along this list must compile alone — which
 * `check-layering.mjs · recordAlone` checks by compiling the list on its own. A new file that is the
 * record's goes into RECORD_FILES as well as LAYERS.
 */

const fs = require('fs');
const path = require('path');

/** @type {ReadonlyArray<{ rank: number, name: string, files: string[] }>} */
const LAYERS = [
  {
    rank: 0,
    name: 'values and leaves',
    files: [
      'src/lib/capture/**',
      'src/lib/devMode.ts',
      'src/lib/schema/**',
      'src/lib/pause/**',
      // The thrown-value structurer (`extractErrorInfo`): imports schema/errors (L0) only. A leaf
      // OUTSIDE engine/ since F8, so scope/ and recorder/ (L5) build the scope ErrorEvent with it
      // without an edge into engine/, which would close the engine ⇄ recorder ⇄ scope module cycle.
      'src/lib/errors/**',
      'src/lib/memory/pathOps.ts',
      'src/lib/memory/types.ts',
      'src/lib/memory/eventPosition.ts',
      // The path codec, structural equality and the union merge: leaves (split out of utils.ts in
      // F2) — equality imports only the value-kind classifier (capture/valueKinds.ts, 9.44.2). The
      // verb law (verbs.ts) reads them from L1.
      'src/lib/memory/paths.ts',
      'src/lib/memory/equality.ts',
      'src/lib/memory/merge.ts',
      // The honesty vocabulary (F4a): code → the one sentence; imports nothing, typed through from L3.
      'src/lib/memory/honesty.ts',
      // The log's redaction placeholder (F4a; the scope one moved to the verdict, redaction.ts, in C4):
      // imports nothing; written by the record's scrub (scrub.ts, L2), passed by runner/ExecutionRuntime.ts and
      // engine/handlers/SubflowExecutor.ts (the mirror's seed, a subflow's served state).
      'src/lib/memory/placeholders.ts',
      // Which rows touch a key — the path half of the writer rule and the writer index (F3).
      // Imports the path codec and types only; staging (L2) and every log reader (L3) ask it.
      'src/lib/memory/keyPaths.ts',
      // The id grammar (F7): `runtimeStageId.ts` (the one owner — build/parse/read; a record file),
      // `branchSegment.ts` (the generated `~` segment) and `reservedIds.ts` (the id doors' refusal, out of
      // runtimeStageId.ts in C6). Pure leaves: time-travel/ (L3), scope/ and recorder/ (L5) read them, so
      // they cannot sit above L0 — and they left engine/ in F7 because a scope → engine edge closes the
      // engine ⇄ scope ⇄ recorder module cycle.
      'src/lib/ids/**',
      // `assertNotReadonly` / `createFrozenArgs`: an input-ownership leaf with no imports.
      // The in-place record freezer moved to `capture/freeze.ts` in F3, so that
      // `EventLog · record` (memory/) can freeze without a memory → scope edge.
      'src/lib/scope/protection/readonlyInput.ts',
    ],
  },
  {
    rank: 1,
    name: 'verbs',
    files: [
      // The verb law: the one step a commit row takes, and every fold of it. Imports L0 only.
      'src/lib/memory/verbs.ts',
      // The nested-object helpers, and the one re-export surface of paths / equality /
      // merge (L0) and verbs (L1) — placed by its highest part.
      'src/lib/memory/utils.ts',
      'src/lib/observer-queue/**',
    ],
  },
  {
    rank: 2,
    name: 'staging and commit',
    files: [
      'src/lib/memory/TransactionBuffer.ts',
      // The log's scrub: the placeholder at each redacted path of a patch (C4 — out of redaction.ts, so the
      // record never imports the engine's verdict). recordCommit (L3) calls it; `redactPatch` is its public twin.
      'src/lib/memory/scrub.ts',
      'src/lib/memory/SharedMemory.ts',
      'src/lib/memory/admission.ts',
      'src/lib/memory/deltaEncoding.ts',
    ],
  },
  {
    rank: 3,
    name: 'the log as a read model',
    files: [
      'src/lib/memory/EventLog.ts',
      // One commit onto the record: the bundle's key order, the scrub, the live/mirror apply, the log (C1).
      'src/lib/memory/recordCommit.ts',
      // The record half of a stage's frame: the address, the first-touch base, the two-tier read, the
      // lazy buffer, the readKeys list, and the commit through recordCommit (C3). StageContext composes it.
      'src/lib/memory/RecordFrame.ts',
      'src/lib/memory/commitLogUtils.ts',
      // The read model of one log: the writer and value rules at a cost proportional to the answer (F3).
      'src/lib/memory/logModel.ts',
      'src/lib/memory/backtrack.ts',
      // The interval index over commit indices: imports nothing, reads no engine event. A record file (C6),
      // so it sits with the readers rather than with the recorders around it.
      'src/lib/recorder/CommitRangeIndex.ts',
      'src/lib/slice/**',
      'src/lib/time-travel/**',
    ],
  },
  {
    rank: 4,
    name: 'the frame and run policy',
    files: [
      'src/lib/memory/StageContext.ts',
      // The run's policy — the dials, the rule, the mirror flag — handed to every frame by reference (F5).
      'src/lib/memory/runPolicy.ts',
      // The redaction verdict — RedactionRule, the write decision (decideWrite, inheritByIdentity, markStagedWrite),
      // MapperTaint, the scope placeholder — beside the policy that carries it (C4: the engine decides, the record
      // writes the bytes).
      'src/lib/memory/redaction.ts',
      // Where a frame with a run id writes: the run namespace, the engine's one spelling of it (C4: a leaf, so
      // the frame and the verdict both read it without a cycle). The record takes the address as data (C2).
      'src/lib/memory/runAddress.ts',
      // The frame's types — its snapshot (StageSnapshot), its flow messages, its retention dials (C6: out of the
      // record's types.ts, so the record names nothing outside itself).
      'src/lib/memory/frameTypes.ts',
      'src/lib/memory/DiagnosticCollector.ts',
      'src/lib/memory/borrowedMutation.ts',
      'src/lib/memory/index.ts',
      'src/lib/runner/ExecutionRuntime.ts',
    ],
  },
  {
    rank: 5,
    name: 'scope, recorders, hooks',
    files: [
      // The hook registry + the one dispatcher (`fire`) and the one snapshot-bundle copier (F6):
      // asked by scope/ (ScopeFacade), engine/narrative (the flow dispatcher), runner/ (taps, resume).
      'src/lib/recorder/hooks.ts',
      'src/lib/recorder/snapshot.ts',
      'src/lib/recorder/**',
      'src/lib/scope/**',
      'src/lib/reactive/**',
      'src/lib/decide/**',
      'src/lib/engine/narrative/**',
    ],
  },
  {
    rank: 6,
    name: 'engine',
    files: [
      // F7: the one subflow-id prefixer (builder at mount, traverser at run) and the one
      // TraversalContext constructor (traverser + executor).
      'src/lib/engine/graph/prefixNodeTree.ts',
      'src/lib/engine/traversalContext.ts',
      'src/lib/engine/**',
    ],
  },
  {
    rank: 7,
    name: 'builder and executor',
    files: [
      'src/lib/builder/**',
      // F9: the executor composes these — who observes a run, the re-entry, the pause
      // checkpoint, the served snapshot, the construction options.
      'src/lib/runner/attach.ts',
      'src/lib/runner/resume.ts',
      'src/lib/runner/checkpoint.ts',
      'src/lib/runner/snapshot.ts',
      'src/lib/runner/options.ts',
      'src/lib/runner/**',
      'src/lib/contract/**',
      'src/lib/detach/**',
      // Walks the builder's spec shape (types only) and is imported by src/trace.ts alone,
      // so it sits with the builder although the file lives under engine/.
      'src/lib/engine/walkSubflowSpec.ts',
    ],
  },
  {
    rank: 8,
    name: 'entry points',
    files: ['src/*.ts'],
  },
];

/**
 * The historical record (C6; extracted in E3): every file the trace package holds — its types, the verb law and its
 * leaves, staging and commit, the log, the record half of the frame, and every reader of the log.
 * A record file imports only record files, by value or by type (`check-layering.mjs` · `recordEscapes`;
 * the ESLint zone in `layerZones` says the same). Every entry is placed at L0–L3 and matches a file.
 * The rule that decides membership is the extraction plan's (docs/design/2026-10-trace-extraction.md,
 * section 7.5): a symbol moves to the trace package iff it is declared in one of these files.
 */
const RECORD_FILES = Object.freeze([
  // L0 — the record's types (and the execution tree its readers read), the path codec, structural
  // equality and the union merge, the path spine, the honesty vocabulary, the log's placeholder,
  // which rows touch a key, where an emit sits in the log, the id grammar, the record's freezer and
  // the value-kind classifier equality and the freezer share (9.44.2)
  'src/lib/memory/types.ts',
  'src/lib/memory/paths.ts',
  'src/lib/memory/equality.ts',
  'src/lib/memory/merge.ts',
  'src/lib/memory/pathOps.ts',
  'src/lib/memory/honesty.ts',
  'src/lib/memory/placeholders.ts',
  'src/lib/memory/keyPaths.ts',
  'src/lib/memory/eventPosition.ts',
  'src/lib/ids/runtimeStageId.ts',
  'src/lib/capture/freeze.ts',
  'src/lib/capture/ownData.ts',
  'src/lib/capture/valueKinds.ts',
  // L1 — the verb law and its re-export surface
  'src/lib/memory/verbs.ts',
  'src/lib/memory/utils.ts',
  // L2 — staging and commit
  'src/lib/memory/TransactionBuffer.ts',
  'src/lib/memory/admission.ts',
  'src/lib/memory/deltaEncoding.ts',
  'src/lib/memory/SharedMemory.ts',
  'src/lib/memory/scrub.ts',
  // L3 — the log, one commit onto it, the record half of a frame, and the readers
  'src/lib/memory/EventLog.ts',
  'src/lib/memory/recordCommit.ts',
  'src/lib/memory/RecordFrame.ts',
  'src/lib/memory/commitLogUtils.ts',
  'src/lib/memory/logModel.ts',
  'src/lib/memory/backtrack.ts',
  'src/lib/recorder/CommitRangeIndex.ts',
  'src/lib/slice/**',
  'src/lib/time-travel/**',
]);

/**
 * The three edges the fence names on purpose. Each is a (from → to) pair; `from` may be a
 * glob. The script checks that every one is LIVE (the edge exists) so the list cannot
 * outlive its reason, and says for each whether the layer table already forbids it.
 */
const EXCEPTIONS = [
  {
    from: 'src/lib/builder/FlowChartBuilder.ts',
    to: 'src/lib/runner/RunnableChart.ts',
    reason:
      'builder → runner: `build()` hands back a RunnableFlowChart, and `makeRunnable` (which wraps the executor) is the one seam ' +
      'where a built chart becomes runnable. builder/ is not standalone.',
  },
  {
    from: 'src/lib/engine/**',
    to: 'src/lib/reactive/handles.ts',
    reason:
      'engine → reactive/handles.ts: the registry of every proxy the typed scope built, asked wherever an app value enters the ' +
      'record (fan-out items, subflow in/out mappers). handles.ts imports nothing, so the edge cannot close a cycle.',
  },
  {
    from: 'src/lib/scope/ScopeFacade.ts',
    to: 'src/lib/detach/spawn.ts',
    reason:
      'scope → detach/spawn.ts: `$detachAndJoinLater` / `$detachAndForget` route through ScopeFacade to the shared ' +
      '`spawn.ts · detachAndJoinLater` / `detachAndForget` primitives the executor also uses. spawn.ts never imports ' +
      'scope/, and the executor is only reached lazily (`detach/runChild.ts · defaultRunChild`).',
  },
];

/**
 * Upward imports that are TYPE-ONLY today (erased by tsc: no runtime edge, the script
 * ignores them) but that `import/no-restricted-paths` would flag. Each must stay type-only
 * — the script fails if one of these edges becomes a runtime import.
 */
const TYPE_ONLY_ALLOWANCES = [
  {
    from: 'src/lib/reactive/types.ts',
    to: 'src/lib/engine/types.ts',
    reason: "the typed scope names `ExecutionEnv` (the engine's environment contract) in its signatures.",
  },
  {
    from: 'src/lib/scope/ScopeFacade.ts',
    to: 'src/lib/engine/types.ts',
    reason: "the facade names `ExecutionEnv` (the engine's environment contract) in its signatures.",
  },
  {
    from: 'src/lib/runner/ExecutionRuntime.ts',
    to: 'src/lib/runner/DeferredObserverTier.ts',
    reason:
      'the runtime snapshot carries `observerStats?: ObserverStats`, a type declared beside the deferred tier that computes it.',
  },
];

/**
 * Old import paths kept as re-exports for one minor (two of the leaves moved out of
 * scope/; recorder/invokeHook.ts went in F6). Nothing under src/ may import them; the shims exist for
 * out-of-tree importers and are deleted the minor after.
 */
const SHIMS = ['src/lib/scope/detectCircular.ts', 'src/lib/scope/recorders/summarizeValue.ts'];

// ── matching ─────────────────────────────────────────────────────────────────

/** `**` crosses directories, `*` does not. Repo-relative, forward-slash paths only. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Higher = more specific: segments before the first wildcard, and exact paths beat globs. */
function specificity(glob) {
  const segs = glob.split('/');
  const firstWild = segs.findIndex((s) => s.includes('*'));
  return firstWild === -1 ? 1000 + segs.length : firstWild;
}

function compileLayers(layers) {
  return layers.flatMap((layer) =>
    layer.files.map((glob) => ({ glob, rank: layer.rank, re: globToRegExp(glob), spec: specificity(glob) })),
  );
}

const COMPILED = compileLayers(LAYERS);

/** Each record list's patterns, compiled once (the zones and the tests ask per file, and per pair). */
const compiledRecordLists = new WeakMap();

/** True when a repo-relative file is one of the record's (RECORD_FILES, or the list given). */
function isRecordFile(relPath, list = RECORD_FILES) {
  if (!compiledRecordLists.has(list)) compiledRecordLists.set(list, list.map(globToRegExp));
  return compiledRecordLists.get(list).some((re) => re.test(relPath));
}

/** The layer of a repo-relative file, or null when no pattern matches (a config error). */
function rankOf(relPath, compiled = COMPILED) {
  let best = null;
  for (const entry of compiled) {
    if (!entry.re.test(relPath)) continue;
    if (best === null || entry.spec > best.spec) best = entry;
    else if (entry.spec === best.spec && entry.rank !== best.rank) {
      throw new Error(
        `layering: "${relPath}" matches "${best.glob}" (L${best.rank}) and "${entry.glob}" (L${entry.rank}) equally`,
      );
    }
  }
  return best === null ? null : best.rank;
}

/** Every `.ts` file (no `.d.ts`) under `<root>/<dir>` (default `src`; scripts/record-tests.mjs lists `test`), repo-relative and sorted. */
function listSourceFiles(root, dir = 'src') {
  const out = [];
  const walk = (at) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts'))
        out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, dir));
  return out;
}

// ── ESLint zones ─────────────────────────────────────────────────────────────

/**
 * `import/no-restricted-paths` zones for `.eslintrc.js`, derived from the table: one zone
 * per layer (its files may not import files of a higher layer), plus one zone per file
 * that carries a named edge, with exactly that edge cut out, plus one zone for the record
 * (RECORD_FILES may not import any other file). `except` is not used —
 * eslint-plugin-import resolves it against each `from` entry, which cannot express "this
 * one importer, that one target".
 */
function layerZones(root) {
  const files = listSourceFiles(root);
  const rank = new Map();
  for (const f of files) {
    const r = rankOf(f);
    if (r === null) {
      throw new Error(
        `layering: ${f} is not in any layer. Add it to scripts/layering.config.cjs (LAYERS) — every src file has exactly one.`,
      );
    }
    rank.set(f, r);
  }
  const named = [...EXCEPTIONS, ...TYPE_ONLY_ALLOWANCES].map((n) => ({ from: globToRegExp(n.from), to: n.to }));
  const above = (k) => files.filter((f) => rank.get(f) > k);
  const abs = (f) => path.join(root, f);
  const zones = [];
  for (let k = 0; k <= 7; k++) {
    const higher = above(k);
    const higherSet = new Set(higher);
    const plain = [];
    for (const f of files.filter((x) => rank.get(x) === k)) {
      const cut = new Set(named.filter((n) => n.from.test(f) && higherSet.has(n.to)).map((n) => n.to));
      if (cut.size === 0) plain.push(f);
      else {
        zones.push({
          target: abs(f),
          from: higher.filter((h) => !cut.has(h)).map(abs),
          message: `L${k} may import only L0-L${k}. Named edges: scripts/layering.config.cjs.`,
        });
      }
    }
    if (plain.length > 0 && higher.length > 0) {
      zones.push({
        target: plain.map(abs),
        from: higher.map(abs),
        message: `L${k} may import only L0-L${k}. Named edges: scripts/layering.config.cjs.`,
      });
    }
  }
  // The second rule: a record file imports only record files. Every import kind counts here, so the
  // rule's blindness to `import type` is exactly right.
  const recordTargets = files.filter((f) => isRecordFile(f)).map(abs);
  if (recordTargets.length)
    zones.push({
      target: recordTargets,
      from: files.filter((f) => !isRecordFile(f)).map(abs),
      message: 'A record file imports only record files: RECORD_FILES, scripts/layering.config.cjs.',
    });
  return zones;
}

module.exports = {
  LAYERS,
  RECORD_FILES,
  EXCEPTIONS,
  TYPE_ONLY_ALLOWANCES,
  SHIMS,
  globToRegExp,
  compileLayers,
  rankOf,
  isRecordFile,
  listSourceFiles,
  layerZones,
};
