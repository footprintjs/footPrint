/**
 * PR #52's review: four leaks, two risks, one bug — each pinned by a test
 * that failed before its fix (the reviewer's probes, turned into assertions).
 *
 *   1. a taint (or a per-call mark) made before a pause survives the resume;
 *   2. a mapper that hands on the WHOLE record it was handed;
 *   3. a thrown value whose key sits under `Error.cause` / `AggregateError.errors`;
 *   4. the `parallelForEach` items selector is a mapper boundary;
 *   5. a clear value passed under its OWN name stays clear (no run-wide over-masking);
 *   6. `onRunStart` under a policy walks the leg's snapshot, never the live input;
 *   7. the path walk on a DAG: linear work, never masked whole on a budget.
 */
import { describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint, RedactionPolicy } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';
import { decodeCheckpoint } from '../../../../src/lib/pause/record.js';
import { HOOK_NAMES } from '../../../../src/lib/recorder/hooks.js';

const SECRET = 'sk-rev52-SECRET-7c';
const MASK = '[REDACTED]';

/** Cycle-safe serialization that prints what a careless consumer would: an Error's text, own fields, cause and errors. */
function dump(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return undefined;
    if (v instanceof Error) {
      const extra = v as Error & { cause?: unknown; errors?: unknown };
      return { name: v.name, message: v.message, cause: extra.cause, errors: extra.errors, ...v };
    }
    if (v instanceof Map) return [...v.entries()];
    if (v instanceof Set) return [...v];
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[seen]';
      seen.add(v);
    }
    return v;
  });
}

function everyHook(id: string, sink: unknown[]) {
  const recorder: Record<string, unknown> = { id, toSnapshot: () => ({ name: id, data: sink }) };
  for (const hook of HOOK_NAMES) recorder[hook] = (event: unknown) => sink.push([hook, event]);
  return recorder as any;
}

function logger(lines: unknown[][]) {
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push([level, ...args]);
  return { info: at('info'), log: at('log'), debug: at('debug'), error: at('error'), warn: at('warn') };
}

interface Leg {
  ex: FlowChartExecutor;
  inline: unknown[];
  deferred: unknown[];
  lines: unknown[][];
}

function newLeg(build: (lines: unknown[][]) => any, policy: RedactionPolicy): Leg {
  const lines: unknown[][] = [];
  const ex = new FlowChartExecutor(build(lines));
  ex.setRedactionPolicy(policy);
  ex.enableNarrative();
  const inline: unknown[] = [];
  const deferred: unknown[] = [];
  ex.attachCombinedRecorder(everyHook('inline', inline));
  ex.attachCombinedRecorder(everyHook('deferred', deferred), { delivery: 'deferred' });
  return { ex, inline, deferred, lines };
}

/** Every served surface that shows the secret (the live heap and the checkpoint are not served). */
async function leaks(leg: Leg): Promise<string[]> {
  await leg.ex.drainObservers();
  const red = leg.ex.getSnapshot({ redact: true });
  const { sharedState: _live, initialState: _seed, subflowResults, ...plain } = leg.ex.getSnapshot();
  const results = Object.fromEntries(
    Object.entries(subflowResults ?? {}).map(([key, r]) => {
      const { globalContext: _heap, ...treeContext } = r.treeContext;
      return [key, { ...r, treeContext }];
    }),
  );
  const where: Record<string, unknown> = {
    inline: leg.inline,
    deferred: leg.deferred,
    narrative: leg.ex.getNarrativeEntries(),
    redactedSnapshot: red,
    plainServed: { ...plain, subflowResults: results },
    logger: leg.lines,
  };
  return Object.entries(where)
    .filter(([, v]) => dump(v).includes(SECRET))
    .map(([k]) => k);
}

// ── 1 ────────────────────────────────────────────────────────────────────────

describe('1 — a taint made before a pause survives the resume', () => {
  const policy = { keys: ['token'] };
  function chart(lines: unknown[][]) {
    const sub = flowChart<any>(
      'SubRead',
      (s) => {
        s.$debug('tok', s.tok);
      },
      'sub-read',
    ).build();
    return flowChart<any>(
      'Seed',
      (s) => {
        s.token = SECRET;
        s.$setValue('pin', `${SECRET}-pin`, true); // a per-call mark, made before the pause
      },
      'seed',
    )
      .addSubFlowChartNext('sf-a', sub, 'A', {
        inputMapper: (p: any) => ({ tok: p.token }),
        outputMapper: (out: any) => ({ tokBack: out.tok }),
      })
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ q: 'ok?' }),
          resume: (s: any) => {
            s.answer = true;
          },
        },
        'ask',
      )
      .addFunction(
        'Use',
        (s) => {
          const t = s.tokBack;
          s.$debug('tokBack', t);
          s.seenPin = String(s.pin).length;
          return { tokBack: t, pin: s.pin };
        },
        'use',
      )
      .setLogger(logger(lines))
      .build();
  }

  it.each(['same', 'fresh'] as const)('%s executor: nothing served after the resume shows the copy', async (mode) => {
    const first = newLeg(chart, policy);
    await first.ex.run();
    const checkpoint = first.ex.getCheckpoint()!;
    // Names only — never a value.
    expect(checkpoint.redactionMarks?.keys).toEqual(expect.arrayContaining(['token', 'pin', 'tok', 'tokBack']));
    expect(dump(checkpoint.redactionMarks)).not.toContain(SECRET);
    const leg = mode === 'same' ? first : newLeg(chart, policy);
    const stored = JSON.parse(JSON.stringify(checkpoint)) as FlowchartCheckpoint;
    await leg.ex.resume(mode === 'same' ? checkpoint : stored, { ok: true });
    expect(await leaks(leg)).toEqual([]);
    const live = leg.ex.getSnapshot().sharedState;
    expect(live.tokBack).toBe(SECRET);
    expect(live.seenPin).toBe(`${SECRET}-pin`.length);
  });

  it('a taint made inside a subflow on the pause path survives too', async () => {
    const build = (lines: unknown[][]) => {
      const leaf = flowChart<any>(
        'LeafRead',
        (s) => {
          s.$debug('t', s.t);
        },
        'leaf-read',
      ).build();
      const mid = flowChart<any>('MidStart', () => undefined, 'mid-start')
        .addSubFlowChartNext('sf-leaf', leaf, 'Leaf', {
          inputMapper: (p: any) => ({ t: p.inTok }),
          outputMapper: (out: any) => ({ leafBack: out.t }),
        })
        .addPausableFunction(
          'MidAsk',
          {
            execute: () => ({ q: 'ok?' }),
            resume: (s: any) => {
              s.answer = true;
            },
          },
          'mid-ask',
        )
        .addFunction(
          'MidUse',
          (s) => {
            s.$debug('leafBack', s.leafBack);
          },
          'mid-use',
        )
        .build();
      return flowChart<any>(
        'Seed',
        (s) => {
          s.token = SECRET;
        },
        'seed',
      )
        .addSubFlowChartNext('sf-mid', mid, 'Mid', {
          inputMapper: (p: any) => ({ inTok: p.token }),
          outputMapper: (out: any) => ({ answer: out.answer }),
        })
        .setLogger(logger(lines))
        .build();
    };
    for (const mode of ['same', 'fresh'] as const) {
      const first = newLeg(build, policy);
      await first.ex.run();
      const checkpoint = first.ex.getCheckpoint()!;
      const leg = mode === 'same' ? first : newLeg(build, policy);
      await leg.ex.resume(mode === 'same' ? checkpoint : JSON.parse(JSON.stringify(checkpoint)), { ok: true });
      expect(await leaks(leg)).toEqual([]);
    }
  });

  it('the codec checks the record: names only, refused when malformed', () => {
    const base = { sharedState: {}, executionTree: {}, pausedStageId: 'ask', subflowPath: [], subflowStates: {} };
    expect(decodeCheckpoint({ ...base, redactionMarks: { keys: ['a'], fields: { b: ['c'] } } }).redactionMarks).toEqual(
      {
        keys: ['a'],
        fields: { b: ['c'] },
      },
    );
    expect(() => decodeCheckpoint({ ...base, redactionMarks: { keys: 'a' } })).toThrow(
      'Invalid checkpoint: redactionMarks.keys must be an array of strings.',
    );
    expect(() => decodeCheckpoint({ ...base, redactionMarks: { keys: [], fields: { b: [1] } } })).toThrow(
      'Invalid checkpoint: redactionMarks.fields must map keys to arrays of strings.',
    );
  });

  it('without a policy or a mark the checkpoint has no record', async () => {
    const ex = new FlowChartExecutor(
      flowChart<any>('Seed', () => undefined, 'seed')
        .addPausableFunction('Ask', { execute: () => ({ q: 1 }), resume: () => undefined }, 'ask')
        .build(),
    );
    await ex.run();
    expect(Object.keys(ex.getCheckpoint()!)).not.toContain('redactionMarks');
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('2 — a mapper that hands on the WHOLE record it was handed', () => {
  it.each(['input', 'output'] as const)('%sMapper: the copy keeps every selected key of the record', async (side) => {
    const build = (lines: unknown[][]) => {
      const sub =
        side === 'input'
          ? flowChart<any>(
              'S',
              (s) => {
                s.seen = typeof s.ctx;
              },
              's',
            ).build()
          : flowChart<any>(
              'S2',
              (s) => {
                s.seen = typeof s.token2; // reads the tainted copy, writes nothing of it
              },
              's2',
            ).build();
      return flowChart<any>(
        'Seed',
        (s) => {
          s.token = SECRET;
          s.label = 'visible';
        },
        'seed',
      )
        .addSubFlowChartNext(
          'sf',
          sub,
          'Sf',
          side === 'input'
            ? { inputMapper: (p: any) => ({ ctx: p }) }
            : { inputMapper: (p: any) => ({ token2: p.token }), outputMapper: (out: any) => ({ sub: out }) },
        )
        .setLogger(logger(lines))
        .build();
    };
    const leg = newLeg(build, { keys: ['token'] });
    await leg.ex.run();
    expect(await leaks(leg)).toEqual([]);
    const red = leg.ex.getSnapshot({ redact: true });
    if (side === 'input') {
      const mirror = red.subflowResults!.sf.treeContext.globalContext as any;
      expect(mirror.ctx.token).toBe('REDACTED');
      expect(mirror.ctx.label).toBe('visible'); // exact: only the selected key
    } else {
      expect((red.sharedState as any).sub.token2).toBe('REDACTED');
      expect((red.sharedState as any).sub.seen).toBe('string');
    }
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

describe('3 — a thrown value whose key sits under Error.cause / AggregateError.errors', () => {
  it.each(['cause', 'aggregate', 'cyclic cause'] as const)('%s: served masked to every observer', async (shape) => {
    const thrown = () => {
      if (shape === 'cause') return new Error('upstream rejected', { cause: { token: SECRET } });
      if (shape === 'aggregate') {
        return new AggregateError([Object.assign(new Error('inner'), { token: SECRET })], 'upstream rejected');
      }
      const error = new Error('upstream rejected', { cause: { token: SECRET } }) as Error & { cause: any };
      error.cause.back = error;
      return error;
    };
    const build = (lines: unknown[][]) =>
      flowChart<any>('Seed', () => undefined, 'seed')
        .addListOfFunction([
          {
            id: 'reject',
            name: 'Reject',
            fn: () => {
              throw thrown();
            },
          },
          { id: 'pass', name: 'Pass', fn: () => undefined },
        ])
        .setLogger(logger(lines))
        .build();
    const leg = newLeg(build, { keys: ['token'] });
    await leg.ex.run();
    expect(await leaks(leg)).toEqual([]);
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe('4 — the parallelForEach items selector is a mapper boundary', () => {
  it('an item copied from a selected key is masked in the branch and in the results', async () => {
    const build = (lines: unknown[][]) => {
      const branch = flowChart<any>(
        'B',
        (s) => {
          s.$debug('item', s.item);
        },
        'b',
      ).build();
      return flowChart<any>(
        'Seed',
        (s) => {
          s.token = SECRET;
        },
        'seed',
      )
        .addParallelForEach('Fan', 'fan', {
          items: (s: any) => [s.token],
          branch: () => branch,
          into: 'outs',
          maxBranches: 4,
        })
        .setLogger(logger(lines))
        .build();
    };
    const leg = newLeg(build, { keys: ['token'] });
    await leg.ex.run();
    expect(await leaks(leg)).toEqual([]);
    expect((leg.ex.getSnapshot().sharedState as any).outs[0].item).toBe(SECRET); // the live heap is real
  });

  it('a selector that reads nothing selected marks nothing', async () => {
    const branch = flowChart<any>('B', () => undefined, 'b').build();
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.token = SECRET;
        s.list = ['a', 'b'];
      },
      'seed',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s: any) => s.list,
        branch: () => branch,
        into: 'outs',
        maxBranches: 4,
      })
      .build();
    const ex = new FlowChartExecutor(chart);
    ex.setRedactionPolicy({ keys: ['token'] });
    await ex.run();
    expect((ex.getSnapshot({ redact: true }).sharedState as any).outs[0].item).toBe('a');
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────

describe('5 — a clear value passed under its OWN name stays clear', () => {
  it('{ key: p.apiKey, count: p.count }: the new name is masked, `count` stays visible in the parent', async () => {
    const sub = flowChart<any>(
      'S',
      (s) => {
        s.seen = s.count;
      },
      's',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.apiKey = SECRET;
        s.count = 3;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', sub, 'Sf', { inputMapper: (p: any) => ({ key: p.apiKey, count: p.count }) })
      .addFunction(
        'Later',
        (s) => {
          s.count = s.count + 1;
        },
        'later',
      )
      .build();
    const ex = new FlowChartExecutor(chart);
    ex.setRedactionPolicy({ keys: ['apiKey'] });
    const writes: Array<[string, unknown]> = [];
    ex.attachScopeRecorder({ id: 'w', onWrite: (e) => writes.push([e.key, e.value]) });
    await ex.run();
    expect(writes).toContainEqual(['count', 4]);
    const red = ex.getSnapshot({ redact: true });
    expect((red.sharedState as any).count).toBe(4);
    const mirror = red.subflowResults!.sf.treeContext.globalContext as any;
    expect(mirror.key).toBe('REDACTED');
    expect(mirror.count).toBe(3);
    expect(ex.getRedactionReport().redactedKeys).not.toContain('count');
  });

  it('{ ...p }: every key keeps its own verdict', async () => {
    const sub = flowChart<any>('S', () => undefined, 's').build();
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.apiKey = SECRET;
        s.userId = 'u-1';
      },
      'seed',
    )
      .addSubFlowChartNext('sf', sub, 'Sf', { inputMapper: (p: any) => ({ ...p }) })
      .addFunction(
        'Later',
        (s) => {
          s.userId = 'u-2';
        },
        'later',
      )
      .build();
    const ex = new FlowChartExecutor(chart);
    ex.setRedactionPolicy({ keys: ['apiKey'] });
    await ex.run();
    const red = ex.getSnapshot({ redact: true });
    expect(red.sharedState).toMatchObject({ apiKey: 'REDACTED', userId: 'u-2' });
    expect(red.subflowResults!.sf.treeContext.globalContext).toMatchObject({ apiKey: 'REDACTED', userId: 'u-1' });
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────

describe('6 — onRunStart under a policy walks the leg snapshot, never the live input', () => {
  it('a counting getter: zero reads at construction, exactly one per leg, with a policy', async () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'snapshot-value' : `${SECRET}-later`;
      },
    });
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.seen = (s.$getArgs() as { token: string }).token;
      },
      'seed',
    ).build();
    const ex = new FlowChartExecutor(chart, { readOnlyContext: input });
    ex.setRedactionPolicy({ keys: ['other'] });
    const starts: unknown[] = [];
    ex.attachFlowRecorder({ id: 'start', onRunStart: (e) => starts.push(e.payload) });
    expect(reads).toBe(0);
    await ex.run();
    expect(reads).toBe(1);
    expect(ex.getSnapshot().sharedState.seen).toBe('snapshot-value');
    expect(starts).toEqual([{ token: 'snapshot-value' }]);
  });
});

// ── 7 ────────────────────────────────────────────────────────────────────────

describe('7 — the path walk on a DAG: linear work, never masked whole', () => {
  /** A DAG whose every level points twice at the next: 2^depth paths, depth+1 objects; getters count the work. */
  function dag(depth: number, leaf: Record<string, unknown>) {
    const counter = { reads: 0 };
    const count = (next: object): object => {
      counter.reads += 1;
      return next;
    };
    let node: object = leaf;
    for (let i = 0; i < depth; i++) {
      const next = node;
      node = Object.defineProperties(
        {},
        {
          l: { enumerable: true, get: () => count(next) },
          r: { enumerable: true, get: () => count(next) },
        },
      );
    }
    return { root: { tree: node }, counter };
  }

  it('an unrelated name rule: served as itself, in work linear in the objects', () => {
    const { root, counter } = dag(21, { leaf: 'x' });
    const started = Date.now();
    expect(new RedactionRule({ keys: ['nothing'] }).retainBoundary(root)).toBe(root);
    expect(counter.reads).toBeLessThanOrEqual(4 * 21);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('a selected name inside the DAG: masked at every path, the copy shares its nodes, linear work', () => {
    const { root, counter } = dag(21, { leaf: SECRET, keep: 'k' });
    const served = new RedactionRule({ keys: ['leaf'] }).retainBoundary(root) as any;
    let at = served.tree;
    for (let i = 0; i < 21; i++) {
      expect(at.l).toBe(at.r); // the served copy is a DAG too
      at = at.l;
    }
    expect(at).toEqual({ leaf: MASK, keep: 'k' });
    expect(counter.reads).toBeLessThanOrEqual(8 * 21);
  });

  it('a pattern rule over a DAG past the walk limit fails loudly, by name — never a whole-value placeholder', () => {
    const { root } = dag(21, { leaf: 'x' });
    expect(() => new RedactionRule({ patterns: [/nothing/] }).retainBoundary(root)).toThrow(
      expect.objectContaining({ name: 'RedactionWalkLimitError' }),
    );
  });
});
