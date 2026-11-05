/** Actual native transparency; imported fixtures own their original independent commit witness. */
import { describe, expect, it } from 'vitest';

import {
  BASELINE,
  BUILD,
  bytes,
  oracleVerdict,
  witnessingSync,
} from '../../lib/memory/property/copy-on-write-fixture.js';
import { captureNativeSync } from './capture.js';
import { assertBuildDeletedReadsUndefined, oracleDomain } from './domain.js';
import { BufferPort, hooks, StagePort } from './portsFixture.js';
import { sameStageDeletedReadInputs } from './selector.js';

describe.each([BASELINE, BUILD])('minimal native observer on $label', (engine) => {
  function program() {
    const memory = new engine.SharedMemory(undefined, { cfg: { n: 1 }, other: 7 });
    const log = new engine.EventLog(memory.getState());
    const stage = new engine.StageContext('', 'Stage', 'stage', memory, '', log);
    stage.setObject([], 'cfg', undefined, false, undefined, 'delete');
    const value = stage.getValue([], 'cfg');
    const immediate = bytes(value);
    const retained = bytes(stage.getSnapshot().stageReads);
    stage.commit();
    return { immediate, retained, commits: bytes(log.list()), state: bytes(memory.getState()) };
  }
  it('preserves every ordinary result and independent commit witness while observing the native law', () => {
    const plain = witnessingSync(engine, program);
    const stage = Object.getOwnPropertyDescriptors(engine.StageContext.prototype);
    const buffer = Object.getOwnPropertyDescriptors(engine.TransactionBuffer.prototype);
    const seen = captureNativeSync(engine, 'direct', () => witnessingSync(engine, program));
    expect(seen.value).toEqual(plain);
    expect(sameStageDeletedReadInputs(seen.native)).toHaveLength(1);
    expect(sameStageDeletedReadInputs(seen.native)[0].get.address).toEqual(['cfg']);
    expect(oracleDomain(seen.native).kind).toBe(engine === BUILD ? 'in-domain' : 'out-of-domain');
    if (engine === BUILD) expect(() => assertBuildDeletedReadsUndefined(seen.native)).not.toThrow();
    expect(Object.getOwnPropertyDescriptors(engine.StageContext.prototype)).toEqual(stage);
    expect(Object.getOwnPropertyDescriptors(engine.TransactionBuffer.prototype)).toEqual(buffer);
  });
  it('a normal namespace fallback without a same-frame tombstone is in-domain', () => {
    const seen = captureNativeSync(engine, 'namespace', () => {
      const memory = new engine.SharedMemory(undefined, { cfg: 7, runs: { branch: { cfg: undefined } } });
      const log = new engine.EventLog(memory.getState());
      const stage = new engine.StageContext('branch', 'Stage', 'stage', memory, '', log);
      return stage.getValue([], 'cfg');
    });
    expect(seen.value).toBe(7);
    expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
  });
});

it('excluded programs never invoke cross-engine comparison and cannot waive BUILD laws', () => {
  const observed = (value: unknown) =>
    captureNativeSync(hooks, 'control', () => {
      const buffer = new BufferPort();
      buffer.readResult = value;
      const stage = new StagePort(buffer);
      stage.setObject([], 'cfg', undefined);
      stage.getValue([], 'cfg');
    }).native;
  const baseline = observed(7);
  const build = observed(undefined);
  let comparisons = 0;
  const compare = () => {
    comparisons += 1;
    return false;
  };
  expect(oracleVerdict([], [], baseline, build, compare)).toEqual({ excluded: true, broken: '' });
  expect(comparisons).toBe(0);
  expect(oracleVerdict([], [{ bytes: 'lying', foldsBack: false }], baseline, build, compare).broken).toMatch(
    /does not fold back/,
  );
  expect(() => oracleVerdict([], [], baseline, observed(7), compare)).toThrow(/BUILD returned a defined value/);
  expect(comparisons).toBe(0);
  expect(oracleVerdict([], [], build, build, compare)).toEqual({ excluded: false, broken: '' });
  expect(comparisons).toBe(1);
});
