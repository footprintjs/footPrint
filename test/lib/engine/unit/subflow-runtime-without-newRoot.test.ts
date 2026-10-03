/**
 * A custom runtime of the 9.34.0 shape — no `newRoot`, a constructor that ignores the policy
 * argument — still runs a subflow the 9.34.0 way (the nested root is built from the seed root's
 * class) AND under the parent's policy and mirror (F5 compatibility, `SubflowExecutor ·
 * adoptPolicy` / `freshRoot`). One dial (writeProvenance) plus redaction shows it.
 *
 * Test types: Regression (the 9.34.0 runtime shape) · Integration (seed commit + final root).
 */
import { describe, expect, it, vi } from 'vitest';

import { SubflowExecutor } from '../../../../src/lib/engine/handlers/SubflowExecutor';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { HandlerDeps, SubflowResult } from '../../../../src/lib/engine/types';
import { RedactionRule } from '../../../../src/lib/memory/redaction';
import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

/** 9.34.0 shape: two-argument constructor (the policy is dropped), and no `newRoot`. */
class LegacyRuntime extends ExecutionRuntime {
  constructor(name: string, id: string) {
    super(name, id);
    (this as any).newRoot = undefined;
  }
}

describe('a runtime without newRoot runs a subflow under the parent policy and mirror', () => {
  it('the seed and the final nested root carry the policy; the mirror holds the placeholder', async () => {
    const policy = runPolicy({ writeProvenance: 'reads-prefix' }, new RedactionRule({ keys: ['secret'] }), true);
    let nested: any;
    const deps: HandlerDeps = {
      stageMap: new Map(),
      root: { name: 'root' },
      executionRuntime: new LegacyRuntime('root', 'root'),
      scopeFactory: () => ({}),
      scopeProtectionMode: 'off' as any,
      narrativeGenerator: new NullControlFlowNarrativeGenerator(),
      logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as HandlerDeps;
    const factory = (opts: any) => {
      nested = opts.executionRuntime;
      return { execute: vi.fn().mockResolvedValue(undefined), getSubflowResults: () => new Map() };
    };
    const parent: any = {
      stageName: 'Mount',
      stageId: 'sf',
      runtimeStageId: 'sf#1',
      branchId: '',
      getScope: () => ({}),
      getPolicy: () => policy,
      getStageId: () => 'sf',
      appendToArray: vi.fn(),
      mergeObject: vi.fn(),
      setGlobal: vi.fn(),
      useAddressOf: vi.fn(),
      addError: vi.fn(),
      commit: vi.fn(),
      setObject: vi.fn(),
      updateObject: vi.fn(),
      addLog: vi.fn(),
      addFlowDebugMessage: vi.fn(),
    };
    const node: any = {
      name: 'Mount',
      subflowId: 'sf',
      isSubflowRoot: false,
      subflowMountOptions: { inputMapper: () => ({ n: 1, secret: 'pw' }) },
    };

    await new SubflowExecutor(deps, factory as never).executeSubflow(
      node,
      parent,
      { shouldBreak: false },
      undefined,
      new Map<string, SubflowResult>(),
    );

    expect(nested).toBeInstanceOf(LegacyRuntime);
    expect(nested.newRoot).toBeUndefined();
    expect(nested.rootStageContext.getPolicy()).toBe(policy);
    expect(nested.rootStageContext.getRedactedSharedMemory()).toBe(nested.redactedStore);
    const [seed] = nested.executionHistory.list();
    expect(seed.trace).toEqual([
      { path: 'n', verb: 'set', readKeys: [] },
      { path: 'secret', verb: 'set', readKeys: [] },
    ]);
    expect(seed.overwrite.secret).toBe('REDACTED');
    expect(nested.redactedStore.getState()).toEqual({ n: 1, secret: 'REDACTED' });
  });
});
