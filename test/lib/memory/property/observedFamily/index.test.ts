import { describe, expect, it } from 'vitest';

import type { NativeObserver, ObservationOptions } from './index.js';
import { createObservedFamilyDriver } from './index.js';

type Installer = Parameters<typeof createObservedFamilyDriver>[0];
type Driver = ReturnType<typeof createObservedFamilyDriver>;
type Mode = 'sync' | 'async';
type Escape = { readonly threw: true; readonly value: unknown } | { readonly threw: false; readonly value: unknown };

const program = () => ({ runId: 'literal-program-run-id', stages: [{ ops: [{ op: 'get', key: 'a' }] }] });
const options = (applied: unknown, leg = 'chart:0'): ObservationOptions => ({
  engine: { StageContext: { prototype: {} }, TransactionBuffer: { prototype: {} } },
  program: applied,
  leg,
  producer: {
    profile: 'rows-plus-redacted-paths',
    snapshotRows: () => 'inert rows',
    snapshotPaths: () => 'inert paths',
  },
});

function inertNative(
  leg: string,
  faults: {
    readonly unusable?: unknown;
    readonly cleanup?: unknown;
    readonly operationIssue?: string;
  } = {},
) {
  const calls: string[] = [];
  const receipt: ReturnType<NativeObserver['receipt']> = Object.freeze({
    leg,
    events: Object.freeze([{ id: 1, start: 1, end: 2, leg, method: 'get', outcome: 'returned' as const }]),
    issues: Object.freeze([]),
  });
  const operationReceipt: ReturnType<NativeObserver['operations']['receipt']> = {
    spans: Object.freeze([
      {
        coordinate: Object.freeze(['chart', leg, 'stage', 0, 'op', 0]),
        programPath: Object.freeze(['stages', 0, 'ops', 0]),
        start: 1,
        end: 2,
        edits: Object.freeze([]),
        outcome: 'returned',
      },
    ]),
    issues: Object.freeze(faults.operationIssue === undefined ? [] : [faults.operationIssue]),
  };
  const native: NativeObserver = {
    operations: {
      current: () => undefined,
      within: (_stamp, runUnchanged) => runUnchanged(),
      edit: (value, n, original) => original(value, n),
      receipt: () => {
        calls.push('operations');
        return operationReceipt;
      },
    },
    commitOf: () => undefined,
    receipt: () => {
      calls.push('receipt');
      return receipt;
    },
    assertUsable: () => {
      calls.push('assert');
      if (Object.hasOwn(faults, 'unusable')) throw faults.unusable;
    },
    restore: () => {
      calls.push('restore');
      if (Object.hasOwn(faults, 'cleanup')) throw faults.cleanup;
    },
  };
  return { native, receipt, operationReceipt, calls };
}

function fixture(leg = 'chart:0', faults: Parameters<typeof inertNative>[1] = {}) {
  const observed = inertNative(leg, faults);
  const installs: Parameters<Installer>[] = [];
  const install: Installer = (...args) => {
    installs.push(args);
    return observed.native;
  };
  return { ...observed, installs, driver: createObservedFamilyDriver(install) };
}

function invoke(
  mode: Mode,
  driver: Driver,
  input: ObservationOptions,
  work: (native: NativeObserver) => { value: string; commits: readonly { bytes: string; foldsBack: boolean }[] },
) {
  return mode === 'sync' ? driver.sync(input, work) : driver.async(input, async (native) => work(native));
}

async function escape(run: () => unknown): Promise<Escape> {
  try {
    return { threw: false, value: await run() };
  } catch (value) {
    return { threw: true, value };
  }
}

const escaping = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'zero', value: 0 },
  { label: 'string', value: 'unchanged escape' },
  { label: 'symbol', value: Symbol('unchanged escape') },
  { label: 'object', value: Object.freeze({ reason: 'not an Error' }) },
];

describe.each(['sync', 'async'] as const)('observed-family %s inert lifetime', (mode) => {
  it('injects exactly one SAME observer and collects its own receipts before restoring', async () => {
    const f = fixture();
    const applied = program();
    const before = JSON.stringify(applied);
    const input = options(applied);
    const commits = Object.freeze([{ bytes: 'original witness bytes', foldsBack: true, nativeId: 1 }]);
    const result = await invoke(mode, f.driver, input, (native) => {
      expect(native).toBe(f.native);
      f.calls.push('work');
      return { value: 'original result', commits };
    });
    expect(f.installs).toHaveLength(1);
    expect(f.installs[0][0]).toBe(input.engine);
    expect(f.installs[0][1]).toBe(input.leg);
    expect(f.installs[0][2]).toBe(input.producer);
    expect(result.value).toBe('original result');
    expect(result.commits).toBe(commits);
    expect(result.native).toBe(f.receipt);
    expect(result.operations).toBe(f.operationReceipt.spans);
    expect(result.program).toBe(before);
    expect(JSON.stringify(applied)).toBe(before);
    expect(f.calls).toEqual(['work', 'assert', 'operations', 'receipt', 'restore']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(escaping)('restores and preserves the escaping $label identity', async ({ value }) => {
    const f = fixture();
    const applied = program();
    const before = JSON.stringify(applied);
    const result = await escape(() =>
      invoke(mode, f.driver, options(applied), (native) => {
        expect(native).toBe(f.native);
        f.calls.push('work');
        throw value;
      }),
    );
    expect(result.threw).toBe(true);
    expect(result.value).toBe(value);
    expect(JSON.stringify(applied)).toBe(before);
    expect(f.calls).toEqual(['work', 'restore']);
  });

  it('rejects even a program runId-only mutation instead of applying record volatility', async () => {
    const f = fixture();
    const applied = program();
    const result = await escape(() =>
      invoke(mode, f.driver, options(applied), () => {
        applied.runId = 'different-applied-program';
        return { value: 'must not be admitted', commits: [] };
      }),
    );
    expect(result.threw).toBe(true);
    expect(result.value).toBeInstanceOf(Error);
    expect((result.value as Error).message).toBe('Observation run changed its applied program bytes.');
    expect(f.calls).toEqual(['assert', 'restore']);
  });

  it('restores on evidence refusal without returning an apparent successful observation', async () => {
    const refusal = Object.freeze({ unusable: true });
    const f = fixture('chart:0', { unusable: refusal });
    const result = await escape(() =>
      invoke(mode, f.driver, options(program()), () => ({ value: 'raw', commits: [] })),
    );
    expect(result).toEqual({ threw: true, value: refusal });
    expect(f.calls).toEqual(['assert', 'restore']);
  });

  it('refuses poisoned operation evidence and still restores', async () => {
    const f = fixture('chart:0', { operationIssue: 'overlapping fixture operation' });
    const result = await escape(() =>
      invoke(mode, f.driver, options(program()), () => ({ value: 'raw', commits: [] })),
    );
    expect(result.threw).toBe(true);
    expect(result.value).toBeInstanceOf(Error);
    expect((result.value as Error).message).toBe('Unusable operation observation.');
    expect(f.calls).toEqual(['assert', 'operations', 'restore']);
  });

  it.each(escaping)('does not swallow a cleanup-only $label throw', async ({ value }) => {
    const f = fixture('chart:0', { cleanup: value });
    const result = await escape(() =>
      invoke(mode, f.driver, options(program()), () => ({ value: 'raw', commits: [] })),
    );
    expect(result.threw).toBe(true);
    expect(result.value).toBe(value);
    expect(f.calls).toEqual(['assert', 'operations', 'receipt', 'restore']);
  });

  it('keeps BOTH failures in order even when neither escaping value is an Error', async () => {
    const f = fixture('chart:0', { cleanup: null });
    const result = await escape(() =>
      invoke(mode, f.driver, options(program()), () => {
        throw escaping[0].value;
      }),
    );
    expect(result.threw).toBe(true);
    expect(result.value).toBeInstanceOf(AggregateError);
    expect((result.value as AggregateError).message).toBe('Observed run and restoration both failed.');
    expect((result.value as AggregateError).errors).toEqual([undefined, null]);
    expect(f.calls).toEqual(['restore']);
  });
});

describe('observed-family lifetime boundaries', () => {
  it('awaits actual async work settlement before collecting or restoring', async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.driver.async(options(program()), async (native) => {
      expect(native).toBe(f.native);
      f.calls.push('work-start');
      await barrier;
      f.calls.push('work-end');
      return { value: 'settled', commits: [] };
    });
    expect(f.calls).toEqual(['work-start']);
    release();
    expect((await pending).value).toBe('settled');
    expect(f.calls).toEqual(['work-start', 'work-end', 'assert', 'operations', 'receipt', 'restore']);
  });

  it('keeps pause/resume legs independently installed, collected and restored, even when local IDs repeat', () => {
    const installed: ReturnType<typeof inertNative>[] = [];
    const install: Installer = (_engine, leg) => {
      const observed = inertNative(leg);
      installed.push(observed);
      return observed.native;
    };
    const driver = createObservedFamilyDriver(install);
    const applied = program();
    const before = JSON.stringify(applied);
    const pause = driver.sync(options(applied, 'pause:0'), (native) => {
      expect(native).toBe(installed[0].native);
      return { value: 'paused', commits: [{ bytes: 'pause bytes', foldsBack: true, nativeId: 1 }] };
    });
    expect(installed[0].calls).toEqual(['assert', 'operations', 'receipt', 'restore']);
    const resume = driver.sync(options(applied, 'pause:1'), (native) => {
      expect(native).toBe(installed[1].native);
      expect(native).not.toBe(installed[0].native);
      return { value: 'resumed', commits: [{ bytes: 'resume bytes', foldsBack: true, nativeId: 1 }] };
    });
    expect(installed).toHaveLength(2);
    expect(pause.native).toBe(installed[0].receipt);
    expect(resume.native).toBe(installed[1].receipt);
    expect(pause.native.events).toHaveLength(1);
    expect(resume.native.events).toHaveLength(1);
    expect(pause.native.leg).toBe('pause:0');
    expect(resume.native.leg).toBe('pause:1');
    expect(pause.native.events[0].id).toBe(resume.native.events[0].id);
    expect(pause.operations[0].coordinate).not.toEqual(resume.operations[0].coordinate);
    expect(installed[1].calls).toEqual(['assert', 'operations', 'receipt', 'restore']);
    expect(pause.program).toBe(before);
    expect(resume.program).toBe(before);
    expect(JSON.stringify(applied)).toBe(before);
  });

  it('rejects a non-JSON root before installation, so there is no partial lifetime to restore', () => {
    const f = fixture();
    expect(() => f.driver.sync(options(undefined), () => ({ value: 'never', commits: [] }))).toThrow(
      'Applied program is not JSON data.',
    );
    expect(f.installs).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});
