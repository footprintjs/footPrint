/**
 * Narrative pause/resume events — 5-pattern tests.
 *
 * Tests that pause/resume events appear in the narrative and FlowRecorder system.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import type { FlowPauseEvent, FlowResumeEvent } from '../../../../src/lib/engine/narrative/types';

// ── Helpers ─────────────────────────────────────────────────

interface TestState {
  value: string;
  approved?: boolean;
  [key: string]: unknown;
}

const approvalHandler: PausableHandler<any> = {
  execute: async (scope) => {
    scope.value = 'prepared';
    return { pause: true, data: { question: 'Approve?' } };
  },
  resume: async (scope, input: { approved: boolean }) => {
    scope.approved = input.approved;
  },
};

function buildTestChart() {
  return flowChart<TestState>(
    'Seed',
    (scope) => {
      scope.value = 'init';
    },
    'seed',
  )
    .addPausableFunction('Approve', approvalHandler, 'approve')
    .addFunction(
      'Process',
      (scope) => {
        scope.value = 'done';
      },
      'process',
    )
    .build();
}

// ── Unit ────────────────────────────────────────────────────

describe('Narrative pause/resume — unit', () => {
  it('onPause fires on FlowRecorder when execution pauses', async () => {
    const pauseEvents: FlowPauseEvent[] = [];
    const chart = buildTestChart();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    executor.attachFlowRecorder({
      id: 'test-pause',
      onPause: (event) => pauseEvents.push(event),
    });

    await executor.run();

    expect(pauseEvents).toHaveLength(1);
    expect(pauseEvents[0].stageName).toBe('Approve');
    expect(pauseEvents[0].stageId).toBe('approve');
    expect(pauseEvents[0].pauseData).toEqual({ question: 'Approve?' });
    expect(pauseEvents[0].subflowPath).toEqual([]);
  });

  it('onResume fires on FlowRecorder when execution resumes', async () => {
    const resumeEvents: FlowResumeEvent[] = [];
    const chart = buildTestChart();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    executor.attachFlowRecorder({
      id: 'test-resume',
      onResume: (event) => resumeEvents.push(event),
    });

    await executor.run();
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });

    expect(resumeEvents).toHaveLength(1);
    expect(resumeEvents[0].stageName).toBe('Approve');
    expect(resumeEvents[0].stageId).toBe('approve');
    expect(resumeEvents[0].hasInput).toBe(true);
  });

  it('pause appears in combined narrative entries', async () => {
    const chart = buildTestChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();

    const entries = executor.getNarrativeEntries();
    const pauseEntry = entries.find((e) => e.type === 'pause');
    expect(pauseEntry).toBeDefined();
    expect(pauseEntry!.text).toContain('paused');
    expect(pauseEntry!.text).toContain('Approve');
  });

  it('resume appears in combined narrative entries', async () => {
    const chart = buildTestChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });

    const entries = executor.getNarrativeEntries();
    const resumeEntry = entries.find((e) => e.type === 'resume');
    expect(resumeEntry).toBeDefined();
    expect(resumeEntry!.text).toContain('resumed');
    expect(resumeEntry!.text).toContain('Approve');
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('Narrative pause/resume — boundary', () => {
  it('onResume with no input shows hasInput=false', async () => {
    const resumeEvents: FlowResumeEvent[] = [];
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({ pause: true }),
          resume: async () => {},
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    executor.attachFlowRecorder({
      id: 'test',
      onResume: (event) => resumeEvents.push(event),
    });

    await executor.run();
    await executor.resume(executor.getCheckpoint()!);

    expect(resumeEvents[0].hasInput).toBe(false);
  });

  it('non-pausing run produces no pause/resume entries', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addFunction(
        'Process',
        (scope) => {
          scope.value = 'done';
        },
        'process',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const entries = executor.getNarrativeEntries();
    expect(entries.filter((e) => e.type === 'pause')).toHaveLength(0);
    expect(entries.filter((e) => e.type === 'resume')).toHaveLength(0);
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('Narrative pause/resume — scenario', () => {
  it('full flow narrative: seed → approve(pause) ... resume → process', async () => {
    const chart = buildTestChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    // Run until pause
    await executor.run();
    const pauseNarrative = executor.getNarrativeEntries().map((e) => e.text);
    expect(pauseNarrative.some((s) => s.includes('paused'))).toBe(true);

    // Resume
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });
    const resumeNarrative = executor.getNarrativeEntries().map((e) => e.text);
    expect(resumeNarrative.some((s) => s.includes('resumed'))).toBe(true);
  });
});

// ── Property ────────────────────────────────────────────────

describe('Narrative pause/resume — property', () => {
  it('pause entry has correct stageId and type', async () => {
    const chart = buildTestChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();

    const entries = executor.getNarrativeEntries();
    const pauseEntry = entries.find((e) => e.type === 'pause');
    expect(pauseEntry!.stageId).toBe('approve');
    expect(pauseEntry!.stageName).toBe('Approve');
  });

  it('resume entry has correct stageId and type', async () => {
    const chart = buildTestChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();
    await executor.resume(executor.getCheckpoint()!, { approved: true });

    const entries = executor.getNarrativeEntries();
    const resumeEntry = entries.find((e) => e.type === 'resume');
    expect(resumeEntry!.stageId).toBe('approve');
    expect(resumeEntry!.stageName).toBe('Approve');
  });
});

// ── Security ────────────────────────────────────────────────

describe('Narrative pause/resume — security', () => {
  it('pauseData in FlowPauseEvent does not leak to narrative text', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({
            pause: true,
            data: { secret: 'API_KEY_123', question: 'Approve?' },
          }),
          resume: async () => {},
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    // pauseData is in the event object (for programmatic use), but NOT in the text
    const narrative = executor.getNarrativeEntries().map((e) => e.text);
    const allText = narrative.join(' ');
    expect(allText).not.toContain('API_KEY_123');
    expect(allText).not.toContain('secret');
  });

  it('recorder errors do not break execution', async () => {
    const chart = buildTestChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    executor.attachFlowRecorder({
      id: 'bad-recorder',
      onPause: () => {
        throw new Error('Recorder crash!');
      },
    });

    // Should not throw despite recorder crash
    await executor.run();
    expect(executor.isPaused()).toBe(true);
  });
});
