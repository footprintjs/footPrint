/**
 * RFC-001 Block 6 — UNIT tests for the tier router in `attach*Recorder`.
 *
 * Covers: options-bag form on all four attach methods, the CombinedRecorder
 * `delivery` FIELD form, method-shape detection ignoring the string field,
 * lazy single-dispatcher creation (zero allocation without opt-in),
 * idempotency-by-ID tier swaps (no double delivery), detach across tiers,
 * and the first-attach-wins dispatcher config with dev-warn on conflict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CombinedRecorder, ScopeRecorder } from '../../../../src/index';
import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

function simpleChart() {
  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('k', 1);
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        scope.$setValue('k', (scope.$getValue('k') as number) + 1);
        scope.$emit('test.event', { n: 2 });
      },
      'work',
    )
    .build();
}

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('Block 6 — tier router (unit)', () => {
  it('is lazy: no dispatcher exists until the first deferred attach', () => {
    const executor = new FlowChartExecutor(simpleChart());
    executor.attachScopeRecorder({ id: 'inline-only', onWrite: () => undefined });
    expect((executor as unknown as { deferredTier?: unknown }).deferredTier).toBeUndefined();

    executor.attachScopeRecorder({ id: 'deferred-one', onWrite: () => undefined }, { delivery: 'deferred' });
    expect((executor as unknown as { deferredTier?: unknown }).deferredTier).toBeDefined();
  });

  it('keeps ONE dispatcher per executor across multiple deferred attaches', () => {
    const executor = new FlowChartExecutor(simpleChart());
    executor.attachScopeRecorder({ id: 'a', onWrite: () => undefined }, { delivery: 'deferred' });
    const tier = (executor as unknown as { deferredTier?: unknown }).deferredTier;
    executor.attachFlowRecorder({ id: 'b', onStageExecuted: () => undefined }, { delivery: 'deferred' });
    executor.attachEmitRecorder({ id: 'c', onEmit: () => undefined }, { delivery: 'deferred' });
    expect((executor as unknown as { deferredTier?: unknown }).deferredTier).toBe(tier);
  });

  it('accepts the options bag on all four attach methods', () => {
    const executor = new FlowChartExecutor(simpleChart());
    executor.attachScopeRecorder({ id: 's', onWrite: () => undefined }, { delivery: 'deferred' });
    executor.attachFlowRecorder({ id: 'f', onStageExecuted: () => undefined }, { delivery: 'deferred' });
    executor.attachEmitRecorder({ id: 'e', onEmit: () => undefined }, { delivery: 'deferred' });
    executor.attachCombinedRecorder({ id: 'c', onWrite: () => undefined }, { delivery: 'deferred' });
    // All four landed on the deferred tier, not the inline lists.
    const inlineScope = (executor as unknown as { scopeRecorders: ScopeRecorder[] }).scopeRecorders;
    expect(inlineScope.map((r) => r.id)).toEqual([]);
    expect(
      executor
        .getScopeRecorders()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['c', 'e', 's']);
    expect(executor.getFlowRecorders().map((r) => r.id)).toEqual(['f']);
  });

  it('honors the CombinedRecorder `delivery` FIELD form', () => {
    const executor = new FlowChartExecutor(simpleChart());
    const rec: CombinedRecorder = { id: 'field-form', delivery: 'deferred', onWrite: () => undefined };
    executor.attachCombinedRecorder(rec);
    const inlineScope = (executor as unknown as { scopeRecorders: ScopeRecorder[] }).scopeRecorders;
    expect(inlineScope.length).toBe(0);
    expect((executor as unknown as { deferredTier?: unknown }).deferredTier).toBeDefined();
    expect(executor.getScopeRecorders().map((r) => r.id)).toEqual(['field-form']);
  });

  it('method-shape detection ignores the `delivery` string field (own event-METHOD props only)', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const executor = new FlowChartExecutor(simpleChart());
    // A recorder with ONLY the delivery field has no event methods —
    // nothing attaches anywhere, and the dev-mode warning fires.
    executor.attachCombinedRecorder({ id: 'no-methods', delivery: 'deferred' } as CombinedRecorder);
    expect(executor.getScopeRecorders().length).toBe(0);
    expect(executor.getFlowRecorders().length).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recorder 'no-methods' has no observer event methods"));

    // A scope-only recorder with the field lands on the scope channel only.
    executor.attachCombinedRecorder({ id: 'scope-only', delivery: 'deferred', onWrite: () => undefined });
    expect(executor.getScopeRecorders().map((r) => r.id)).toEqual(['scope-only']);
    expect(executor.getFlowRecorders().length).toBe(0);
  });

  it('tier swap inline → deferred: same id is removed from the inline list (no double delivery)', () => {
    const executor = new FlowChartExecutor(simpleChart());
    const rec: ScopeRecorder = { id: 'x', onWrite: () => undefined };
    executor.attachScopeRecorder(rec);
    executor.attachScopeRecorder(rec, { delivery: 'deferred' });
    const inlineScope = (executor as unknown as { scopeRecorders: ScopeRecorder[] }).scopeRecorders;
    expect(inlineScope.length).toBe(0);
    expect(executor.getScopeRecorders().map((r) => r.id)).toEqual(['x']); // exactly once, deferred tier
  });

  it('tier swap deferred → inline: same id is removed from the deferred registry', () => {
    const executor = new FlowChartExecutor(simpleChart());
    const rec: ScopeRecorder = { id: 'x', onWrite: () => undefined };
    executor.attachScopeRecorder(rec, { delivery: 'deferred' });
    executor.attachScopeRecorder(rec); // back to inline
    expect(executor.getScopeRecorders().map((r) => r.id)).toEqual(['x']); // exactly once, inline tier
    const tier = (executor as unknown as { deferredTier: { has(id: string): boolean } }).deferredTier;
    expect(tier.has('x')).toBe(false);
  });

  it('detachScopeRecorder / detachFlowRecorder remove deferred registrations too', () => {
    const executor = new FlowChartExecutor(simpleChart());
    executor.attachScopeRecorder({ id: 's', onWrite: () => undefined }, { delivery: 'deferred' });
    executor.attachFlowRecorder({ id: 'f', onStageExecuted: () => undefined }, { delivery: 'deferred' });
    executor.detachScopeRecorder('s');
    executor.detachFlowRecorder('f');
    expect(executor.getScopeRecorders().length).toBe(0);
    expect(executor.getFlowRecorders().length).toBe(0);
  });

  it('dispatcher config is first-attach-wins; a later differing option dev-warns (deduped)', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const executor = new FlowChartExecutor(simpleChart());
    executor.attachScopeRecorder({ id: 'a', onWrite: () => undefined }, { delivery: 'deferred', maxQueue: 100 });
    executor.attachScopeRecorder({ id: 'b', onWrite: () => undefined }, { delivery: 'deferred', maxQueue: 999 });
    const conflictWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('ignoring differing option'));
    expect(conflictWarnings().length).toBe(1); // one warning naming the offender
    expect(String(conflictWarnings()[0][0])).toContain("attach 'b'");
    expect(String(conflictWarnings()[0][0])).toContain('maxQueue');
    // Re-attaching the same offender is deduped (no console spam).
    executor.attachScopeRecorder({ id: 'b', onWrite: () => undefined }, { delivery: 'deferred', maxQueue: 999 });
    expect(conflictWarnings().length).toBe(1);
    // Matching options (or none) never warn.
    executor.attachScopeRecorder({ id: 'd', onWrite: () => undefined }, { delivery: 'deferred', maxQueue: 100 });
    executor.attachScopeRecorder({ id: 'e', onWrite: () => undefined }, { delivery: 'deferred' });
    expect(conflictWarnings().length).toBe(1);
  });

  it('idempotent re-attach on the SAME tier replaces, never duplicates', async () => {
    const executor = new FlowChartExecutor(simpleChart());
    const seen: string[] = [];
    executor.attachScopeRecorder(
      { id: 'x', onWrite: () => seen.push('first') },
      { delivery: 'deferred', capture: 'clone' },
    );
    executor.attachScopeRecorder(
      { id: 'x', onWrite: () => seen.push('second') },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'second')).toBe(true); // replacement delivered, never both
  });
});
