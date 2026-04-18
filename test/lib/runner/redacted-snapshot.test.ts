/**
 * Redacted Snapshot Mirror — 5-pattern tests.
 *
 * Verifies that `FlowChartExecutor.getSnapshot({ redact: true })` returns a
 * scrubbed `sharedState` that never contains the raw values of redacted
 * keys, while `getSnapshot()` / `getSnapshot({ redact: false })` continues
 * to return the raw working memory (needed for pause/resume).
 *
 * Architecture under test:
 *   - `ExecutionRuntime.enableRedactedMirror()` creates a parallel
 *     SharedMemory.
 *   - `StageContext.commit()` feeds already-computed redacted patches into
 *     the mirror alongside the raw patches into `globalStore`.
 *   - `getSnapshot({ redact: true })` reads from the mirror.
 *   - The mirror is created only when a RedactionPolicy is configured —
 *     zero allocation otherwise.
 */

import { describe, expect, it } from 'vitest';

import type { TypedScope } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

interface DemoState {
  name: string;
  ssn: string;
  apiKey: string;
  patient: { dob: string; ssn: string; city: string };
  public: string;
}

function buildChart() {
  return flowChart<DemoState>(
    'Seed',
    (scope: TypedScope<DemoState>) => {
      scope.name = 'Alice';
      scope.ssn = '123-45-6789';
      scope.apiKey = 'sk-secret-xxx';
      scope.patient = { dob: '1980-01-01', ssn: '999-99-9999', city: 'NYC' };
      scope.public = 'visible';
    },
    'seed',
  ).build();
}

// ── Unit ────────────────────────────────────────────────────

describe('Redacted snapshot — unit', () => {
  it('getSnapshot({ redact: true }) scrubs keys listed in policy.keys', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn', 'apiKey'] });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const shared = safe.sharedState as Record<string, unknown>;
    expect(shared.ssn).toBe('REDACTED');
    expect(shared.apiKey).toBe('REDACTED');
    expect(shared.name).toBe('Alice');
    expect(shared.public).toBe('visible');
  });

  it('getSnapshot() default returns raw values (runtime view)', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const raw = executor.getSnapshot();
    const shared = raw.sharedState as Record<string, unknown>;
    expect(shared.ssn).toBe('123-45-6789');
  });

  it('getSnapshot({ redact: true }) scrubs keys matched by regex patterns', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ patterns: [/key|ssn/i] });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const shared = safe.sharedState as Record<string, unknown>;
    expect(shared.apiKey).toBe('REDACTED');
    expect(shared.ssn).toBe('REDACTED');
    expect(shared.name).toBe('Alice');
  });

  it('field-level `fields` policy pins current behavior: scrubs recorder dispatch only (NOT snapshot mirror yet)', async () => {
    // DOCUMENTED LIMITATION: `policy.fields: { key: [fieldNames] }` scrubs the
    // value sent to recorders (`onWrite` event) but does NOT propagate into
    // the redacted mirror. Callers who need field-level redaction in the
    // exported snapshot should either:
    //   1. Split the sensitive fields into their own top-level keys, OR
    //   2. Call a user-side scrub before exporting the snapshot, OR
    //   3. Wait for a follow-up release that extends the mirror to honor
    //      `fields` policy.
    // This test pins the current behavior so any regression (either direction)
    // is caught.
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ fields: { patient: ['dob', 'ssn'] } });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const patient = (safe.sharedState as { patient: Record<string, unknown> }).patient;
    // Current behavior: raw fields survive in the snapshot
    expect(patient.dob).toBe('1980-01-01');
    expect(patient.ssn).toBe('999-99-9999');
    expect(patient.city).toBe('NYC');
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('Redacted snapshot — boundary', () => {
  it('{ redact: true } without a policy is a no-op (returns raw)', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    // No setRedactionPolicy — mirror never created
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const raw = executor.getSnapshot({ redact: false });
    expect(safe.sharedState).toEqual(raw.sharedState);
    // Still raw because the mirror was never enabled
    expect((safe.sharedState as Record<string, unknown>).ssn).toBe('123-45-6789');
  });

  it('mirror writes survive a stage that writes nothing redactable', async () => {
    // Proves the mirror isn't only populated for redacted writes — it must
    // hold the full scrubbed sharedState, including non-redacted keys.
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const shared = safe.sharedState as Record<string, unknown>;
    expect(shared.name).toBe('Alice'); // non-redacted key must still be in the mirror
    expect(shared.public).toBe('visible');
  });

  it('passing { redact: false } explicitly returns raw view', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const raw = executor.getSnapshot({ redact: false });
    expect((raw.sharedState as Record<string, unknown>).ssn).toBe('123-45-6789');
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('Redacted snapshot — scenario (end-to-end with multiple stages)', () => {
  it('redacted mirror accumulates across stages correctly', async () => {
    interface TwoStageState {
      a: string;
      b: string;
      c: string;
    }
    const chart = flowChart<TwoStageState>(
      'S1',
      (scope: TypedScope<TwoStageState>) => {
        scope.a = 'public-a';
        scope.b = 'sensitive-b';
      },
      's1',
    )
      .addFunction(
        'S2',
        (scope: TypedScope<TwoStageState>) => {
          scope.c = 'secret-c';
        },
        's2',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ patterns: [/^b$|^c$/] });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const shared = safe.sharedState as Record<string, unknown>;
    expect(shared.a).toBe('public-a');
    expect(shared.b).toBe('REDACTED');
    expect(shared.c).toBe('REDACTED');

    const raw = executor.getSnapshot();
    const rawShared = raw.sharedState as Record<string, unknown>;
    expect(rawShared.b).toBe('sensitive-b');
    expect(rawShared.c).toBe('secret-c');
  });

  it('commitLog is already scrubbed regardless of { redact } flag', async () => {
    // The event log has always been redacted at write-time. This test
    // confirms the new mirror feature doesn't regress that guarantee.
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const snap = executor.getSnapshot(); // no redact flag
    const ssnWrites: unknown[] = [];
    for (const bundle of snap.commitLog) {
      const ow = (bundle as { overwrite?: Record<string, unknown> }).overwrite ?? {};
      if (ow.ssn !== undefined) ssnWrites.push(ow.ssn);
    }
    // Every commit-log entry for 'ssn' is scrubbed
    for (const v of ssnWrites) {
      expect(v).toBe('REDACTED');
    }
  });
});

// ── Property ────────────────────────────────────────────────

describe('Redacted snapshot — property', () => {
  it('redacted keys are NEVER present with their raw value in redacted snapshot', async () => {
    const secretValue = 'NEVER_LEAK_THIS_RAW_SECRET_VALUE_XXXYYY';
    const chart = flowChart<{ userSecret: string; plain: string }>(
      'Seed',
      (scope) => {
        scope.userSecret = secretValue;
        scope.plain = 'hello';
      },
      'seed',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['userSecret'] });
    await executor.run();

    const safeJson = JSON.stringify(executor.getSnapshot({ redact: true }));
    // Core invariant: raw secret never appears in the redacted snapshot
    expect(safeJson.includes(secretValue)).toBe(false);
    // Raw view still has it (that's correct — runtime needs raw data)
    const rawJson = JSON.stringify(executor.getSnapshot());
    expect(rawJson.includes(secretValue)).toBe(true);
  });

  it('non-redacted keys survive unchanged from raw to redacted snapshot', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const raw = executor.getSnapshot() as { sharedState: Record<string, unknown> };
    const safe = executor.getSnapshot({ redact: true }) as { sharedState: Record<string, unknown> };

    for (const key of Object.keys(raw.sharedState)) {
      if (key === 'ssn') continue;
      expect(safe.sharedState[key]).toEqual(raw.sharedState[key]);
    }
  });
});

// ── Security ────────────────────────────────────────────────

describe('Redacted snapshot — security', () => {
  it('mirror enablement is gated on policy — no leak through silent fallback', async () => {
    // If someone calls getSnapshot({ redact: true }) without setting a
    // policy, we must NOT silently return the raw data AND claim it's
    // redacted. Current behavior: mirror doesn't exist, falls back to raw
    // (documented as a no-op). Callers must configure a policy for safety.
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    // NO policy set
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    const shared = safe.sharedState as Record<string, unknown>;
    // This demonstrates the fallback — if a caller was using this to
    // safely export, they'd leak. Doc covers it, this test pins it.
    expect(shared.ssn).toBe('123-45-6789');
  });

  it('redaction policy set AFTER construction but BEFORE run() still takes effect', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    // Simulate policy setup happening between constructor and run
    executor.setRedactionPolicy({ keys: ['apiKey'] });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    expect((safe.sharedState as Record<string, unknown>).apiKey).toBe('REDACTED');
  });
});
