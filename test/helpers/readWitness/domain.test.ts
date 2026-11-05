/** Dynamic domain and unconditional BUILD law over actual inert native calls; no program filter. */
import { expect, it } from 'vitest';

import { captureNativeSync } from './capture.js';
import { assertBuildDeletedReadsUndefined, BuildTombstoneReadViolation, oracleDomain } from './domain.js';
import type { NativeFact, Receipt } from './observationTypes.js';
import { BufferPort, hooks, StagePort } from './portsFixture.js';
import { sameStageDeletedReadInputs } from './selector.js';

function capture(value: unknown, middle?: (stage: StagePort) => StagePort | void) {
  return captureNativeSync(hooks, 'run', () => {
    const storage = new BufferPort();
    storage.readResult = value;
    const stage = new StagePort(storage, ['runs', 'r']);
    stage.setObject([], 'cfg', undefined);
    const reader = middle?.(stage) ?? stage;
    return reader.getValue([], 'cfg');
  });
}
it.each([false, null, 0, '', {}, [], Symbol('raw'), () => 1].map((value) => ({ value })))(
  'a native defined return alone trips the baseline domain',
  ({ value }) => {
    const seen = capture(value);
    expect(seen.value).toBe(value);
    const decision = oracleDomain(seen.native);
    expect(decision.kind).toBe('out-of-domain');
    if (decision.kind === 'out-of-domain') {
      const [input] = decision.violations;
      expect(seen.native.events).toContain(input.read);
      expect(seen.native.events).toContain(input.get);
      expect(seen.native.events).toContain(input.deletedBy);
      expect(input.get.address).toEqual(['runs', 'r', 'cfg']);
      expect(input.read.result).toEqual({ kind: 'defined' });
    }
  },
);
it('does not exclude an actually undefined read; BUILD law runs without any baseline argument', () => {
  const seen = capture(undefined);
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
  expect(sameStageDeletedReadInputs(seen.native)).toHaveLength(1);
  expect(() => assertBuildDeletedReadsUndefined(seen.native)).not.toThrow();
});
it('fails a lying BUILD read even beside a caller-supplied false classification field', () => {
  const seen = capture(7);
  expect(() => assertBuildDeletedReadsUndefined({ ...seen.native, excluded: false } as Receipt)).toThrow(
    BuildTombstoneReadViolation,
  );
});
it.each(['replacement', 'descendant', 'commit', 'foreign-frame'] as const)(
  '%s cannot create an exclusion',
  (change) => {
    const seen = capture(7, (stage) => {
      if (change === 'replacement') stage.setObject([], 'cfg', 7);
      if (change === 'descendant') stage.setObject(['cfg'], 'child', 7);
      if (change === 'commit') stage.commit();
      if (change === 'foreign-frame') {
        const b = new BufferPort();
        b.readResult = 7;
        return new StagePort(b, ['runs', 'r']);
      }
    });
    expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
  },
);
it('an actual ancestor native write re-establishes the selected path', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.setObject(['cfg'], 'child', undefined);
    s.setObject([], 'cfg', {});
    return s.getValue(['cfg'], 'child');
  });
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
});
it('a foreign canonical address on the SAME native frame is not excluded', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.setObject([], 'cfg', undefined);
    return s.getValue([], 'other');
  });
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
});
it('an unrelated write does not hide a genuine tombstone violation', () => {
  expect(
    oracleDomain(
      capture(7, (s) => {
        s.setObject([], 'other', 1);
      }).native,
    ).kind,
  ).toBe('out-of-domain');
});
it('nested native read methods are each bound to the ONE actual get, without repeating it', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.setObject([], 'cfg', undefined);
    s.getValueDirect([], 'cfg');
    return b.calls;
  });
  expect(seen.value.filter((row) => row[0] === 'get')).toHaveLength(1);
  expect(sameStageDeletedReadInputs(seen.native)).toHaveLength(2);
  expect(() => assertBuildDeletedReadsUndefined(seen.native)).toThrow(BuildTombstoneReadViolation);
});
it.each(['issue', 'unknown-tier', 'missing-get', 'duplicate-id', 'cross-leg', 'wrong-stage-phase'] as const)(
  'unknown native %s cannot become a false in-domain result',
  (damage) => {
    const native = capture(7).native;
    let changed: Receipt = native;
    if (damage === 'issue') changed = { ...native, issues: ['uncollected evidence'] };
    if (damage === 'unknown-tier')
      changed = {
        ...native,
        events: native.events.map((e, i) => (i === 0 ? { ...e, tier: 'unknown' as NativeFact['tier'] } : e)),
      };
    if (damage === 'missing-get') changed = { ...native, events: native.events.filter((e) => e.method !== 'get') };
    if (damage === 'duplicate-id') changed = { ...native, events: [...native.events, native.events[0]] };
    if (damage === 'cross-leg') changed = { ...native, leg: 'other' };
    if (damage === 'wrong-stage-phase')
      changed = {
        ...native,
        events: native.events.map((e) =>
          e.tier === 'stage-call' && e.method === 'getValue' ? { ...e, phase: 'write' } : e,
        ),
      };
    expect(() => oracleDomain(changed)).toThrow();
    expect(() => assertBuildDeletedReadsUndefined(changed)).toThrow();
  },
);

it('a later write cannot retroactively erase an already observed violation', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.setObject([], 'cfg', undefined);
    s.getValue([], 'cfg');
    s.setObject([], 'cfg', 7);
  });
  expect(oracleDomain(seen.native).kind).toBe('out-of-domain');
});
it('numeric/string property overlap cannot hide a re-establishing write', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.setObject(['cfg', 0], 'leaf', undefined);
    s.setObject(['cfg'], '0', {});
    s.getValue(['cfg', 0], 'leaf');
  });
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
});
it('a read before a tombstone never excludes a program', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.getValue([], 'cfg');
    s.setObject([], 'cfg', undefined);
  });
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
});
