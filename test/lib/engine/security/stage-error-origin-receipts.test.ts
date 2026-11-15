import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/index.js';
import { SubflowExecutor } from '../../../../src/lib/engine/handlers/SubflowExecutor.js';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';
import { runPolicy } from '../../../../src/lib/memory/runPolicy.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime.js';
import { stageErrorSurfaces } from '../../../helpers/stageErrorSurfaces.js';

const SECRET = 'SYNTHETIC-RECEIPT-SECRET';
afterEach(() => vi.restoreAllMocks());
const parentLogs = (text: string, start: string) =>
  JSON.parse(text).filter((parts: any[]) => String(parts[0]).startsWith(start));

describe('a new commit cannot inherit invocation retention', () => {
  it.each(
    [false, true].flatMap((captureClosure) =>
      ['object', 'scalar'].flatMap((kind) => [false, true].map((policy) => ({ captureClosure, kind, policy }))),
    ),
  )('$captureClosure/$kind/policy=$policy', async ({ captureClosure, kind, policy }) => {
    const error =
      kind === 'object'
        ? Object.assign(new Error('public repeat failure'), { code: 'PUBLIC_CODE', cause: { safe: 1 } })
        : 'public repeat failure';
    const original = StageContext.prototype.commit;
    // Nested closure capture is not attested by the public root option. Exercise
    // the existing private child producer flag explicitly, as native selection tests do.
    if (captureClosure) {
      const bind = StageContext.prototype.bindFailureIdentity;
      vi.spyOn(StageContext.prototype, 'bindFailureIdentity').mockImplementation(function (
        this: StageContext,
        ...args
      ) {
        bind.apply(this, args);
        this.captureClosureTracking = true;
      });
    }
    const commits: StageContext[] = [];
    let repeat = 0;
    let bodies = 0;
    vi.spyOn(StageContext.prototype, 'commit').mockImplementation(function (this: StageContext, phase) {
      if (phase === 'repeat' && this.stageId.endsWith('failing-child')) {
        repeat++;
        commits.push(this);
        throw error;
      }
      return original.call(this, phase);
    });
    const inner = flowChart('Fork', () => undefined, 'fork')
      .addListOfFunction(
        [
          {
            name: 'Failing child',
            id: 'failing-child',
            fn: () => {
              bodies++;
              throw error;
            },
          },
        ],
        { failFast: true },
      )
      .build();
    const outer = flowChart('Start', () => undefined, 'start')
      .addSubFlowChartNext('inner', inner, 'Inner')
      .build();
    const result = await stageErrorSurfaces(
      outer,
      policy ? { keys: ['unrelated'] } : undefined,
      undefined,
      undefined,
      captureClosure ? { captureClosure: true, captureExtent: true } : {},
    );
    expect(result.rejected).toBe(error);
    expect(bodies).toBe(1);
    expect(repeat).toBe(1);
    const invocation = result.events.find((row) => row.kind === 'error');
    expect(invocation.event.structuredError.message).toBe('public repeat failure');
    expect(result.events.findIndex((row) => row.kind === 'error')).toBeLessThan(
      result.events.findIndex((row) => row.kind === 'failed'),
    );
    const terminal = result.events.find((row) => row.kind === 'failed').event;
    expect(terminal.structuredError?.message ?? terminal.error?.message).toBe(
      policy ? '[REDACTED]' : 'public repeat failure',
    );
    const logs = parentLogs(result.retained.logger, 'Error in subflow');
    expect(logs).toHaveLength(1);
    expect(logs[0][1].error.message ?? logs[0][1].error).toBe(policy ? '[REDACTED]' : 'public repeat failure');
    expect(result.retained.disk).toContain('"closed"');
    if (captureClosure) expect(result.executor.getClosedCapture().status).toBe('unknown');
    else expect(result.retained.disk).toContain('capture-history');
    expect(commits[0].captureClosureTracking === true).toBe(captureClosure);
    expect((result.executor as any).failureState.selected?.kind).toBe(captureClosure ? 'commit' : undefined);
    if (error instanceof Error) {
      expect(error.message).toBe('public repeat failure');
      expect(error.name).toBe('Error');
      expect((error as any).code).toBe('PUBLIC_CODE');
      expect(error.cause).toEqual({ safe: 1 });
    }
  });
});

describe('receipt absence and reused payloads are distinct origins', () => {
  it.each(['object', 'scalar'])('an unreported factory failure has no clear receipt: %s', async (kind) => {
    const error = kind === 'object' ? new Error('public child failure') : 'public child failure';
    const logger = { info: vi.fn(), log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new ExecutionRuntime(
      'Root',
      'root',
      undefined,
      undefined,
      runPolicy({}, new RedactionRule({ keys: ['unrelated'] })),
    );
    const parent = runtime.rootStageContext;
    const deps: any = {
      executionRuntime: runtime,
      stageMap: new Map(),
      root: { id: 'root', name: 'Root' },
      narrativeGenerator: new NullControlFlowNarrativeGenerator(),
      logger,
      scopeFactory: () => ({}),
    };
    const factory = vi.fn(() => {
      throw error;
    });
    const executor = new SubflowExecutor(deps, factory);
    await expect(
      executor.executeSubflow(
        { id: 'mount', name: 'Mount', subflowId: 'inner' },
        parent,
        { shouldBreak: false },
        undefined,
        new Map(),
      ),
    ).rejects.toBe(error);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(parent.getSnapshot().errors.subflowError).toBe('[REDACTED]');
    expect(logger.error.mock.calls[0][1].error).toEqual({ message: '[REDACTED]', raw: undefined });
  });

  it.each(['object', 'scalar'].flatMap((kind) => [false, true].map((policy) => ({ kind, policy }))))(
    'selected A then clear B may throw the same $kind, policy=$policy',
    async ({ kind, policy }) => {
      const error =
        kind === 'object'
          ? Object.assign(new Error('public shared failure'), { code: 'PUBLIC_CODE' })
          : 'public shared failure';
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const diagnostic = StageContext.prototype.addDiagnostic;
      vi.spyOn(StageContext.prototype, 'addDiagnostic').mockImplementation(function (this: StageContext, ...args) {
        const value = diagnostic.apply(this, args);
        if (this.stageId.endsWith('selected') && args[0] === 'errors') release();
        return value;
      });
      const a = flowChart<any>(
        'Seed',
        (s) => {
          s.secret = SECRET;
        },
        'seed',
      )
        .addFunction(
          'Selected',
          (s) => {
            expect(s.secret).toBe(SECRET);
            throw error;
          },
          'selected',
        )
        .build();
      const b = flowChart(
        'Clear',
        async () => {
          await done;
          throw error;
        },
        'clear',
      ).build();
      const chart = flowChart('Fork', () => undefined, 'fork')
        .addSubFlowChart('a', a, 'A')
        .addSubFlowChart('b', b, 'B')
        .build();
      const result = await stageErrorSurfaces(chart, policy ? { keys: ['secret'] } : undefined);
      expect(result.rejected).toBeUndefined();
      expect(result.output.a.result).toBe(error);
      expect(result.output.b.result).toBe(error);
      expect(Object.keys(result.output.a)).toEqual(['id', 'result', 'isError']);
      for (const { end, inline } of [
        ...result.events.map((end) => ({ end, inline: true })),
        ...result.deferred.map((end) => ({ end, inline: false })),
      ].filter(({ end }) => end.kind === 'end')) {
        if (policy)
          expect(end.event.payload.a.result).toEqual(
            kind === 'object' ? { message: '[REDACTED]', raw: undefined } : '[REDACTED]',
          );
        else expect(end.event.payload.a.result.message ?? end.event.payload.a.result).toBe('public shared failure');
        const clear = end.event.payload.b.result;
        expect(clear.message ?? clear).toBe('public shared failure');
        if (kind === 'object') {
          expect(clear.name).toBe('Error');
          // Deferred delivery's existing Error clone drops expando fields, with or without policy.
          expect(clear.code).toBe(inline ? 'PUBLIC_CODE' : undefined);
        }
      }
      expect(result.events.some((row) => row.kind === 'end')).toBe(true);
      expect(result.deferred.some((row) => row.kind === 'end')).toBe(true);
      const logs = parentLogs(result.retained.logger, 'Error in subflow');
      expect(logs).toHaveLength(2);
      const selectedA = logs.find((row: any) => row[0].includes('(a)'))[1].error;
      expect(selectedA.message ?? selectedA).toBe(policy ? '[REDACTED]' : 'public shared failure');
      const publicB = logs.find((row: any) => row[0].includes('(b)'))[1].error;
      expect(publicB.message ?? publicB).toBe('public shared failure');
      expect(result.retained.tree).toContain('public shared failure');
      if (policy) for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
      if (error instanceof Error) {
        expect(error.message).toBe('public shared failure');
        expect((error as any).code).toBe('PUBLIC_CODE');
      }
    },
  );
});

describe('mapper failures keep their own origin and continuation law', () => {
  it.each(
    ['input', 'output'].flatMap((mapping) =>
      ['selected-state', 'selected-input', 'public'].flatMap((source) =>
        [false, true].map((policy) => ({ mapping, source, policy })),
      ),
    ),
  )('$mapping/$source/policy=$policy', async ({ mapping, source, policy }) => {
    const message = source === 'public' ? 'public mapper failure' : SECRET;
    const error = Object.assign(new Error(message), { code: 'MAPPER_CODE', cause: { safe: 1 } });
    let bodies = 0;
    let next = 0;
    let mappings = 0;
    const input = { secret: SECRET };
    const fail = (parent: any) => {
      mappings++;
      if (source === 'selected-state') expect(parent.secret).toBe(SECRET);
      if (source === 'selected-input') expect(input.secret).toBe(SECRET);
      throw error;
    };
    const inner = flowChart(
      'Inner',
      () => {
        bodies++;
      },
      'inner',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        if (source !== 'selected-input') s.secret = SECRET;
      },
      'seed',
    )
      .addSubFlowChartNext(
        'child',
        inner,
        'Child',
        mapping === 'input' ? { inputMapper: fail } : { outputMapper: (_output: unknown, parent: any) => fail(parent) },
      )
      .addFunction(
        'Next',
        () => {
          next++;
        },
        'next',
      )
      .build();
    const result = await stageErrorSurfaces(
      chart,
      policy ? { keys: ['secret'] } : undefined,
      source === 'selected-input' ? input : undefined,
    );
    expect(mappings).toBe(1);
    expect(bodies).toBe(mapping === 'input' ? 0 : 1);
    expect(next).toBe(mapping === 'input' ? 0 : 1);
    expect(result.rejected).toBe(mapping === 'input' ? error : undefined);
    expect(result.retained.tree).toContain(`${mapping}MapperError`);
    const logs = parentLogs(result.retained.logger, `Error in ${mapping}Mapper`);
    expect(logs).toHaveLength(1);
    expect(logs[0][1].error.message).toBe(policy ? '[REDACTED]' : message);
    if (policy) expect(result.retained.tree).not.toContain(message);
    else expect(result.retained.tree).toContain(`Error: ${message}`);
    expect(error.message).toBe(message);
    expect(error.name).toBe('Error');
    expect(error.code).toBe('MAPPER_CODE');
    expect(error.cause).toEqual({ safe: 1 });
    expect(result.retained.disk).toContain('"closed"');
    expect(result.retained.disk).toContain('capture-history');
  });

  it('a clear child still obeys independently selected wrapper diagnostics', async () => {
    const error = Object.assign(new Error('public nested failure'), { code: 'PUBLIC_CODE' });
    const inner = flowChart(
      'Inner',
      () => {
        throw error;
      },
      'inner',
    ).build();
    const result = await stageErrorSurfaces(
      flowChart('Start', () => undefined, 'start')
        .addSubFlowChartNext('child', inner, 'Child')
        .build(),
      { diagnostics: { keys: ['errors.subflowError'] } } as any,
    );
    expect(result.rejected).toBe(error);
    expect(result.retained.tree).toContain('subflowError');
    const logs = parentLogs(result.retained.logger, 'Error in subflow');
    expect(logs).toHaveLength(1);
    expect(logs[0][1].error.message).toBe('[REDACTED]');
    expect(error.message).toBe('public nested failure');
    expect(error.code).toBe('PUBLIC_CODE');
  });
});
