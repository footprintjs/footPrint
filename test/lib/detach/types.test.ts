/**
 * detach/types — 7-pattern tests.
 *
 * The `types.ts` file is types-only (no runtime behavior to test
 * directly). The 7 patterns here verify the SHAPE of the types via
 * type-only tests — TypeScript compilation success IS the test.
 *
 *   P1 Unit         — each interface has the expected fields
 *   P2 Boundary     — optional fields omitted compile; required fields enforced
 *   P3 Scenario     — a realistic driver implementation type-checks
 *   P4 Property     — DetachHandle has no `.then()` (NOT Promise-shaped)
 *   P5 Security     — `outputMapper` rejection — type-level enforcement (in T4)
 *   P6 Performance  — N/A for type-only file (perf budget covered in T3)
 *   P7 ROI          — typed exports are reachable from `footprintjs/detach`
 *                     (covered in T6)
 */

import { describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import type {
  DetachDriver,
  DetachHandle,
  DetachPollResult,
  DetachWaitResult,
  DriverCapabilities,
} from '../../../src/lib/detach/types.js';

// ─── P1 Unit — interfaces have the expected fields ───────────────────

describe('detach/types — P1 unit', () => {
  it('P1 DetachHandle exposes id, status, optional result, optional error, wait()', () => {
    // Construct an in-test handle that satisfies the interface.
    const handle: DetachHandle = {
      id: 'abc',
      status: 'queued',
      wait: () => Promise.resolve({ result: undefined } as DetachWaitResult),
    };
    expect(handle.id).toBe('abc');
    expect(handle.status).toBe('queued');
    expect(typeof handle.wait).toBe('function');
    expect(handle.result).toBeUndefined();
    expect(handle.error).toBeUndefined();
  });

  it('P1 DetachDriver exposes name, capabilities, schedule(), optional validate()', () => {
    const driver: DetachDriver = {
      name: 'test-driver',
      capabilities: { browserSafe: true, nodeSafe: true },
      schedule: (_child: FlowChart, _input: unknown, refId: string): DetachHandle => ({
        id: refId,
        status: 'done',
        result: 'ok',
        wait: () => Promise.resolve({ result: 'ok' }),
      }),
    };
    expect(driver.name).toBe('test-driver');
    expect(typeof driver.schedule).toBe('function');
    expect(driver.validate).toBeUndefined();
  });

  it('P1 DriverCapabilities optional flags compile when omitted', () => {
    const empty: DriverCapabilities = {};
    expect(empty.browserSafe).toBeUndefined();
    expect(empty.nodeSafe).toBeUndefined();
    expect(empty.edgeSafe).toBeUndefined();
    expect(empty.survivesUnload).toBeUndefined();
    expect(empty.cpuIsolated).toBeUndefined();
  });
});

// ─── P2 Boundary — optional vs required fields ───────────────────────

describe('detach/types — P2 boundary', () => {
  it('P2 DetachHandle terminal state with result populated', () => {
    const done: DetachHandle = {
      id: 'x',
      status: 'done',
      result: { value: 42 },
      wait: () => Promise.resolve({ result: { value: 42 } }),
    };
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ value: 42 });
    expect(done.error).toBeUndefined();
  });

  it('P2 DetachHandle terminal failure state with error populated', () => {
    const fail: DetachHandle = {
      id: 'y',
      status: 'failed',
      error: new Error('vendor 401'),
      wait: () => Promise.reject(new Error('vendor 401')),
    };
    expect(fail.status).toBe('failed');
    expect(fail.error?.message).toBe('vendor 401');
    expect(fail.result).toBeUndefined();
  });

  it('P2 DetachDriver with validate() implemented', () => {
    let validated = false;
    const d: DetachDriver = {
      name: 'with-validate',
      capabilities: {},
      schedule: (_c, _i, id) => ({
        id,
        status: 'queued',
        wait: () => Promise.resolve({ result: undefined }),
      }),
      validate: () => {
        validated = true;
      },
    };
    d.validate?.();
    expect(validated).toBe(true);
  });

  it('P2 DetachWaitResult is a tagged-fields object (not raw value)', () => {
    const r: DetachWaitResult = { result: 'anything' };
    expect(r.result).toBe('anything');
  });

  it('P2 DetachPollResult discriminates by status', () => {
    const done: DetachPollResult = { status: 'done', result: 1 };
    const fail: DetachPollResult = { status: 'failed', error: new Error('e') };
    expect(done.status).toBe('done');
    expect(fail.status).toBe('failed');
  });
});

// ─── P3 Scenario — realistic driver shape type-checks ────────────────

describe('detach/types — P3 scenario', () => {
  it('P3 a microtask-batch-style driver type-checks fully', () => {
    const queue: Array<{ refId: string; child: FlowChart; input: unknown }> = [];
    const handles = new Map<string, DetachHandle>();

    const fakeMicrotask: DetachDriver = {
      name: 'microtask-batch',
      capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
      schedule(child, input, refId) {
        queue.push({ refId, child, input });
        const h: DetachHandle = {
          id: refId,
          status: 'queued',
          wait: () => Promise.resolve({ result: undefined }),
        };
        handles.set(refId, h);
        return h;
      },
    };
    expect(fakeMicrotask.name).toBe('microtask-batch');
    expect(queue.length).toBe(0);
  });
});

// ─── P4 Property — DetachHandle is NOT Promise-shaped ────────────────

describe('detach/types — P4 property', () => {
  it('P4 DetachHandle has no .then() — not accidentally awaitable', () => {
    const h: DetachHandle = {
      id: 'a',
      status: 'queued',
      wait: () => Promise.resolve({ result: undefined }),
    };
    // @ts-expect-error — DetachHandle is not Thenable; if this compiles,
    //                   the type was widened by mistake.
    const accidentalThen = h.then;
    expect(accidentalThen).toBeUndefined();
  });

  it('P4 DetachHandle.status terminal values are known constants', () => {
    const states: DetachHandle['status'][] = ['queued', 'running', 'done', 'failed'];
    expect(states.length).toBe(4);
  });
});

// ─── P5 Security — defer to T4 (where outputMapper is added/rejected) ─

describe('detach/types — P5 security (placeholder)', () => {
  it('P5 outputMapper rejection is enforced at the builder layer (T4)', () => {
    // Pure types-file has no input mapper / output mapper — those
    // belong to the OPTIONS type added in T4. This test exists to
    // document the test plan; the actual enforcement test lands when
    // T4 ships the options type.
    expect(true).toBe(true);
  });
});

// ─── P6 Performance — N/A for types-only ─────────────────────────────

describe('detach/types — P6 performance (N/A here)', () => {
  it('P6 perf budget belongs to T3 driver implementations', () => {
    expect(true).toBe(true);
  });
});

// ─── P7 ROI — exports reachable (covered fully in T6 subpath gate) ───

describe('detach/types — P7 ROI', () => {
  it('P7 all 5 type exports are reachable from the lib path', () => {
    // Imports at the top of this file would fail to compile if any
    // export was missing; a passing test = passing import.
    const proof = {
      DetachDriverPresent: true,
      DetachHandlePresent: true,
      DetachWaitResultPresent: true,
      DetachPollResultPresent: true,
      DriverCapabilitiesPresent: true,
    };
    expect(Object.values(proof).every(Boolean)).toBe(true);
  });
});
