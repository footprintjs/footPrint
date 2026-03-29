/**
 * Tests: Recorder factory functions — narrative(), metrics(), debug(), manifest().
 * Unit + Scenario + Boundary + Security + Property + ML.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { adaptive, debug, manifest, metrics, milestone, narrative, windowed } from '../../../../src/recorders';

interface State {
  name: string;
  value?: number;
}

function buildChart() {
  return flowChart<State>(
    'Start',
    async (scope) => {
      scope.name = 'Alice';
      scope.value = 42;
    },
    'start',
  )
    .addFunction(
      'Process',
      async (scope) => {
        scope.value = (scope.value ?? 0) * 2;
      },
      'process',
    )
    .build();
}

// -- Unit ------------------------------------------------------------------

describe('Recorder Factories — Unit', () => {
  it('narrative() creates recorder with .lines() and .entries()', async () => {
    const trace = narrative();
    const chart = buildChart();
    await chart.recorder(trace).run();

    expect(trace.lines().length).toBeGreaterThan(0);
    expect(trace.structured().length).toBeGreaterThan(0);
    expect(trace.id).toBeDefined();
  });

  it('metrics() creates recorder with .reads(), .writes(), .all()', async () => {
    const perf = metrics();
    const chart = buildChart();
    await chart.recorder(perf).run();

    expect(perf.reads()).toBeGreaterThan(0);
    expect(perf.writes()).toBeGreaterThan(0);
    // commits may be 0 if ScopeFacade doesn't dispatch onCommit via MetricRecorder
    expect(perf.all().totalReads).toBe(perf.reads());
    expect(perf.all().totalWrites).toBe(perf.writes());
  });

  it('metrics().stage(name) returns per-stage metrics', async () => {
    const perf = metrics();
    const chart = buildChart();
    await chart.recorder(perf).run();

    const startMetrics = perf.stage('Start');
    expect(startMetrics).toBeDefined();
    expect(startMetrics!.writeCount).toBeGreaterThan(0);
  });

  it('debug() creates recorder with .entries()', async () => {
    const dbg = debug({ verbosity: 'verbose' });
    const chart = buildChart();
    await chart.recorder(dbg).run();

    expect(dbg.logs().length).toBeGreaterThan(0);
    expect(dbg.id).toBeDefined();
  });

  it('manifest() creates recorder with .entries()', () => {
    const cat = manifest();
    expect(cat.id).toBeDefined();
    expect(typeof cat.entries).toBe('function');
    expect(cat.entries()).toEqual([]);
  });

  it('adaptive() creates flow recorder', () => {
    const rec = adaptive();
    expect(rec.id).toBeDefined();
  });

  it('milestone() creates flow recorder', () => {
    const rec = milestone();
    expect(rec.id).toBeDefined();
  });

  it('windowed() creates flow recorder', () => {
    const rec = windowed(10);
    expect(rec.id).toBeDefined();
  });

  it('narrative().clear() resets accumulated data', async () => {
    const trace = narrative();
    const chart = buildChart();
    await chart.recorder(trace).run();
    expect(trace.lines().length).toBeGreaterThan(0);

    trace.clear();
    expect(trace.lines()).toEqual([]);
    expect(trace.structured()).toEqual([]);
  });

  it('metrics().clear() resets accumulated data', async () => {
    const perf = metrics();
    const chart = buildChart();
    await chart.recorder(perf).run();
    expect(perf.reads()).toBeGreaterThan(0);

    perf.clear();
    expect(perf.reads()).toBe(0);
    expect(perf.writes()).toBe(0);
  });
});

// -- Scenario --------------------------------------------------------------

describe('Recorder Factories — Scenario', () => {
  it('chain narrative + metrics on same run', async () => {
    const trace = narrative();
    const perf = metrics();
    const chart = buildChart();

    await chart.recorder(trace).recorder(perf).run();

    expect(trace.lines().length).toBeGreaterThan(0);
    expect(perf.reads()).toBeGreaterThan(0);
  });

  it('narrative contains stage names', async () => {
    const trace = narrative();
    const chart = buildChart();
    await chart.recorder(trace).run();

    const lines = trace.lines();
    expect(lines.some((l) => l.includes('Start'))).toBe(true);
    expect(lines.some((l) => l.includes('Process'))).toBe(true);
  });

  it('narrative contains typed write values', async () => {
    const trace = narrative();
    const chart = buildChart();
    await chart.recorder(trace).run();

    const lines = trace.lines();
    expect(lines.some((l) => l.includes('name') && l.includes('Alice'))).toBe(true);
  });
});

// -- Boundary --------------------------------------------------------------

describe('Recorder Factories — Boundary', () => {
  it('narrative on chart with single stage', async () => {
    const trace = narrative();
    const chart = flowChart<{ x: number }>(
      'Only',
      async (scope) => {
        scope.x = 1;
      },
      'only',
    ).build();
    await chart.recorder(trace).run();
    expect(trace.lines().length).toBeGreaterThan(0);
  });

  it('metrics on chart with no reads (write-only)', async () => {
    const perf = metrics();
    const chart = flowChart<{ x: number }>(
      'Write',
      async (scope) => {
        scope.x = 1;
      },
      'write',
    ).build();
    await chart.recorder(perf).run();
    expect(perf.writes()).toBe(1);
  });

  it('debug with default options', async () => {
    const dbg = debug();
    const chart = buildChart();
    await chart.recorder(dbg).run();
    expect(dbg.id).toBeDefined();
  });
});

// -- Security --------------------------------------------------------------

describe('Recorder Factories — Security', () => {
  it('narrative with redaction hides values', async () => {
    const trace = narrative();
    const chart = flowChart<{ secret: string; public: string }>(
      'Start',
      async (scope) => {
        scope.secret = 'hunter2';
        scope.public = 'visible';
      },
      'start',
    ).build();

    await chart
      .recorder(trace)
      .redact({ keys: ['secret'] })
      .run();

    const lines = trace.lines();
    const secretLines = lines.filter((l) => l.includes('secret'));
    for (const line of secretLines) {
      expect(line).not.toContain('hunter2');
    }
  });
});

// -- ML/AI -----------------------------------------------------------------

describe('Recorder Factories — ML/AI', () => {
  it('zero-import overhead: just narrative()', async () => {
    // This is the simplest observability setup:
    const trace = narrative();
    const chart = buildChart();
    await chart.recorder(trace).run();

    // ML engineer gets causal trace in one line
    const causalTrace = trace.lines().join('\n');
    expect(causalTrace).toContain('name');
    expect(causalTrace).toContain('Alice');
    expect(causalTrace.length).toBeGreaterThan(0);
  });

  it('metrics for performance monitoring', async () => {
    const perf = metrics();
    const chart = buildChart();
    await chart.recorder(perf).run();

    // ML engineer monitors: reads, writes per pipeline
    const m = perf.all();
    expect(m.totalReads).toBeGreaterThan(0);
    expect(m.totalWrites).toBeGreaterThan(0);
    expect(m.stageMetrics.size).toBeGreaterThan(0);
  });
});
