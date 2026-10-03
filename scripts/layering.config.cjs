'use strict';
/**
 * layering.config.cjs — the footprintjs layer table, as data.
 *
 * ONE owner for the fence. Three readers, none keeps a copy:
 *   - `.eslintrc.js`                        → `import/no-restricted-paths` zones (`layerZones`)
 *   - `scripts/check-layering.mjs`          → value-level cycles + upward edges
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
 *   L2 staging and commit       one stage's ops → one net-change bundle; the next generation
 *   L3 the log as a read model  what a finished log can honestly say (slice/, time-travel/)
 *   L4 the frame and run policy one stage's frame; the run's runtime
 *   L5 scope, recorders, hooks  what a stage may do; how every event reaches every recorder
 *   L6 engine                   walking the chart: one phase chain, one id grammar
 *   L7 builder and executor     the DSL and the run lifecycle
 *   L8 entry points             src/*.ts — the public barrels; may import anything
 *
 * Only RUNTIME edges are the law. A type-only import is erased by tsc and is not an edge;
 * the script ignores it. ESLint's `import/no-restricted-paths` cannot tell the two apart,
 * so the few upward type-only imports that exist today are named in TYPE_ONLY_ALLOWANCES.
 * That list only ever shrinks.
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
      // The path codec, structural equality and the union merge: leaves that import nothing
      // (split out of utils.ts in F2). The verb law (verbs.ts) reads them from L1.
      'src/lib/memory/paths.ts',
      'src/lib/memory/equality.ts',
      'src/lib/memory/merge.ts',
      // The honesty vocabulary (F4a): code → the one sentence; imports nothing, typed through from L3.
      'src/lib/memory/honesty.ts',
      // The two redaction placeholders (F4a): import nothing; written from L2 (redaction.ts) up.
      'src/lib/memory/placeholders.ts',
      // Which rows touch a key — the path half of the writer rule and the writer index (F3).
      // Imports the path codec and types only; staging (L2) and every log reader (L3) ask it.
      'src/lib/memory/keyPaths.ts',
      // The id grammar (F7): `runtimeStageId.ts` (the one owner — build/parse/read/refuse) and
      // `branchSegment.ts` (the generated `~` segment). Pure leaves: time-travel/ (L3), scope/ and
      // recorder/ (L5) read them, so they cannot sit above L0 — and they left engine/ in F7 because
      // a scope → engine edge closes the engine ⇄ scope ⇄ recorder module cycle.
      'src/lib/ids/**',
      // `assertNotReadonly` / `createFrozenArgs`: a leaf under scope/protection (it imports
      // capture/ only). The freeze walk itself moved to `capture/freeze.ts` in F3, so that
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
      'src/lib/memory/redaction.ts',
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
      'src/lib/memory/commitLogUtils.ts',
      // The read model of one log: the writer and value rules at a cost proportional to the answer (F3).
      'src/lib/memory/logModel.ts',
      'src/lib/memory/backtrack.ts',
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
      'scope → detach/spawn.ts: `$spawn` delegates to the one detach primitive the executor also uses. spawn.ts never imports ' +
      'scope/, and the executor is only reached lazily (detach/runChild.ts).',
  },
];

/**
 * Upward imports that are TYPE-ONLY today (erased by tsc: no runtime edge, the script
 * ignores them) but that `import/no-restricted-paths` would flag. Each must stay type-only
 * — the script fails if one of these edges becomes a runtime import.
 */
const TYPE_ONLY_ALLOWANCES = [
  {
    from: 'src/lib/memory/types.ts',
    to: 'src/lib/memory/StageContext.ts',
    reason:
      '`ScopeFactory<TScope>` is declared over the StageContext frame type, in the types hub every memory layer imports.',
  },
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

/** Every `.ts` file (no `.d.ts`) under `<root>/src`, repo-relative and sorted. */
function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts'))
        out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

// ── ESLint zones ─────────────────────────────────────────────────────────────

/**
 * `import/no-restricted-paths` zones for `.eslintrc.js`, derived from the table: one zone
 * per layer (its files may not import files of a higher layer), plus one zone per file
 * that carries a named edge, with exactly that edge cut out. `except` is not used —
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
  return zones;
}

module.exports = {
  LAYERS,
  EXCEPTIONS,
  TYPE_ONLY_ALLOWANCES,
  SHIMS,
  globToRegExp,
  compileLayers,
  rankOf,
  listSourceFiles,
  layerZones,
};
