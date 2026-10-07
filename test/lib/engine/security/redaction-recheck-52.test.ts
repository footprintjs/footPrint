/**
 * PR #52's recheck: one run-failing walk and two cheap leaks — each pinned by
 * a test that failed before its fix.
 *
 *   1. a NAME pattern (`/password/i`) over a linked agent history is decided per
 *      object (linear, no throw); only a genuinely PATH-dependent pattern walks
 *      paths, and past the limit it masks the unvisited remainder — never a
 *      failed run;
 *   2. a mapper that mutates an object it passes on by reference
 *      (`Object.assign(p.request, { auth: p.token })`, `p.list.push(p.token)`);
 *   3. a stage that writes an OBJECT it read under a selected name under a new
 *      name (`s.person = s.profile`) hands the new name the same rule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { disableDevMode, enableDevMode } from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

const SECRET = 'sk-recheck52-SECRET';
const MASK = '[REDACTED]';

/** Every path in `root` whose string value holds the secret. */
function secretPaths(root: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (v.includes(SECRET)) out.push(path);
      return;
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`);
  };
  walk(root, '$');
  return out;
}

// ── 1 ────────────────────────────────────────────────────────────────────────

describe('1 — a pattern over a linked agent history', () => {
  /** 1,500 turns, each linking back to the one before, plus the array of all of them; getters count the work. */
  function history(turns: number) {
    const counter = { reads: 0 };
    const all: object[] = [];
    let prev: object | null = null;
    for (let i = 0; i < turns; i++) {
      const before = prev;
      const turn: Record<string, unknown> = { role: i % 2 ? 'user' : 'assistant', content: `turn ${i}` };
      if (i % 100 === 7) turn.userPassword = `${SECRET}-${i}`;
      Object.defineProperty(turn, 'prev', {
        enumerable: true,
        get: () => {
          counter.reads += 1;
          return before;
        },
      });
      all.push(turn);
      prev = turn;
    }
    return { record: { history: all, last: prev }, counter };
  }

  afterEach(() => disableDevMode());

  it('a NAME pattern is decided per object: linear work, no throw, every reference masked', () => {
    const { record, counter } = history(1500);
    const served = new RedactionRule({ patterns: [/password/i] }).retainBoundary(record) as any;
    expect(secretPaths(served)).toEqual([]);
    expect(served.history[7].userPassword).toBe(MASK);
    expect(served.last.prev.content).toBe('turn 1498');
    expect(served.history[1499]).toBe(served.last); // the copy keeps the sharing
    expect(counter.reads).toBeLessThanOrEqual(4 * 1500);
  });

  it('a run with that policy over that history completes, and serves nothing raw', async () => {
    const { record } = history(1500);
    const chart = flowChart<any>(
      'Load',
      (s) => {
        s.$debug('history', record.history);
      },
      'load',
    )
      .addFunction('Answer', () => record, 'answer')
      .build();
    const ex = new FlowChartExecutor(chart);
    ex.setRedactionPolicy({ patterns: [/password/i] });
    const ends: unknown[] = [];
    ex.attachFlowRecorder({ id: 'end', onRunEnd: (e) => ends.push(e.payload) });
    expect(await ex.run()).toBe(record);
    expect(secretPaths(ends)).toEqual([]);
    expect(secretPaths(ex.getSnapshot().executionTree)).toEqual([]);
  });

  it('a PATH pattern past the walk limit masks the unvisited remainder, warns once in dev mode, never throws', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { record } = history(1500);
      const rule = new RedactionRule({ patterns: [/^history\.\d+\.userPassword$/] });
      const served = rule.retainBoundary(record) as any;
      expect(served.history[7].userPassword).toBe(MASK); // the rule's own path, reached in time
      expect(served.last).toBe(MASK); // the unvisited remainder: the placeholder, never raw
      rule.retainBoundary(record);
      const named = warn.mock.calls.filter(([text]) => String(text).includes('userPassword'));
      expect(named).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('2 — a mapper that mutates an object it passes on by reference', () => {
  it.each([
    ['Object.assign', (p: any) => ({ request: Object.assign(p.request, { auth: p.token }) }), 'request'],
    [
      'push',
      (p: any) => {
        p.list.push(p.token);
        return { list: p.list };
      },
      'list',
    ],
  ] as const)('%s: the subflow serves the planted secret masked', async (_label, inputMapper, key) => {
    const sub = flowChart<any>(
      'S',
      (s) => {
        s.seen = typeof s[key];
      },
      's',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.token = SECRET;
        s.request = { url: '/x' };
        s.list = ['a'];
      },
      'seed',
    )
      .addSubFlowChartNext('sf', sub, 'Sf', { inputMapper })
      .build();
    const ex = new FlowChartExecutor(chart);
    ex.setRedactionPolicy({ keys: ['token'] });
    await ex.run();
    const red = ex.getSnapshot({ redact: true });
    expect(secretPaths(red.subflowResults)).toEqual([]);
    const mirror = red.subflowResults!.sf.treeContext.globalContext as any;
    expect(key === 'request' ? mirror.request.url : mirror.list[0]).toBe(key === 'request' ? '/x' : 'a');
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

describe('3 — a stage that writes an object it read under a selected name, under a new name', () => {
  it('s.person = s.profile: person.ssn inherits profile’s rule', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.profile = { name: 'Ada', ssn: SECRET };
      },
      'seed',
    )
      .addFunction(
        'Copy',
        (s) => {
          s.person = s.profile;
          s.whole = s.vault;
        },
        'copy',
      )
      .build();
    const ex = new FlowChartExecutor(chart, { initialContext: { vault: { pin: SECRET } } });
    ex.setRedactionPolicy({ fields: { profile: ['ssn'] }, keys: ['vault'] });
    const writes: unknown[] = [];
    ex.attachScopeRecorder({ id: 'w', onWrite: (e) => writes.push(e), onCommit: (e) => writes.push(e) });
    await ex.run();
    const red = ex.getSnapshot({ redact: true });
    expect((red.sharedState as any).person).toEqual({ name: 'Ada', ssn: 'REDACTED' });
    expect((red.sharedState as any).whole).toBe('REDACTED');
    expect(secretPaths({ writes, log: red.commitLog, tree: red.executionTree })).toEqual([]);
    expect((ex.getSnapshot().sharedState as any).person.ssn).toBe(SECRET); // the live heap is real
  });

  it('a NEW object or a primitive copied across names stays a named limit (by name only)', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.profile = { name: 'Ada', ssn: SECRET };
        s.copy = { ...s.profile };
      },
      'seed',
    ).build();
    const ex = new FlowChartExecutor(chart);
    ex.setRedactionPolicy({ fields: { profile: ['ssn'] } });
    await ex.run();
    expect((ex.getSnapshot({ redact: true }).sharedState as any).copy.ssn).toBe(SECRET);
  });
});
