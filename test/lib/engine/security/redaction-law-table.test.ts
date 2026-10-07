/**
 * The redaction law as a TABLE — owner ruling (a):
 *
 *   A redaction policy covers EVERYTHING the library retains or serves — and
 *   NEVER the live heap or the resume checkpoint.
 *
 * Rows: the policy kind (`keys`, `patterns`, `fields`). Columns: every served
 * surface the narrowed docs once listed as "outside" (diagnostics, pause
 * payloads, a mapper's renamed copy) plus the channels that serve them
 * (nested subflows, inline and deferred recorders, the narrative, the redacted
 * snapshot, the logger). Each cell runs the same chart: the secret enters
 * state under the policy's name, is logged under that name, is copied by a
 * subflow `inputMapper` under NEW names twice (`copy`, then `again` one level
 * deeper), rides a pause payload, comes back through two `outputMapper`s
 * under two more names (`back`, `result`), and is carried by a thrown error
 * under its name in a best-effort fork. The run pauses inside the nested
 * subflow and resumes — on the same executor, and on a fresh one through JSON.
 *
 * Every served surface is serialized and grepped for the secret; each cell
 * also proves its surface was exercised (it holds the placeholder), so a
 * column can never pass vacuously. The law's other half is pinned at the
 * end: the checkpoint and the live heap hold the REAL value, and the resumed
 * run computes on it.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint, RedactionPolicy, RuntimeSnapshot } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { HOOK_NAMES } from '../../../../src/lib/recorder/hooks.js';

const SECRET = 'sk-law-table-7f3a';
const MASK = '[REDACTED]';
const LOG_MASK = 'REDACTED';

interface Row {
  readonly label: 'keys' | 'patterns' | 'fields';
  readonly policy: RedactionPolicy;
  /** The state key the policy selects. */
  readonly src: string;
  /** The value written under it (the secret, or a record holding it). */
  readonly value: () => unknown;
}

const ROWS: readonly Row[] = [
  { label: 'keys', policy: { keys: ['token'] }, src: 'token', value: () => SECRET },
  { label: 'patterns', policy: { patterns: [/token$/i] }, src: 'authToken', value: () => SECRET },
  {
    label: 'fields',
    policy: { fields: { profile: ['token'] } },
    src: 'profile',
    value: () => ({ name: 'Ada', token: SECRET }),
  },
];

/** The secret primitive inside a row's value. */
function secretOf(row: Row, state: Record<string, unknown>): unknown {
  const value = state[row.src];
  return row.label === 'fields' ? (value as { token: string }).token : value;
}

/** Cycle-safe serialization that keeps what a careless consumer would print: an Error's text and own fields. */
function dump(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return undefined;
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack, ...v };
    if (v instanceof Map) return [...v.entries()];
    if (v instanceof Set) return [...v];
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[seen]';
      seen.add(v);
    }
    return v;
  });
}

function buildChart(row: Row, logger: { lines: unknown[][] }) {
  const inner = flowChart<any>(
    'InnerRead',
    (scope) => {
      const again = scope.again; // a tracked read of the twice-renamed copy
      scope.$debug('again', again); // a diagnostic named after the copy
      scope.$debug(row.src, row.value()); // diagnostics named after the policy key
      scope.$error(row.src, row.value());
      scope.$metric(row.src, row.value());
      scope.$log({ [row.src]: row.value() }); // the policy name nested in a logged record
    },
    'inner-read',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: (scope: any) => ({ question: 'continue?', [row.src]: row.value(), again: scope.again }),
        resume: (scope: any, input: any) => {
          scope.answer = input?.ok === true;
        },
      },
      'ask',
    )
    .build();

  const outer = flowChart<any>(
    'OuterRead',
    (scope) => {
      scope.$debug('copy', scope.copy);
    },
    'outer-read',
  )
    .addSubFlowChartNext('sf-inner', inner, 'Inner', {
      inputMapper: (p: any) => ({ again: p.copy }),
      outputMapper: (out: any) => ({ back: out.again, answer: out.answer }),
    })
    .build();

  const logged =
    (level: string) =>
    (...args: unknown[]) => {
      logger.lines.push([level, ...args]);
    };

  return flowChart<any>(
    'Seed',
    (scope) => {
      scope[row.src] = row.value();
      scope.$debug(row.src, row.value());
    },
    'seed',
  )
    .addSubFlowChartNext('sf-outer', outer, 'Outer', {
      inputMapper: (p: any) =>
        row.label === 'fields' ? { person: p.profile, copy: p.profile.token } : { copy: p[row.src] },
      outputMapper: (out: any) => ({ result: out.back, answer: out.answer }),
    })
    .addFunction('Gate', () => undefined, 'gate')
    .addListOfFunction([
      {
        id: 'reject',
        name: 'Reject',
        fn: () => {
          // An upstream error that carries the request it failed on, under the policy's name.
          throw Object.assign(new Error('upstream rejected'), { [row.src]: row.value() });
        },
      },
      { id: 'pass', name: 'Pass', fn: () => undefined },
    ])
    .addFunction(
      'Finish',
      (scope) => {
        scope.$debug('result', scope.result);
        scope.seen = typeof scope.result === 'string';
      },
      'finish',
    )
    .setLogger({
      info: logged('info'),
      log: logged('log'),
      debug: logged('debug'),
      error: logged('error'),
      warn: logged('warn'),
    })
    .build();
}

/** A recorder on every hook of every channel, keeping each event it is served. */
function everyHook(id: string, sink: unknown[]) {
  const recorder: Record<string, unknown> = { id, toSnapshot: () => ({ name: id, data: sink }) };
  for (const hook of HOOK_NAMES) recorder[hook] = (event: unknown) => sink.push([hook, event]);
  return recorder as any;
}

interface Leg {
  readonly executor: FlowChartExecutor;
  readonly inline: unknown[];
  readonly deferred: unknown[];
  readonly logger: { lines: unknown[][] };
}

function newLeg(row: Row): Leg {
  const logger = { lines: [] as unknown[][] };
  const executor = new FlowChartExecutor(buildChart(row, logger));
  executor.setRedactionPolicy(row.policy);
  executor.enableNarrative();
  const inline: unknown[] = [];
  const deferred: unknown[] = [];
  executor.attachCombinedRecorder(everyHook('probe-inline', inline));
  executor.attachCombinedRecorder(everyHook('probe-deferred', deferred), { delivery: 'deferred' });
  return { executor, inline, deferred, logger };
}

/** The plain snapshot minus what is the live heap / the caller's own seed by design. */
function servedPlain(snapshot: RuntimeSnapshot): unknown {
  const { sharedState: _live, initialState: _seed, subflowResults, ...rest } = snapshot;
  const results = Object.fromEntries(
    Object.entries(subflowResults ?? {}).map(([key, result]) => {
      const { globalContext: _heap, ...treeContext } = result.treeContext;
      return [key, { ...result, treeContext }];
    }),
  );
  return { ...rest, subflowResults: results };
}

interface Surfaces {
  diagnostics: string;
  pause: string;
  mapperCopy: string;
  nestedSubflows: string;
  inlineRecorders: string;
  deferredRecorders: string;
  narrative: string;
  redactedSnapshot: string;
  logger: string;
}

async function collect(leg: Leg): Promise<Surfaces> {
  await leg.executor.drainObservers();
  const plain = leg.executor.getSnapshot();
  const redacted = leg.executor.getSnapshot({ redact: true });
  const events = [...leg.inline, ...leg.deferred] as Array<[string, any]>;
  const results = redacted.subflowResults ?? {};
  return {
    diagnostics: dump({
      plainTree: plain.executionTree,
      redactedTree: redacted.executionTree,
      emits: events.filter(([hook]) => hook === 'onEmit'),
      nested: Object.values(results).map((r) => r.treeContext.stageContexts),
    }),
    pause: dump(events.filter(([hook]) => hook === 'onPause')),
    mapperCopy: dump({
      entries: events.filter(([hook]) => hook === 'onSubflowEntry' || hook === 'onSubflowExit'),
      reads: events.filter(([hook]) => hook === 'onRead' || hook === 'onWrite' || hook === 'onCommit'),
      log: plain.commitLog,
      mirror: redacted.sharedState,
    }),
    nestedSubflows: dump(results),
    inlineRecorders: dump(leg.inline),
    deferredRecorders: dump(leg.deferred),
    narrative: dump(leg.executor.getNarrativeEntries()),
    redactedSnapshot: dump({ redacted, plain: servedPlain(plain) }),
    logger: dump(leg.logger.lines),
  };
}

const COLUMNS: ReadonlyArray<{ column: keyof Surfaces; exercised: string }> = [
  { column: 'diagnostics', exercised: MASK },
  { column: 'pause', exercised: MASK },
  { column: 'mapperCopy', exercised: MASK },
  { column: 'nestedSubflows', exercised: LOG_MASK },
  { column: 'inlineRecorders', exercised: MASK },
  { column: 'deferredRecorders', exercised: MASK },
  { column: 'narrative', exercised: MASK },
  { column: 'redactedSnapshot', exercised: MASK },
  // The logger is served the error's masked form: its text, never the thrown value that carries the key.
  { column: 'logger', exercised: 'upstream rejected' },
];

describe.each(ROWS)('the redaction law — policy by $label', (row) => {
  let paused: Surfaces;
  let resumed: Surfaces;
  let fresh: Surfaces;
  let checkpoint: FlowchartCheckpoint;
  let sameFinal: Record<string, unknown>;
  let freshFinal: Record<string, unknown>;

  beforeAll(async () => {
    const leg = newLeg(row);
    await leg.executor.run();
    expect(leg.executor.isPaused()).toBe(true);
    checkpoint = leg.executor.getCheckpoint()!;
    const stored = JSON.parse(JSON.stringify(checkpoint)) as FlowchartCheckpoint;
    paused = await collect(leg);

    await leg.executor.resume(checkpoint, { ok: true });
    resumed = await collect(leg);
    sameFinal = leg.executor.getSnapshot().sharedState as Record<string, unknown>;

    const second = newLeg(row);
    await second.executor.resume(stored, { ok: true });
    fresh = await collect(second);
    freshFinal = second.executor.getSnapshot().sharedState as Record<string, unknown>;
  });

  describe.each(COLUMNS)('$column', ({ column, exercised }) => {
    it('serves no secret before the pause, after a same-executor resume, or after a fresh-executor resume', () => {
      for (const surfaces of [paused, resumed, fresh]) {
        expect.soft(surfaces[column]).not.toContain(SECRET);
      }
    });

    it('was exercised: it serves the placeholder', () => {
      expect(resumed[column]).toContain(exercised);
    });
  });

  it('the checkpoint keeps the REAL values: pause payload, parent state and the nested captures', () => {
    const data = checkpoint.pauseData as Record<string, unknown>;
    expect(secretOf(row, data)).toBe(SECRET);
    expect(data.again).toBe(SECRET);
    expect(secretOf(row, checkpoint.sharedState as Record<string, unknown>)).toBe(SECRET);
    expect(dump(checkpoint.subflowStates)).toContain(SECRET);
  });

  it('the live heap keeps the REAL values and the resumed run computes on them (same and fresh executor)', () => {
    for (const final of [sameFinal, freshFinal]) {
      expect(secretOf(row, final)).toBe(SECRET);
      expect(final.result).toBe(SECRET);
      expect(final.answer).toBe(true);
      expect(final.seen).toBe(true);
    }
  });
});
