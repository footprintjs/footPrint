/**
 * The record sink's first-loss dev warning says what happens next: under `onFailure: 'report'` the run goes on,
 * under `onFailure: 'fail'` the run stops (the same loss aborts the run's signal).
 *
 * Test types: Functional (the warning text per mode).
 */
import type { RecordSink } from 'foottrace/write';
import { memorySink } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../src/index.js';

function chart() {
  return flowChart<Record<string, any>>(
    'S0',
    (s) => {
      s.n = 0;
    },
    's0',
  )
    .addFunction(
      'S1',
      async (s) => {
        await Promise.resolve();
        s.n = 1;
      },
      's1',
    )
    .build();
}

/** A memory sink that refuses every commit. */
function refusingCommits(): RecordSink {
  const inner = memorySink();
  return {
    opened: (e) => inner.opened(e),
    commit: () => {
      throw new Error('commit refused');
    },
    note: (e) => inner.note(e),
    closed: (e) => inner.closed(e),
    flush: () => inner.flush!(),
  };
}

async function firstWarning(onFailure: 'report' | 'fail'): Promise<string> {
  enableDevMode();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const executor = new FlowChartExecutor(chart(), { sink: { adapter: refusingCommits(), onFailure } });
  await executor.run().catch(() => undefined);
  const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('record sink'));
  return lines[0] ?? '';
}

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('record sink first-loss warning', () => {
  it("under 'report' it says the run goes on", async () => {
    const line = await firstWarning('report');
    expect(line).toContain('The run goes on');
  });

  it("under 'fail' it says the run stops", async () => {
    const line = await firstWarning('fail');
    expect(line).toContain("The run stops (onFailure: 'fail')");
    expect(line).not.toContain('The run goes on');
  });
});
