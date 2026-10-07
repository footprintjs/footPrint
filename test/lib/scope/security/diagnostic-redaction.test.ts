import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { StageContext } from '../../../../src/advanced.js';
import { ScopeFacade } from '../../../../src/advanced.js';
import type { EmitEvent, FlowChartExecutorOptions, RedactionPolicy } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

const MASK = '[REDACTED]';
type Kind = 'typed' | 'facade' | 'zod';
type DiagnosticPolicy = Pick<RedactionPolicy, 'keys' | 'patterns' | 'fields'>;

function policy(diagnostics: DiagnosticPolicy): RedactionPolicy {
  return { diagnostics };
}

function options(kind: Kind): FlowChartExecutorOptions {
  if (kind === 'zod') return { scopeFactory: defineScopeFromZod(z.object({}), { strict: 'deny' }) };
  if (kind === 'facade') {
    return {
      scopeFactory: (ctx, name, readOnly, env) => new ScopeFacade(ctx, name, readOnly, env),
    };
  }
  return {};
}

function helpers(scope: any, kind: Kind) {
  return kind === 'typed'
    ? { debug: scope.$debug, error: scope.$error, metric: scope.$metric, eval: scope.$eval, log: scope.$log }
    : {
        debug: scope.addDebugInfo.bind(scope),
        error: scope.addErrorInfo.bind(scope),
        metric: scope.addMetric.bind(scope),
        eval: scope.addEval.bind(scope),
        log: scope.addDebugMessage.bind(scope),
      };
}

function observe(executor: FlowChartExecutor, delivery: 'inline' | 'deferred' = 'inline') {
  const events: EmitEvent[] = [];
  executor.attachEmitRecorder({ id: 'diagnostic-events', onEmit: (event) => events.push(event) }, { delivery });
  executor.enableNarrative({ renderer: { renderEmit: (event) => `${event.name}=${JSON.stringify(event.payload)}` } });
  return events;
}

describe.each(['typed', 'facade', 'zod'] as const)('diagnostic retention through %s scope', (kind) => {
  it.each(['inline', 'deferred'] as const)(
    'retains all five helpers before %s observation without changing live values',
    async (delivery) => {
      const raw = { token: 'private-diagnostic', public: 7 };
      const chart = flowChart<any>(
        'Record',
        (scope) => {
          const h = helpers(scope, kind);
          for (let i = 0; i < 2; i++) {
            h.debug('secret', raw);
            h.error('secret', raw);
            h.metric('secret', raw);
            h.eval('secret', raw);
            h.log(raw);
          }
          return raw;
        },
        'record',
      ).build();
      const executor = new FlowChartExecutor(chart, options(kind));
      executor.setRedactionPolicy(
        policy({ keys: ['logs.secret', 'errors.secret', 'metrics.secret', 'evals.secret', 'logs.messages'] }),
      );
      const events = observe(executor, delivery);

      expect(await executor.run()).toBe(raw);
      expect(raw.token).toBe('private-diagnostic');
      const tree = executor.getSnapshot().executionTree;
      for (const bag of ['logs', 'errors', 'metrics', 'evals'] as const) expect.soft(tree[bag].secret).toBe(MASK);
      expect.soft(tree.logs.messages).toBe(MASK);
      const expected = [
        { key: 'secret', value: MASK, level: 'debug' },
        { key: 'secret', value: MASK, level: 'error' },
        { name: 'secret', value: MASK },
        { name: 'secret', value: MASK },
        { value: MASK, level: 'debug' },
      ];
      expect.soft(events.map((event) => event.payload)).toEqual([...expected, ...expected]);
      expect(events).toHaveLength(10);
      expect(events.every((event) => event.runtimeStageId === 'record#0')).toBe(true);
      expect.soft(JSON.stringify(executor.getNarrativeEntries())).not.toContain('private-diagnostic');
      expect.soft(executor.getSnapshot({ redact: true }).executionTree.logs.secret).toBe(MASK);
    },
  );

  it('scrubs nested fields before repeated merge and shares the retained incoming object with emit', async () => {
    const first = { token: 'first-private', keep: { public: 1 } };
    const second = { token: 'second-private', added: true };
    const executor = new FlowChartExecutor(
      flowChart<any>(
        'Profile',
        (scope) => {
          const h = helpers(scope, kind);
          h.debug('profile', first);
          h.debug('profile', second);
        },
        'profile',
      ).build(),
      options(kind),
    );
    executor.setRedactionPolicy(policy({ fields: { logs: ['profile.token'] } }));
    const events = observe(executor);
    const profilesAtEmit: unknown[] = [];
    executor.attachEmitRecorder({
      id: 'retained-identity',
      onEmit: () => {
        profilesAtEmit.push(executor.getSnapshot().executionTree.logs.profile);
      },
    });
    await executor.run();

    expect
      .soft(executor.getSnapshot().executionTree.logs.profile)
      .toEqual({ token: MASK, keep: { public: 1 }, added: true });
    expect.soft(events.map((event) => event.payload)).toEqual([
      { key: 'profile', value: { token: MASK, keep: { public: 1 } }, level: 'debug' },
      { key: 'profile', value: { token: MASK, added: true }, level: 'debug' },
    ]);
    expect((events[0].payload as { value: unknown }).value).toBe(profilesAtEmit[0]);
    expect(first.token).toBe('first-private');
    expect(second.token).toBe('second-private');
  });
});

describe('diagnostic namespace and admission', () => {
  it.each(['g', 'y'])('uses state-independent /%s predicates on every diagnostic call', async (flags) => {
    const pattern = new RegExp('^logs.secret$', flags);
    pattern.lastIndex = 29;
    const executor = new FlowChartExecutor(
      flowChart<any>(
        'Repeat',
        (scope) => {
          scope.secret = 'real-state';
          scope.$setValue('marked', 'real-marked-state', true);
          scope.$debug('marked', 'unmatched-diagnostic');
          scope.$debug('secret', 'private-1');
          scope.$debug('secret', 'private-2');
          scope.$debug('public', 'public-value');
          scope.$debug('secret', 'private-3');
        },
        'repeat',
      ).build(),
    );
    executor.setRedactionPolicy(policy({ patterns: [pattern] }));
    const events = observe(executor);
    await executor.run();
    // The restored law: a per-call mark selects its key by NAME everywhere it is served,
    // so the diagnostic named `marked` is masked too (the pattern never matched it).
    expect
      .soft(events.map((event) => (event.payload as { value: unknown }).value))
      .toEqual([MASK, MASK, MASK, 'public-value', MASK]);
    expect.soft(executor.getSnapshot().executionTree.logs.secret).toBe(MASK);
    expect(executor.getSnapshot().sharedState).toMatchObject({ secret: 'real-state', marked: 'real-marked-state' });
    expect(executor.getSnapshot().executionTree.logs.marked).toBe(MASK);
  });

  it('keeps emitPatterns an additional whole-payload policy and ordinary emits independent', async () => {
    const executor = new FlowChartExecutor(
      flowChart<object>(
        'Both',
        (scope) => {
          scope.$debug('secret', 'bag-private');
          scope.$debug('public', 'emit-private');
          scope.$emit('ordinary', { secret: 'ordinary-value' });
        },
        'both',
      ).build(),
    );
    executor.setRedactionPolicy({ ...policy({ keys: ['logs.secret'] }), emitPatterns: [/^log.debug.public$/] });
    const events = observe(executor);
    await executor.run();
    expect
      .soft(events.map((event) => event.payload))
      .toEqual([{ key: 'secret', value: MASK, level: 'debug' }, MASK, { secret: 'ordinary-value' }]);
    expect.soft(executor.getSnapshot().executionTree.logs).toEqual({ secret: MASK, public: 'emit-private' });
  });

  it.each(['context', 'collector'] as const)(
    'covers direct %s add/set APIs and literal nested path segments',
    async (door) => {
      let context: StageContext;
      const chart = flowChart<void, ScopeFacade>(
        'Direct',
        () => {
          const target = door === 'context' ? context : context.debug;
          target.addLog('secret', ['private-1'], ['nested']);
          target.addLog('secret', ['private-2'], ['nested']);
          target.setLog('replace', { secret: 'private-3' });
          target.addError('secret', 'private-error');
          target.addMetric('secret', [1]);
          target.setMetric('secret', [2]);
          target.addEval('secret', { token: 'private-eval' });
          target.setEval('secret', 'private-final');
          target.addLog('profile', { token: 'private-nested', keep: 1 }, ['nested']);
          target.addLog('safe', 'literal-value', ['a.b', '']);
        },
        'direct',
      ).build();
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: (ctx, name, readOnly, env) => {
          context = ctx;
          return new ScopeFacade(ctx, name, readOnly, env);
        },
      });
      executor.setRedactionPolicy(
        policy({
          keys: ['logs.nested.secret', 'logs.replace', 'errors.secret', 'metrics.secret', 'evals.secret'],
          fields: { logs: ['nested.profile.token'] },
        }),
      );
      const events = observe(executor);
      await executor.run();
      const tree = executor.getSnapshot().executionTree;
      const expectedLogs = {
        nested: { secret: MASK, profile: { token: MASK, keep: 1 } },
        replace: MASK,
        'a.b': { '': { safe: 'literal-value' } },
      };
      expect.soft(tree.logs).toEqual(expectedLogs);
      for (const bag of ['errors', 'metrics', 'evals'] as const) expect.soft(tree[bag]).toEqual({ secret: MASK });
      expect(events).toEqual([]);
    },
  );

  it('retains internally supplied read/write descriptions at their collector boundary', async () => {
    let context: StageContext;
    const chart = flowChart<void, ScopeFacade>(
      'Descriptions',
      () => {
        context.setObject([], 'value', 1, false, 'private-write');
        context.updateObject([], 'value', 2, 'private-update');
        context.setGlobal('global', 3, 'private-global');
        context.getValue([], 'value', 'private-read');
      },
      'descriptions',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: (ctx, name, readOnly, env) => {
        context = ctx;
        return new ScopeFacade(ctx, name, readOnly, env);
      },
    });
    executor.setRedactionPolicy(policy({ keys: ['logs.message'] }));
    await executor.run();
    expect.soft(executor.getSnapshot().executionTree.logs.message).toBe(MASK);
    expect(executor.getSnapshot().sharedState).toMatchObject({ value: 2, global: 3 });
  });

  it('masks flow text but preserves control metadata and caller objects', async () => {
    let context: StageContext;
    const message = {
      type: 'branch' as const,
      description: 'private-description',
      rationale: 'private-rationale',
      targetStage: ['left', 'right'],
      count: 2,
      iteration: 3,
      timestamp: 123,
    };
    const executor = new FlowChartExecutor(
      flowChart<void, ScopeFacade>(
        'Flow',
        () => {
          context.debug.addFlowMessage(message);
          context.addFlowDebugMessage('loop', 'private-loop', {
            rationale: 'private-loop-reason',
            targetStage: 'again',
            iteration: 4,
          });
        },
        'flow',
      ).build(),
      {
        scopeFactory: (ctx, name, readOnly, env) => {
          context = ctx;
          return new ScopeFacade(ctx, name, readOnly, env);
        },
      },
    );
    executor.setRedactionPolicy(
      policy({
        keys: ['flowMessages.description', 'flowMessages.rationale', 'flowMessages.targetStage', 'flowMessages.type'],
      }),
    );
    await executor.run();
    const messages = executor.getSnapshot().executionTree.flowMessages ?? [];
    expect(messages).toHaveLength(2);
    expect.soft(messages[0]).toEqual({ ...message, description: MASK, rationale: MASK });
    const expectedLoop = {
      type: 'loop',
      description: MASK,
      rationale: MASK,
      targetStage: 'again',
      iteration: 4,
      timestamp: expect.any(Number),
    };
    expect.soft(messages[1]).toEqual(expectedLoop);
    expect(message.description).toBe('private-description');
    expect(message.rationale).toBe('private-rationale');
  });

  it('feeds retained decider rationale into flow messages and onDecision without changing routing', async () => {
    const decisions: unknown[] = [];
    let routed = false;
    const chart = flowChart('Begin', () => {}, 'begin')
      .addDeciderFunction(
        'Choose',
        (scope) => {
          scope.$debug('deciderRationale', 'private-rationale');
          return 'yes';
        },
        'choose',
      )
      .addFunctionBranch('yes', 'Yes', () => {
        routed = true;
      })
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy(policy({ keys: ['logs.deciderRationale'] }));
    executor.attachFlowRecorder({ id: 'decisions', onDecision: (event) => decisions.push(event.rationale) });
    await executor.run();
    expect(routed).toBe(true);
    expect.soft(decisions).toEqual([MASK]);
    expect.soft(JSON.stringify(executor.getSnapshot().executionTree)).not.toContain('private-rationale');
  });
});

describe('diagnostic lifecycle', () => {
  it.each(['same', 'fresh'] as const)(
    'retains nested diagnostics before and after %s-executor resume',
    async (mode) => {
      const inner = flowChart<object>('Before', (scope) => scope.$debug('secret', 'private-before'), 'before')
        .addPausableFunction(
          'Pause',
          { execute: () => ({ question: 'continue' }), resume: (scope) => scope.$debug('secret', 'private-resume') },
          'pause',
        )
        .addFunction('After', (scope) => scope.$debug('secret', 'private-after'), 'after')
        .build();
      const chart = flowChart('Root', (scope) => scope.$debug('secret', 'private-root'), 'root')
        .addSubFlowChartNext('mount', inner, 'Nested')
        .build();
      const make = () => {
        const executor = new FlowChartExecutor(chart);
        executor.setRedactionPolicy(policy({ keys: ['logs.secret'] }));
        const events = observe(executor, 'deferred');
        return { executor, events };
      };
      const first = make();
      await first.executor.run();
      const checkpoint = JSON.parse(JSON.stringify(first.executor.getCheckpoint()));
      expect.soft(checkpoint.executionTree.logs.secret).toBe(MASK);
      const savedCheckpoint = JSON.stringify(checkpoint);
      const resumed = mode === 'same' ? first : make();
      await resumed.executor.resume(checkpoint, { approved: true });
      const events = mode === 'same' ? resumed.events : [...first.events, ...resumed.events];
      expect.soft(events.map((event) => (event.payload as { value: unknown }).value)).toEqual([MASK, MASK, MASK, MASK]);
      expect(events.map((event) => event.subflowPath.join('/'))).toEqual(['', 'mount', 'mount', 'mount']);
      expect.soft(JSON.stringify(resumed.executor.getSnapshot().subflowResults)).not.toContain('private-');
      expect(JSON.stringify(checkpoint)).toBe(savedCheckpoint);
    },
  );

  it('keeps dynamic-child capture and error evidence when all diagnostic logs are masked', async () => {
    const chart = flowChart<any, any>(
      'Dynamic',
      () => ({
        name: 'Dynamic fork',
        children: [
          {
            id: 'child',
            name: 'Child',
            fn: (scope: any) => {
              scope.$debug('secret', 'private-child');
              scope.$error('secret', 'private-error');
            },
          },
        ],
      }),
      'dynamic',
    )
      .addFunction('After', () => 'finished', 'after')
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy(policy({ keys: ['logs', 'errors'] }));
    expect(await executor.run()).toBe('finished');
    const snapshot = executor.getSnapshot();
    expect.soft(snapshot.executionTree.logs.isDynamic).toBe(MASK);
    expect(snapshot.subflowResults?.dynamic).toBeDefined();
    const captured = (snapshot.subflowResults?.dynamic as { treeContext: { stageContexts: Record<string, any> } })
      .treeContext.stageContexts.Child;
    expect.soft(captured.output.secret).toBe(MASK);
    expect.soft(captured.errors.secret).toBe(MASK);
    expect(captured.status).toBe('error');
  });

  it('retains failed-attempt diagnostic entries and protects their emitted payloads', async () => {
    let attempt = 0;
    const executor = new FlowChartExecutor(
      flowChart<object>(
        'Retry',
        (scope) => {
          scope.$log(`private-attempt-${++attempt}`);
          scope.$error('attempt', `private-error-${attempt}`);
          if (attempt === 1) throw new Error('retry');
        },
        'retry',
      )
        .retry({ attempts: 2 })
        .build(),
    );
    executor.setRedactionPolicy(policy({ keys: ['logs.messages', 'errors.attempt'] }));
    const events = observe(executor);
    await executor.run();
    expect(attempt).toBe(2);
    expect.soft(events.map((event) => (event.payload as { value: unknown }).value)).toEqual([MASK, MASK, MASK, MASK]);
    expect.soft(executor.getSnapshot().executionTree.logs.messages).toBe(MASK);
    expect.soft(executor.getSnapshot().executionTree.errors.attempt).toBe(MASK);
  });
});

describe('default diagnostic bytes remain unchanged', () => {
  const controls: Array<[string, RedactionPolicy | undefined]> = [
    ['absent', undefined],
    ['empty diagnostic policy', policy({})],
    ['nonmatching diagnostic policy', policy({ keys: ['logs.unrelated'] })],
    ['nonmatching state policy', { keys: ['unrelated'], fields: { other: ['secret'] } }],
    ['emit-only policy', { emitPatterns: [/^log\./] }],
  ];
  it.each(controls)('%s preserves bag aliasing and merge/clear laws', async (_label, protection) => {
    const raw = { secret: 'unmasked-raw', nested: { keep: true } };
    const executor = new FlowChartExecutor(
      flowChart<object>(
        'Control',
        (scope) => {
          scope.$debug('secret', raw);
          scope.$debug('array', [1, 1]);
          scope.$debug('array', [1, 2]);
          scope.$debug('clear', [1]);
          scope.$debug('clear', []);
          scope.$log('first');
          scope.$log('second');
        },
        'control',
      ).build(),
    );
    if (protection) executor.setRedactionPolicy(protection);
    const events = observe(executor);
    await executor.run();
    const logs = executor.getSnapshot().executionTree.logs;
    expect(logs).toEqual({ secret: raw, array: [1, 1, 1, 2], clear: [], messages: ['first', 'second'] });
    expect(logs.secret).toBe(raw);
    expect((events[0].payload as { value?: unknown }).value ?? events[0].payload).toBe(
      protection?.emitPatterns ? MASK : raw,
    );
    raw.secret = 'later-mutation';
    expect((logs.secret as typeof raw).secret).toBe('later-mutation');
  });
});
