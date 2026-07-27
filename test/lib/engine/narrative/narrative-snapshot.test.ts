/**
 * `CombinedNarrativeRecorder.toSnapshot()` — the narrative rides
 * `executor.getSnapshot().recorders`.
 *
 * Why this exists: a consumer that only holds the frozen snapshot (a trace
 * viewer, an exported run, a UI panel that never sees the executor) had no
 * way to read the run's narrative — `getNarrativeEntries()` is an executor
 * method, and the narrative recorder was the one built-in with no snapshot
 * bundle. Attaching `narrative()` now puts the story on the snapshot.
 *
 * Patterns: unit, functional, integration, boundary, security, property.
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, narrative } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/index.js';
import type { CombinedNarrativeEntry } from '../../../../src/lib/engine/narrative/narrativeTypes.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface OrderState {
  amount: number;
  ssn: string;
  receipt: string;
}

function buildOrderChart() {
  return flowChart<OrderState>(
    'Intake',
    (scope) => {
      scope.amount = 120;
      scope.ssn = '123-45-6789';
    },
    'intake',
  )
    .addFunction(
      'Charge',
      (scope) => {
        scope.receipt = `charged ${scope.amount}`;
      },
      'charge',
    )
    .build();
}

/** The snapshot drops `rawValue` on purpose — compare against the same shape. */
function withoutRawValue(entries: CombinedNarrativeEntry[]) {
  return entries.map(({ rawValue: _rawValue, ...entry }) => entry);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. UNIT — the bundle shape
// ════════════════════════════════════════════════════════════════════════════

describe('narrative toSnapshot — unit', () => {
  it('names itself Narrative and declares a read-time operation', () => {
    const snap = new CombinedNarrativeRecorder().toSnapshot();
    expect(snap.name).toBe('Narrative');
    expect(snap.preferredOperation).toBe('translate');
    expect(snap.description).toContain('SequenceStore');
  });

  it('carries an empty entry list before any run', () => {
    expect(new CombinedNarrativeRecorder().toSnapshot().data).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. FUNCTIONAL — attached vs not attached
// ════════════════════════════════════════════════════════════════════════════

describe('narrative toSnapshot — functional', () => {
  it('an attached narrative() reaches snapshot.recorders with the run it recorded', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    const story = narrative();
    executor.attachCombinedRecorder(story);
    await executor.run();

    const row = executor.getSnapshot().recorders!.find((r) => r.id === story.id);
    expect(row).toBeDefined();
    expect(row!.name).toBe('Narrative');
    expect(row!.data).toEqual(withoutRawValue(story.getEntries()));
    expect((row!.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('is ABSENT when no narrative recorder is attached (enableNarrative alone stays internal)', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    executor.enableNarrative();
    await executor.run();

    const rows = executor.getSnapshot().recorders ?? [];
    expect(rows.find((r) => r.name === 'Narrative')).toBeUndefined();
    // …while the executor's own narrative API is untouched.
    expect(executor.getNarrativeEntries().length).toBeGreaterThan(0);
  });

  it('appears exactly once even though the narrative recorder rides both channels', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    const story = narrative();
    executor.attachCombinedRecorder(story);
    await executor.run();

    expect(executor.getSnapshot().recorders!.filter((r) => r.name === 'Narrative')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. INTEGRATION — the snapshot tells the same story the executor tells
// ════════════════════════════════════════════════════════════════════════════

describe('narrative toSnapshot — integration', () => {
  it('matches getNarrativeEntries() entry for entry', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    executor.attachCombinedRecorder(narrative({ id: 'run-story' }));
    await executor.run();

    const row = executor.getSnapshot().recorders!.find((r) => r.id === 'run-story');
    expect(row!.data).toEqual(withoutRawValue(executor.getNarrativeEntries()));
  });

  it('re-running the executor replaces the story instead of appending to it', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    const story = narrative();
    executor.attachCombinedRecorder(story);

    await executor.run();
    const first = (executor.getSnapshot().recorders!.find((r) => r.id === story.id)!.data as unknown[]).length;
    await executor.run();
    const second = (executor.getSnapshot().recorders!.find((r) => r.id === story.id)!.data as unknown[]).length;

    expect(second).toBe(first);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. BOUNDARY / SECURITY — the snapshot must stay a DETACHED, shareable artifact
// ════════════════════════════════════════════════════════════════════════════

describe('narrative toSnapshot — boundary + security', () => {
  it('survives structuredClone and a JSON round-trip', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    executor.attachCombinedRecorder(narrative());
    await executor.run();

    const rows = executor.getSnapshot().recorders!;
    expect(() => structuredClone(rows)).not.toThrow();
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });

  it('a non-cloneable emit payload cannot poison the snapshot', async () => {
    const chart = flowChart<{ done: boolean }>(
      'Emit',
      (scope) => {
        // A function payload is the classic structuredClone killer. It reaches
        // the narrative as a live `rawValue`, which is exactly why the snapshot
        // does not carry `rawValue`.
        scope.$emit('demo.callback', { retry: () => undefined });
        scope.done = true;
      },
      'emit',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(narrative());
    await executor.run();

    const rows = executor.getSnapshot().recorders!;
    expect(() => structuredClone(rows)).not.toThrow();
  });

  it('never carries the live rawValue reference', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    const story = narrative();
    executor.attachCombinedRecorder(story);
    await executor.run();

    const entries = executor.getSnapshot().recorders!.find((r) => r.id === story.id)!.data as Array<
      Record<string, unknown>
    >;
    expect(entries.some((e) => Object.prototype.hasOwnProperty.call(e, 'rawValue'))).toBe(false);
    // The rendered text still carries the value, so nothing readable is lost.
    expect(entries.some((e) => typeof e.text === 'string' && e.text.includes('120'))).toBe(true);
  });

  it('honors the redaction policy — a redacted value never reaches the snapshot', async () => {
    const executor = new FlowChartExecutor(buildOrderChart());
    executor.setRedactionPolicy({ keys: ['ssn'] });
    const story = narrative();
    executor.attachCombinedRecorder(story);
    await executor.run();

    const serialized = JSON.stringify(executor.getSnapshot().recorders!.find((r) => r.id === story.id));
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).toContain('REDACTED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. PROPERTY — the projection preserves order and every non-rawValue field
// ════════════════════════════════════════════════════════════════════════════

describe('narrative toSnapshot — property', () => {
  it('for a chart of ANY length the snapshot mirrors getEntries() 1:1', async () => {
    for (const stageCount of [1, 3, 12]) {
      let builder = flowChart<Record<string, unknown>>(
        'S0',
        (scope) => {
          scope.k0 = 0;
        },
        's0',
      );
      for (let i = 1; i < stageCount; i++) {
        builder = builder.addFunction(
          `S${i}`,
          (scope) => {
            scope[`k${i}`] = i;
          },
          `s${i}`,
        );
      }

      const executor = new FlowChartExecutor(builder.build());
      const story = narrative();
      executor.attachCombinedRecorder(story);
      await executor.run();

      const data = executor.getSnapshot().recorders!.find((r) => r.id === story.id)!.data;
      expect(data).toEqual(withoutRawValue(story.getEntries()));
    }
  });
});
