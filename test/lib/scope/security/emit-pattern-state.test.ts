import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { EmitEvent, RedactionPolicy } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

function observe(executor: FlowChartExecutor) {
  const inlineA: EmitEvent[] = [];
  const inlineB: EmitEvent[] = [];
  const deferred: EmitEvent[] = [];
  executor.attachEmitRecorder({ id: 'inline-a', onEmit: (event) => inlineA.push(event) });
  executor.attachEmitRecorder({ id: 'inline-b', onEmit: (event) => inlineB.push(event) });
  executor.attachEmitRecorder({ id: 'deferred', onEmit: (event) => deferred.push(event) }, { delivery: 'deferred' });
  executor.enableNarrative({ renderer: { renderEmit: (event) => `${event.name}=${JSON.stringify(event.payload)}` } });
  return { inlineA, inlineB, deferred };
}

describe.each(['typed', 'zod'] as const)('stateful emit policy: %s scope', (kind) => {
  describe.each(['g', 'y'])('/^private-event$/%s', (flags) => {
    it.each([0, 41])('masks repeated names and resets after misses with supplied lastIndex=%i', async (lastIndex) => {
      const pattern = new RegExp('^private-event$', flags);
      pattern.lastIndex = lastIndex;
      const names = ['private-event', 'private-event', 'public-event', 'private-event', 'private-event'];
      const payloads = names.map((name, index) => ({ secret: `${name}-secret-${index}`, index }));
      const chart = flowChart<any>(
        'Emit',
        (scope) => {
          names.forEach((name, index) => {
            if (kind === 'zod') scope.emitEvent(name, payloads[index]);
            else scope.$emit(name, payloads[index]);
          });
          return payloads;
        },
        'emit',
      ).build();
      const executor = new FlowChartExecutor(
        chart,
        kind === 'zod' ? { scopeFactory: defineScopeFromZod(z.object({}), { strict: 'deny' }) } : {},
      );
      executor.setRedactionPolicy({ emitPatterns: [pattern] });
      const { inlineA, inlineB, deferred } = observe(executor);

      expect(await executor.run()).toBe(payloads);
      expect(payloads[0].secret).toBe('private-event-secret-0');
      const retained = ['[REDACTED]', '[REDACTED]', payloads[2], '[REDACTED]', '[REDACTED]'];
      expect.soft(inlineA.map((event) => event.payload)).toEqual(retained);
      expect.soft(inlineB.map((event) => event.payload)).toEqual(retained);
      expect.soft(deferred.map((event) => event.payload)).toEqual(retained);
      expect(inlineA).toHaveLength(names.length);
      expect(inlineA).toEqual(deferred);
      inlineA.forEach((event, index) => expect(event).toBe(inlineB[index]));
      expect(inlineA[2].payload).toBe(payloads[2]);
      expect(inlineA.map((event) => event.name)).toEqual(names);
      expect(inlineA.every((event) => event.runtimeStageId === 'emit#0')).toBe(true);
      expect
        .soft(
          executor
            .getNarrativeEntries()
            .filter((entry) => entry.type === 'emit')
            .map((entry) => entry.text),
        )
        .toEqual(names.map((name, index) => `${name}=${JSON.stringify(retained[index])}`));
    });
  });
});

describe('multiple emit patterns', () => {
  it('does not inherit the cursor of a later pattern skipped by an earlier match', async () => {
    const first = /^alpha$/g;
    const second = /^beta$/y;
    second.lastIndex = 19;
    const names = ['alpha', 'beta', 'beta', 'public', 'alpha', 'beta'];
    const chart = flowChart<object>(
      'Emit',
      (scope) => {
        names.forEach((name, index) => scope.$emit(name, { index }));
      },
      'emit',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ emitPatterns: [first, second] });
    const { inlineA, deferred } = observe(executor);

    await executor.run();
    const retained = ['[REDACTED]', '[REDACTED]', '[REDACTED]', { index: 3 }, '[REDACTED]', '[REDACTED]'];
    expect.soft(inlineA.map((event) => event.payload)).toEqual(retained);
    expect.soft(deferred.map((event) => event.payload)).toEqual(retained);
  });
});

describe.each(['g', 'y'])('shared /%s emit policy across scopes', (flags) => {
  it('masks every event in nested parallel stages without changing stage attribution or order', async () => {
    let releaseLeft: () => void = () => {};
    let releaseRight: () => void = () => {};
    const leftStarted = new Promise<void>((resolve) => {
      releaseLeft = resolve;
    });
    const rightFinished = new Promise<void>((resolve) => {
      releaseRight = resolve;
    });
    const inner = flowChart<object>('Inner', (scope) => scope.$emit('private-event', 'inner-secret'), 'inner')
      .addListOfFunction([
        {
          id: 'left',
          name: 'Left',
          fn: async (scope) => {
            scope.$emit('private-event', 'left-first-secret');
            releaseLeft();
            await rightFinished;
            scope.$emit('private-event', 'left-last-secret');
          },
        },
        {
          id: 'right',
          name: 'Right',
          fn: async (scope) => {
            await leftStarted;
            scope.$emit('private-event', 'right-first-secret');
            scope.$emit('private-event', 'right-last-secret');
            releaseRight();
          },
        },
      ])
      .build();
    const chart = flowChart<object>('Root', (scope) => scope.$emit('private-event', 'root-secret'), 'root')
      .addSubFlowChartNext('mount', inner, 'Nested')
      .addFunction(
        'After',
        (scope) => {
          scope.$emit('private-event', 'after-first-secret');
          scope.$emit('private-event', 'after-last-secret');
        },
        'after',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ emitPatterns: [new RegExp('^private-event$', flags)] });
    const { inlineA, inlineB, deferred } = observe(executor);

    await executor.run();
    expect(inlineA).toHaveLength(8);
    expect(inlineA.map((event) => event.stageName)).toEqual([
      'Root',
      'mount/Inner',
      'mount/Left',
      'mount/Right',
      'mount/Right',
      'mount/Left',
      'After',
      'After',
    ]);
    expect(inlineA.map((event) => event.subflowPath)).toEqual([
      [],
      ['mount'],
      ['mount'],
      ['mount'],
      ['mount'],
      ['mount'],
      [],
      [],
    ]);
    expect(inlineA).toEqual(inlineB);
    expect(inlineA).toEqual(deferred);
    expect.soft(inlineA.map((event) => event.payload)).toEqual(Array(8).fill('[REDACTED]'));
    expect
      .soft(JSON.stringify(executor.getNarrativeEntries().filter((entry) => entry.type === 'emit')))
      .not.toContain('-secret');
  });

  it.each(['same', 'fresh'] as const)('masks emissions before and after %s-executor resume', async (mode) => {
    const pattern = new RegExp('^private-event$', flags);
    const chart = flowChart<object>(
      'Before',
      (scope) => {
        scope.$emit('private-event', 'before-first-secret');
        scope.$emit('private-event', 'before-last-secret');
      },
      'before',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: () => ({ question: 'approve?' }),
          resume: (scope) => {
            scope.$emit('private-event', 'resume-first-secret');
            scope.$emit('private-event', 'resume-last-secret');
          },
        },
        'approve',
      )
      .addFunction(
        'After',
        (scope) => {
          scope.$emit('private-event', 'after-first-secret');
          scope.$emit('private-event', 'after-last-secret');
        },
        'after',
      )
      .build();
    const first = new FlowChartExecutor(chart);
    first.setRedactionPolicy({ emitPatterns: [pattern] });
    const before = observe(first);
    await first.run();
    const checkpoint = first.getCheckpoint();
    if (!checkpoint) throw new Error('Expected the approval stage to pause');
    expect(before.inlineA).toHaveLength(2);
    expect.soft(before.inlineA.map((event) => event.payload)).toEqual(['[REDACTED]', '[REDACTED]']);
    expect(before.inlineA).toEqual(before.deferred);

    const resumed = mode === 'same' ? first : new FlowChartExecutor(chart);
    resumed.setRedactionPolicy({ emitPatterns: [pattern] });
    const after = mode === 'same' ? before : observe(resumed);
    pattern.lastIndex = 41; // caller use between legs must not alter policy meaning
    await resumed.resume(JSON.parse(JSON.stringify(checkpoint)), { approved: true });
    expect(after.inlineA).toHaveLength(mode === 'same' ? 6 : 4);
    expect.soft(after.inlineA.slice(-4).map((event) => event.payload)).toEqual(Array(4).fill('[REDACTED]'));
    expect(after.inlineA).toEqual(after.deferred);
    expect
      .soft(JSON.stringify(resumed.getNarrativeEntries().filter((entry) => entry.type === 'emit')))
      .not.toContain('-secret');
  });
});

describe('emit redaction controls', () => {
  const controls: Array<{ name: string; policy?: RedactionPolicy; masked: boolean }> = [
    { name: 'no policy', masked: false },
    { name: 'empty emit patterns', policy: { emitPatterns: [] }, masked: false },
    { name: 'state-only policy', policy: { keys: ['secret'] }, masked: false },
    { name: 'nonmatching global pattern', policy: { emitPatterns: [/^different$/g] }, masked: false },
    { name: 'plain matching pattern', policy: { emitPatterns: [/^private-event$/] }, masked: true },
    { name: 'case-insensitive pattern', policy: { emitPatterns: [/^PRIVATE-EVENT$/i] }, masked: true },
    { name: 'frozen nonstateful pattern', policy: { emitPatterns: [Object.freeze(/^private-event$/i)] }, masked: true },
  ];
  it.each(controls)('$name preserves its payload contract', async ({ policy, masked }) => {
    const payload = { secret: 'live-payload', visible: 7 };
    const chart = flowChart<object>(
      'Emit',
      (scope) => {
        scope.$emit('private-event', payload);
        scope.$emit('private-event', payload);
      },
      'emit',
    ).build();
    const executor = new FlowChartExecutor(chart);
    if (policy) executor.setRedactionPolicy(policy);
    const { inlineA, inlineB, deferred } = observe(executor);

    await executor.run();
    expect(inlineA.map((event) => event.payload)).toEqual(Array(2).fill(masked ? '[REDACTED]' : payload));
    expect(inlineA).toEqual(inlineB);
    expect(inlineA).toEqual(deferred);
    if (!masked) expect(inlineA[0].payload).toBe(payload);
    expect(payload).toEqual({ secret: 'live-payload', visible: 7 });
  });
});
