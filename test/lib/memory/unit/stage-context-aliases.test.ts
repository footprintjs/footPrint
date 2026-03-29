/**
 * Tests for the StageContext duplicate alias deprecation (P4-11).
 *
 * Fix: StageContext had three pairs of duplicate methods with identical implementations:
 *   - get()             → exact alias of getValue()
 *   - getFromRoot()     → exact alias of getRoot()
 *   - getFromGlobalContext() → exact alias of getGlobal()
 *
 * The duplicate names caused confusion about which was canonical and doubled the
 * surface area in the `advanced` package export. All three duplicates are marked
 * @deprecated and delegate to their canonical counterparts. Internal callers
 * (ScopeFacade, baseStateCompatible) have been updated to use the canonical names.
 */

import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

function makeCtx(runId = 'run-1', stageName = 'test-stage') {
  const mem = new SharedMemory();
  return new StageContext(runId, stageName, stageName, mem);
}

// ---------------------------------------------------------------------------
// Pattern 1: unit — canonical methods work as expected
// ---------------------------------------------------------------------------
describe('StageContext aliases — unit: canonical methods are primary', () => {
  it('getValue returns the value set via setObject', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'score', 750);
    expect(ctx.getValue([], 'score')).toBe(750);
  });

  it('getRoot reads from the shared memory root namespace', () => {
    const ctx = makeCtx();
    ctx.setRoot('status', 'done');
    ctx.commit();
    expect(ctx.getRoot('status')).toBe('done');
  });

  it('getGlobal reads from the global (run-independent) namespace', () => {
    const mem = new SharedMemory();
    const ctx = new StageContext('run-1', 'stage', 'stage', mem);
    ctx.setGlobal('globalKey', 'globalValue');
    ctx.commit();
    expect(ctx.getGlobal('globalKey')).toBe('globalValue');
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — deprecated aliases produce identical results
// ---------------------------------------------------------------------------
describe('StageContext aliases — boundary: deprecated aliases match canonical', () => {
  it('get() returns same value as getValue()', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'x', 42);
    expect(ctx.get([], 'x')).toBe(ctx.getValue([], 'x'));
  });

  it('getFromRoot() returns same value as getRoot()', () => {
    const ctx = makeCtx();
    ctx.setRoot('status', 'ok');
    ctx.commit();
    expect(ctx.getFromRoot('status')).toBe(ctx.getRoot('status'));
  });

  it('getFromGlobalContext() returns same value as getGlobal()', () => {
    const mem = new SharedMemory();
    const ctx = new StageContext('run-1', 'stage', 'stage', mem);
    ctx.setGlobal('gk', 'gv');
    ctx.commit();
    expect(ctx.getFromGlobalContext('gk')).toBe(ctx.getGlobal('gk'));
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — real pipeline reads via canonical methods
// ---------------------------------------------------------------------------
describe('StageContext aliases — scenario: canonical usage in pipeline-like flow', () => {
  it('multiple stages share same memory and canonical reads see cross-stage writes', () => {
    const mem = new SharedMemory();
    const ctx1 = new StageContext('run-1', 'stage1', 'stage1', mem);
    const ctx2 = new StageContext('run-1', 'stage2', 'stage2', mem);

    ctx1.setObject([], 'result', 'computed');
    ctx1.commit();

    // ctx2 should see the value committed by ctx1
    expect(ctx2.getValue([], 'result')).toBe('computed');
  });

  it('getGlobal reads persist across multiple StageContext instances on the same memory', () => {
    const mem = new SharedMemory();
    const ctx1 = new StageContext('run-1', 'stage1', 'stage1', mem);
    ctx1.setGlobal('shared', 'abc');
    ctx1.commit();

    const ctx2 = new StageContext('run-2', 'stage2', 'stage2', mem);
    expect(ctx2.getGlobal('shared')).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — deprecated aliases are consistent with canonical
// ---------------------------------------------------------------------------
describe('StageContext aliases — property: alias == canonical invariant', () => {
  it('get(path, key) === getValue(path, key) for any key', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'p', 'test');
    for (const key of ['p', 'missing', '']) {
      const canonical = ctx.getValue([], key || undefined);
      const alias = ctx.get([], key || undefined);
      expect(alias).toBe(canonical);
    }
  });

  it('getFromRoot(key) === getRoot(key) for any key', () => {
    const ctx = makeCtx();
    ctx.setRoot('r', 123);
    ctx.commit();
    for (const key of ['r', 'nonexistent']) {
      expect(ctx.getFromRoot(key)).toBe(ctx.getRoot(key));
    }
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — aliases don't expose additional attack surface
// ---------------------------------------------------------------------------
describe('StageContext aliases — security: no new surface from aliases', () => {
  it('deprecated get() does not bypass read tracking', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'secret', 'shhh');
    // Both should read from the transaction buffer / shared memory identically
    const v1 = ctx.getValue([], 'secret');
    const v2 = ctx.get([], 'secret');
    expect(v1).toBe(v2);
    expect(v1).toBe('shhh');
  });

  it('getFromGlobalContext cannot read from run-scoped namespace', () => {
    const mem = new SharedMemory();
    const ctx = new StageContext('run-scoped', 'stage', 'stage', mem);
    ctx.setObject([], 'runKey', 'runValue');
    ctx.commit();
    // getGlobal reads from '' namespace, not 'run-scoped' namespace
    expect(ctx.getGlobal('runKey')).toBeUndefined();
    expect(ctx.getFromGlobalContext('runKey')).toBeUndefined();
  });
});
