/**
 * The 9.19.0 redaction law, pinned end to end:
 *
 *   A redaction policy covers EVERYTHING RETAINED OR SERVED — the commit log
 *   (both encodings), the redacted mirror, stage reads/writes retention, the
 *   narrative, a subflow's seed and merge-back — and NEVER the live heap the
 *   run computes on nor the resume checkpoint.
 *
 * Each `describe` below is one of the five paths that bypassed the policy on
 * 9.18.1 (measured by two agentfootprint reviewers; each was pinned there as
 * a "substrate limit"), plus the law's other half — the live values that
 * must NOT be scrubbed — and the fold consistency (`stateAt` over the
 * scrubbed log agrees with the mirror).
 */

import type { CommitValuesMode, FlowSubflowEvent, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stateAt, timeTravel } from '../../../../src/trace.js';

const SECRET = 'sk-live-SUPER-SECRET-BYTES';
const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

const bytes = (v: unknown) => JSON.stringify(v);

// ── Leak 1 · outputMapper merge-back (SubflowInputMapper · applyOutputMapping) ──

describe('leak 1 — a subflow outputMapper merges back through StageContext, not the facade', () => {
  interface Inner {
    innerKey: string;
    extra: string[];
    nested: { innerKey: string; ok: boolean };
  }
  interface Outer {
    start: number;
    innerKey?: string;
    extra?: string[];
    nested?: { innerKey: string; ok: boolean };
  }

  function build() {
    const inner = flowChart<Inner>(
      'Inside',
      (scope: TypedScope<Inner>) => {
        scope.innerKey = SECRET;
        scope.extra = [SECRET];
        scope.nested = { innerKey: SECRET, ok: true };
      },
      'inside',
    ).build();
    return flowChart<Outer>(
      'Start',
      (scope: TypedScope<Outer>) => {
        scope.start = 1;
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', {
        inputMapper: () => ({}),
        outputMapper: (out: Inner) => ({ innerKey: out.innerKey, extra: out.extra, nested: out.nested }),
      })
      .build();
  }

  it.each(ENCODINGS)('the PARENT log, mirror and fold hold the placeholder (%s)', async (commitValues) => {
    const executor = new FlowChartExecutor(build(), { commitValues });
    executor.setRedactionPolicy({ keys: ['innerKey', 'extra'], fields: { nested: ['innerKey'] } });
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(bytes(snapshot.commitLog)).not.toContain(SECRET);
    const mount = snapshot.commitLog.find((b) => b.stageId === 'sf' && b.trace.length > 0)!;
    expect(mount.overwrite.innerKey).toBe('REDACTED');
    expect(mount.overwrite.extra).toBe('REDACTED');
    expect((mount.overwrite.nested as { innerKey: string; ok: boolean }).ok).toBe(true);
    expect((mount.overwrite.nested as { innerKey: string }).innerKey).toBe('REDACTED');

    const mirror = executor.getSnapshot({ redact: true }).sharedState as Outer;
    expect(mirror.innerKey).toBe('REDACTED');
    expect(mirror.extra).toBe('REDACTED');
    expect(mirror.nested).toEqual({ innerKey: 'REDACTED', ok: true });

    const folded = stateAt(snapshot, snapshot.commitLog.length - 1);
    expect(folded.state.innerKey).toBe('REDACTED');
    expect(folded.state.nested).toEqual({ innerKey: 'REDACTED', ok: true });

    // The law's other half: the live heap computed on the real value.
    const live = snapshot.sharedState as Outer;
    expect(live.innerKey).toBe(SECRET);
    expect(live.extra).toEqual([SECRET]);
    expect(live.nested).toEqual({ innerKey: SECRET, ok: true });
  });

  it('a key marked per-call inside the subflow is scrubbed in the parent log too', async () => {
    const inner = flowChart<{ card: string }>(
      'Inside',
      (scope: TypedScope<{ card: string }>) => {
        scope.$setValue('card', SECRET, true);
      },
      'inside',
    ).build();
    const chart = flowChart<{ start: number; card?: string }>(
      'Start',
      (scope) => {
        scope.start = 1;
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', { outputMapper: (out: { card: string }) => ({ card: out.card }) })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({});
    await executor.run();
    expect(bytes(executor.getSnapshot().commitLog)).not.toContain(SECRET);
    expect((executor.getSnapshot({ redact: true }).sharedState as { card: string }).card).toBe('REDACTED');
    expect((executor.getSnapshot().sharedState as { card: string }).card).toBe(SECRET);
  });
});

// ── Leak 2 + 3 · inputMapper seed (seedSubflowGlobalStore) and its narrative "Input:" line ──

describe('leak 2 + 3 — an inputMapper seed is the subflow’s history[0] and its narrative Input: line', () => {
  interface Inner {
    apiKey: string;
    profile: { auth: { token: string }; name: string };
    seen: number;
  }
  interface Outer {
    apiKey: string;
    profile: { auth: { token: string }; name: string };
    seen?: number;
  }

  function build() {
    const inner = flowChart<Inner>(
      'Inside',
      (scope: TypedScope<Inner>) => {
        // The subflow computes on the REAL seed.
        scope.seen = scope.apiKey.length + scope.profile.auth.token.length;
      },
      'inside',
    ).build();
    return flowChart<Outer>(
      'Start',
      (scope: TypedScope<Outer>) => {
        scope.apiKey = SECRET;
        scope.profile = { auth: { token: SECRET }, name: 'n' };
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', {
        inputMapper: (parent: Outer) => ({ apiKey: parent.apiKey, profile: parent.profile }),
        outputMapper: (out: Inner) => ({ seen: out.seen }),
      })
      .build();
  }

  const policy = { keys: ['apiKey'], fields: { profile: ['auth.token'] } };

  it.each(ENCODINGS)(
    'history[0] holds the placeholder; the subflow still computed on the real seed (%s)',
    async (commitValues) => {
      const executor = new FlowChartExecutor(build(), { commitValues });
      executor.setRedactionPolicy(policy);
      await executor.run();

      const snapshot = executor.getSnapshot();
      expect((snapshot.sharedState as Outer).seen).toBe(SECRET.length * 2);

      const sf = (snapshot.subflowResults as Record<string, { treeContext: { history: unknown[] } }>).sf;
      const seed = sf.treeContext.history[0] as { overwrite: Record<string, unknown>; redactedPaths: string[] };
      expect(seed.overwrite.apiKey).toBe('REDACTED');
      expect((seed.overwrite.profile as { auth: { token: string }; name: string }).auth.token).toBe('REDACTED');
      expect((seed.overwrite.profile as { name: string }).name).toBe('n');
      expect(bytes(sf.treeContext.history)).not.toContain(SECRET);
      // The subflow's own fold agrees with its log.
      const folded = stateAt({ ...snapshot, commitLog: sf.treeContext.history as never, initialState: {} }, 0);
      expect(folded.state.apiKey).toBe('REDACTED');
    },
  );

  it('the narrative "Input:" line and every onSubflowEntry mappedInput carry the placeholder', async () => {
    const executor = new FlowChartExecutor(build());
    executor.setRedactionPolicy(policy);
    executor.enableNarrative({ includeValues: true });
    const seen: FlowSubflowEvent[] = [];
    executor.attachFlowRecorder({
      id: 'watch',
      onSubflowEntry(event: FlowSubflowEvent) {
        seen.push(event);
      },
    });
    await executor.run();

    const entries = executor.getNarrativeEntries();
    const inputLines = entries.filter((e) => e.text.startsWith('Input:'));
    expect(inputLines.length).toBeGreaterThan(0);
    expect(bytes(entries)).not.toContain(SECRET);
    expect(inputLines.find((e) => e.key === 'apiKey')!.text).toContain('[REDACTED]');
    expect(inputLines.find((e) => e.key === 'apiKey')!.rawValue).toBe('[REDACTED]');
    expect((inputLines.find((e) => e.key === 'profile')!.rawValue as Outer['profile']).auth.token).toBe('[REDACTED]');

    expect(seen).toHaveLength(1);
    expect(seen[0].mappedInput!.apiKey).toBe('[REDACTED]');
    expect((seen[0].mappedInput!.profile as Outer['profile']).auth.token).toBe('[REDACTED]');
    expect((seen[0].mappedInput!.profile as Outer['profile']).name).toBe('n');
  });
});

// ── Leak 4 · tracked-read retention (StageContext · getValue → stageReads) ──

describe('leak 4 — a tracked READ of a redacted key is retained as the placeholder', () => {
  interface S {
    apiKey: string;
    profile: { auth: { token: string }; name: string };
    used: number;
  }
  function build() {
    return flowChart<S>(
      'Write',
      (scope: TypedScope<S>) => {
        scope.apiKey = SECRET;
        scope.profile = { auth: { token: SECRET }, name: 'n' };
      },
      'write',
    )
      .addFunction(
        'Read',
        (scope: TypedScope<S>) => {
          scope.used = scope.apiKey.length + scope.profile.auth.token.length;
        },
        'read',
      )
      .build();
  }
  const policy = { keys: ['apiKey'], fields: { profile: ['auth.token'] } };

  it('executionTree.*.stageReads holds the placeholder while the stage read the real value', async () => {
    const executor = new FlowChartExecutor(build());
    executor.setRedactionPolicy(policy);
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect((snapshot.sharedState as S).used).toBe(SECRET.length * 2);
    const reads = snapshot.executionTree.next!.stageReads as Record<string, unknown>;
    expect(reads.apiKey).toBe('[REDACTED]');
    expect((reads.profile as S['profile']).auth.token).toBe('[REDACTED]');
    expect((reads.profile as S['profile']).name).toBe('n');
    expect(bytes(snapshot.executionTree)).not.toContain(SECRET);
  });

  it('readTracking: summary retains the placeholder, never a preview of the secret', async () => {
    const executor = new FlowChartExecutor(build(), { readTracking: 'summary' });
    executor.setRedactionPolicy(policy);
    await executor.run();
    const reads = executor.getSnapshot().executionTree.next!.stageReads as Record<string, unknown>;
    expect(reads.apiKey).toBe('[REDACTED]');
    expect(bytes(reads)).not.toContain(SECRET.slice(0, 8));
  });

  it('a policy key seeded by initialContext and only ever READ is scrubbed on the wire too', async () => {
    const chart = flowChart<{ apiKey: string; used: number }>(
      'Read',
      (scope) => {
        scope.used = scope.apiKey.length;
      },
      'read',
    ).build();
    const executor = new FlowChartExecutor(chart, { initialContext: { apiKey: SECRET } });
    executor.setRedactionPolicy({ keys: ['apiKey'] });
    const reads: unknown[] = [];
    executor.attachScopeRecorder({
      id: 'r',
      onRead(e) {
        reads.push(e.value);
      },
    });
    executor.enableNarrative({ includeValues: true });
    await executor.run();
    expect(reads).toEqual(['[REDACTED]']);
    expect(bytes(executor.getNarrativeEntries())).not.toContain(SECRET);
    expect(bytes(executor.getSnapshot().executionTree)).not.toContain(SECRET);
  });
});

// ── Leak 5 · `fields` (dot-path) redaction reached recorders only ──

describe('leak 5 — a `fields` dot-path policy is honoured by the log, the mirror and the fold', () => {
  interface S {
    profile: { auth: { token: string; scheme: string }; name: string };
    creds: { token: string };
  }
  function build() {
    return flowChart<S>(
      'Write',
      (scope: TypedScope<S>) => {
        scope.profile = { auth: { token: SECRET, scheme: 'bearer' }, name: 'n' };
        scope.creds = { token: 'first' };
      },
      'write',
    )
      .addFunction(
        'Merge',
        (scope: TypedScope<S>) => {
          scope.$update('creds', { token: SECRET });
        },
        'merge',
      )
      .build();
  }
  const policy = { fields: { profile: ['auth.token'], creds: ['token'] } };

  it.each(ENCODINGS)('set and merge verbs both scrub the field; siblings survive (%s)', async (commitValues) => {
    const executor = new FlowChartExecutor(build(), { commitValues });
    executor.setRedactionPolicy(policy);
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(bytes(snapshot.commitLog)).not.toContain(SECRET);

    const [write, merge] = snapshot.commitLog;
    const profile = write.overwrite.profile as S['profile'];
    expect(profile.auth.token).toBe('REDACTED');
    expect(profile.auth.scheme).toBe('bearer');
    expect(profile.name).toBe('n');
    expect(write.redactedPaths.some((p) => p.endsWith('token'))).toBe(true);
    expect((merge.updates.creds as { token: string }).token).toBe('REDACTED');

    const mirror = executor.getSnapshot({ redact: true }).sharedState as S;
    expect(mirror.profile).toEqual({ auth: { token: 'REDACTED', scheme: 'bearer' }, name: 'n' });
    expect(mirror.creds).toEqual({ token: 'REDACTED' });

    const folded = stateAt(snapshot, 1).state as S;
    expect(folded.profile).toEqual(mirror.profile);
    expect(folded.creds).toEqual(mirror.creds);

    const writes = snapshot.executionTree.stageWrites as Record<string, S['profile']>;
    expect(writes.profile.auth.token).toBe('[REDACTED]');
    expect(writes.profile.auth.scheme).toBe('bearer');

    const live = snapshot.sharedState as S;
    expect(live.profile.auth.token).toBe(SECRET);
    expect(live.creds.token).toBe(SECRET);
  });

  it('every time-travel stop folds to the mirror’s view of the scrubbed field', async () => {
    const executor = new FlowChartExecutor(build());
    executor.setRedactionPolicy(policy);
    await executor.run();
    const snapshot = executor.getSnapshot();
    const cursor = timeTravel(snapshot);
    const seen: string[] = [];
    while (cursor.next().moved) {
      const state = cursor.stateAt().state as Partial<S>;
      if (state.creds) seen.push(state.creds.token);
    }
    // Write, Merge and the end bookend all show the field scrubbed — the
    // policy is a rule about the PATH, so the first (harmless) value is
    // scrubbed as well; the mirror says the same.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((v) => v === 'REDACTED')).toBe(true);
    expect((executor.getSnapshot({ redact: true }).sharedState as S).creds.token).toBe('REDACTED');
  });
});

// ── The law's other half: live heap and resume checkpoint keep the real values ──

describe('the other half — the live heap and the resume checkpoint are never scrubbed', () => {
  interface S {
    apiKey: string;
    step: number;
    approved: boolean;
    apiKeyEcho: string;
  }
  function build() {
    return flowChart<S>(
      'Seed',
      (scope: TypedScope<S>) => {
        scope.apiKey = SECRET;
        scope.step = 1;
      },
      'seed',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async (scope: TypedScope<S>) => {
            expect(scope.apiKey).toBe(SECRET); // live heap, mid-run
            scope.step = 2;
            return { question: 'ok?' };
          },
          resume: async (scope: TypedScope<S>, input) => {
            scope.approved = (input as { approved: boolean }).approved;
            scope.apiKeyEcho = scope.apiKey; // the resumed run replays the real value
          },
        },
        'approve',
      )
      .build();
  }

  it('checkpoint.sharedState holds the real value; the logs on both sides hold the placeholder', async () => {
    const policy = { patterns: [/apiKey/] };
    const executor = new FlowChartExecutor(build());
    executor.setRedactionPolicy(policy);
    await executor.run();

    const checkpoint = executor.getCheckpoint()!;
    expect((checkpoint.sharedState as S).apiKey).toBe(SECRET);
    expect(bytes(executor.getSnapshot().commitLog)).not.toContain(SECRET);
    expect(bytes(checkpoint.executionTree)).not.toContain(SECRET);

    // Cross-executor resume from the serialized checkpoint: the resumed run
    // computes on the real value and its own log is scrubbed again.
    const fresh = new FlowChartExecutor(build());
    fresh.setRedactionPolicy(policy);
    await fresh.resume(JSON.parse(JSON.stringify(checkpoint)), { approved: true });
    const resumed = fresh.getSnapshot();
    expect((resumed.sharedState as S).apiKeyEcho).toBe(SECRET);
    expect((resumed.sharedState as S).approved).toBe(true);
    expect(bytes(resumed.commitLog)).not.toContain(SECRET);
    const servedAfterResume = fresh.getSnapshot({ redact: true }).sharedState as S;
    expect(servedAfterResume.apiKeyEcho).toBe('REDACTED');
    // `apiKey` itself arrived in the resumed leg by SEED (initialContext =
    // checkpoint.sharedState) and was never re-written there: the served
    // mirror holds the placeholder, the live heap the real value.
    expect(servedAfterResume.apiKey).toBe('REDACTED');
    expect((resumed.sharedState as S).apiKey).toBe(SECRET);
    expect(bytes(servedAfterResume)).not.toContain(SECRET);
  });

  it('a policy key seeded before the run and never re-written is served as the placeholder, live as itself', async () => {
    const chart = flowChart<{ apiKey: string; profile: { auth: { token: string }; name: string }; used: number }>(
      'Read',
      (scope) => {
        scope.used = scope.apiKey.length + scope.profile.auth.token.length; // reads only, never re-writes
      },
      'read',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      initialContext: { apiKey: SECRET, profile: { auth: { token: SECRET }, name: 'n' } },
    });
    executor.setRedactionPolicy({ keys: ['apiKey'], fields: { profile: ['auth.token'] } });
    await executor.run();

    const served = executor.getSnapshot({ redact: true }).sharedState as {
      apiKey: string;
      profile: { auth: { token: string }; name: string };
      used: number;
    };
    expect(served.apiKey).toBe('REDACTED');
    expect(served.profile).toEqual({ auth: { token: 'REDACTED' }, name: 'n' });
    expect(served.used).toBe(SECRET.length * 2);
    expect(bytes(served)).not.toContain(SECRET);

    const live = executor.getSnapshot().sharedState as { apiKey: string; profile: { auth: { token: string } } };
    expect(live.apiKey).toBe(SECRET);
    expect(live.profile.auth.token).toBe(SECRET);
  });

  it('a pause inside a subflow captures the real subflow scope for resume, and the seed on resume is scrubbed', async () => {
    interface Inner {
      apiKey: string;
      done: boolean;
    }
    const inner = flowChart<Inner>(
      'Prep',
      (scope: TypedScope<Inner>) => {
        expect(scope.apiKey).toBe(SECRET);
      },
      'prep',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({ question: 'go?' }),
          resume: async (scope: TypedScope<Inner>) => {
            scope.done = scope.apiKey === SECRET;
          },
        },
        'gate',
      )
      .build();
    const chart = flowChart<{ apiKey: string; done?: boolean }>(
      'Start',
      (scope) => {
        scope.apiKey = SECRET;
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', {
        inputMapper: (p: { apiKey: string }) => ({ apiKey: p.apiKey }),
        outputMapper: (out: Inner) => ({ done: out.done }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['apiKey'] });
    await executor.run();
    const checkpoint = executor.getCheckpoint()!;
    expect(bytes(checkpoint.subflowStates)).toContain(SECRET);

    const fresh = new FlowChartExecutor(chart);
    fresh.setRedactionPolicy({ keys: ['apiKey'] });
    await fresh.resume(JSON.parse(JSON.stringify(checkpoint)), { approved: true });
    const snapshot = fresh.getSnapshot();
    expect((snapshot.sharedState as { done: boolean }).done).toBe(true);
    expect(bytes(snapshot.commitLog)).not.toContain(SECRET);
    for (const entry of Object.values(
      snapshot.subflowResults as Record<string, { treeContext: { history: unknown[] } }>,
    )) {
      expect(bytes(entry.treeContext.history)).not.toContain(SECRET);
    }
  });
});

// ── The report lists what the bypass paths redacted too ──

describe('the redaction report sees the routed paths', () => {
  it('a seeded policy key shows up in getRedactionReport().redactedKeys', async () => {
    const inner = flowChart<{ apiKey: string }>('Inside', () => {}, 'inside').build();
    const chart = flowChart<{ apiKey: string }>(
      'Start',
      (scope) => {
        scope.apiKey = SECRET;
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', { inputMapper: (p: { apiKey: string }) => ({ apiKey: p.apiKey }) })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['apiKey'] });
    await executor.run();
    expect(executor.getRedactionReport().redactedKeys).toEqual(['apiKey']);
  });
});
