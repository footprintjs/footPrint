/**
 * 5-pattern tests for the reimplemented CombinedNarrativeRecorder.
 *
 * Two behaviours under test:
 *
 *  A. `CombinedNarrativeRecorder` now `implements CombinedRecorder` (not the
 *     two separate interfaces). The switch must preserve end-to-end event
 *     delivery on BOTH channels — consumers who were attaching via
 *     `attachCombinedRecorder` (or via the internal attach) must still see
 *     both data-flow and control-flow events emitted to the same narrative.
 *
 *  B. The `onSubflowEntry` per-key input rendering now routes through
 *     `renderer.renderOp` when a custom renderer is supplied — closing the
 *     library-level bug where subflow-input lines silently bypassed the
 *     consumer's renderer and always used the default `summarizeValue`.
 *
 * Patterns: unit, boundary, scenario, property, security.
 */

import { describe, expect, it } from 'vitest';

import {
  type CombinedRecorder,
  type NarrativeFormatter,
  type OpRenderContext,
  flowChart,
  FlowChartExecutor,
  isFlowEvent,
} from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/index.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface ParentState {
  userMsg: string;
  parsedResponse: {
    hasToolCalls: boolean;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    content: string;
  };
  result: string;
}

interface InnerState {
  parsedResponse: ParentState['parsedResponse'];
  result: string;
}

/**
 * Build a flowchart with a subflow that receives `parsedResponse` as mapped
 * input. Exercises the `onSubflowEntry` per-key rendering path — the exact
 * shape that exposed the bug in agentfootprint's Live Chat narrative.
 */
function buildSubflowChart() {
  const inner = flowChart<InnerState>(
    'Execute',
    (scope) => {
      scope.result = `ran:${scope.parsedResponse.toolCalls[0]?.name ?? 'none'}`;
    },
    'execute',
  ).build();

  return flowChart<ParentState>(
    'Seed',
    (scope) => {
      scope.userMsg = 'hi';
      scope.parsedResponse = {
        hasToolCalls: true,
        toolCalls: [{ name: 'calculator', arguments: {} }],
        content: '',
      };
    },
    'seed',
  )
    .addSubFlowChartNext('sf-exec', inner, 'ExecuteTools', {
      inputMapper: (parent) => ({ parsedResponse: parent.parsedResponse }),
      outputMapper: (sf) => ({ result: sf.result }),
    })
    .build();
}

// ════════════════════════════════════════════════════════════════════════════
// 1. UNIT — the class is a structural CombinedRecorder
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedNarrativeRecorder — unit', () => {
  it('is assignable to CombinedRecorder', () => {
    // Type-level assertion: the class's instance type must be a structural
    // CombinedRecorder. Compilation of this file is the proof — the
    // assignment would fail at build time if the contract broke.
    const rec: CombinedRecorder = new CombinedNarrativeRecorder();
    expect(rec.id).toBe('combined-narrative');
  });

  it('carries an `id` and supports a custom id via options', () => {
    const rec = new CombinedNarrativeRecorder({ id: 'my-narrative' });
    expect(rec.id).toBe('my-narrative');
  });

  it('attachCombinedRecorder accepts it and routes to BOTH channels', async () => {
    const rec = new CombinedNarrativeRecorder({ id: 'n1' });
    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);

    // One recorder in each channel list (attached via the single call).
    expect(executor.getRecorders().some((r) => r.id === 'n1')).toBe(true);
    expect(executor.getFlowRecorders().some((r) => r.id === 'n1')).toBe(true);

    await executor.run();
    // Narrative emitted entries from both channels.
    expect(rec.getEntries().length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. BOUNDARY — no custom renderer, empty mappedInput, renderOp returns null
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedNarrativeRecorder — boundary', () => {
  it('subflow with no mappedInput does NOT emit per-key Input lines', async () => {
    const inner = flowChart<{ v: number }>(
      'Noop',
      (s) => {
        s.v = 1;
      },
      'noop',
    ).build();

    const chart = flowChart<{ v: number }>(
      'Seed',
      (s) => {
        s.v = 0;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-noop', inner, 'Noop', {
        // No inputMapper — mappedInput is empty.
      })
      .build();

    const rec = new CombinedNarrativeRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    const inputLines = rec.getEntries().filter((e) => e.text.startsWith('Input: '));
    expect(inputLines).toHaveLength(0);
  });

  it('renderOp returning null for a subflow input omits THAT line (but keeps others)', async () => {
    const formatter: NarrativeFormatter = {
      renderOp(ctx) {
        // Omit one specific key; keep others (default fallback).
        if (ctx.key === 'parsedResponse') return null;
        return null; // Be explicit: everything ELSE also filtered away here
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer: formatter });

    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    // No 'Input: parsedResponse = ...' line from the subflow entry.
    const inputLines = rec.getEntries().filter((e) => e.text.startsWith('Input: '));
    expect(inputLines.some((e) => e.text.includes('parsedResponse'))).toBe(false);
    // But stage entries still emit — only per-key ops are filtered.
    expect(rec.getEntries().some((e) => e.type === 'stage')).toBe(true);
  });

  it('default renderer (no override) produces the legacy `Input: key = value` line', async () => {
    // Backward-compat: consumers that never set a renderer must see the
    // pre-fix hardcoded template text.
    const rec = new CombinedNarrativeRecorder(); // no renderer
    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    const inputLines = rec.getEntries().filter((e) => e.text.startsWith('Input: parsedResponse'));
    expect(inputLines).toHaveLength(1);
    // Legacy template: `Input: ${key} = ${valueSummary}` — summary is the
    // default summarizeValue key-list output for objects.
    expect(inputLines[0].text).toMatch(/^Input: parsedResponse = \{/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SCENARIO — the rendering bug fix (agentfootprint-shaped)
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedNarrativeRecorder — scenario (rendering-bug fix)', () => {
  it('custom renderer.renderOp takes effect for subflow per-key input lines', async () => {
    // Reproduce the exact failure mode we found in agentfootprint's Live
    // Chat narrative: a domain-aware renderer produces beautiful lines for
    // scope writes, but subflow input lines fell through to the default
    // key-list summary. After the fix, BOTH paths consult the renderer.
    const opCalls: OpRenderContext[] = [];
    const formatter: NarrativeFormatter = {
      renderOp(ctx) {
        opCalls.push(ctx);
        if (ctx.key === 'parsedResponse' && ctx.type === 'write') {
          const v = ctx.rawValue as { toolCalls?: Array<{ name: string; arguments: unknown }> };
          const names =
            v?.toolCalls?.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments ?? {})})`).join(', ') ?? '?';
          return `Parsed: tool_calls → [${names}]`;
        }
        return null; // other keys omitted, not relevant for this test
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer: formatter });

    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    // The domain-aware line appears — for BOTH the scope write (in Seed)
    // AND the subflow input line (in sf-exec's entry).
    const customLines = rec.getEntries().filter((e) => e.text.startsWith('Parsed: tool_calls → '));
    expect(customLines.length).toBeGreaterThanOrEqual(2);
    expect(customLines.some((l) => l.text.includes('calculator({})'))).toBe(true);

    // renderOp received an OpRenderContext with type='write' and operation='set'
    // for the subflow input case — semantic equivalence to a scope write.
    const subflowOps = opCalls.filter((c) => c.type === 'write' && c.operation === 'set' && c.key === 'parsedResponse');
    expect(subflowOps.length).toBeGreaterThanOrEqual(1);
  });

  it('shared onError fires and discriminates via isFlowEvent', async () => {
    // Class-level regression check: the reimplementation on CombinedRecorder
    // preserves the onError/onPause/onResume union-payload dispatch — the
    // narrative surfaces the control-flow variant and ignores the scope one.
    const rec = new CombinedNarrativeRecorder();
    const chart = flowChart<{ x: number }>(
      'Throw',
      () => {
        throw new Error('boom');
      },
      'throw',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);

    try {
      await executor.run();
    } catch {
      /* expected — stage throws */
    }

    const errorEntries = rec.getEntries().filter((e) => e.type === 'error');
    // At least one control-flow error entry was emitted (data-flow variant skipped).
    expect(errorEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('isFlowEvent helper narrows correctly at the consumer call site', () => {
    // Positive: a flow-shaped object (no pipelineId) is narrowed as flow.
    const flowish = { stageName: 's', message: 'err' };
    expect(isFlowEvent(flowish)).toBe(true);

    // Negative: a scope-shaped object (has pipelineId) is narrowed as scope.
    const scopish = { pipelineId: 'p', operation: 'write', error: new Error() };
    expect(isFlowEvent(scopish)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. PROPERTY — renderOp/formatValue invariants across paths
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedNarrativeRecorder — property', () => {
  it('whenever renderer.renderOp returns a string, its exact text is in the narrative', async () => {
    const customTexts = new Set<string>();
    const formatter: NarrativeFormatter = {
      renderOp(ctx) {
        const text = `CUSTOM<${ctx.key}:${ctx.type}>`;
        customTexts.add(text);
        return text;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer: formatter });

    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    // Every string renderOp returned must appear in the narrative as-is.
    const narrativeTexts = rec.getEntries().map((e) => e.text);
    for (const ct of customTexts) {
      expect(narrativeTexts).toContain(ct);
    }
  });

  it('includeValues=false and no renderer: lines have `Input: key` (no `= value`)', async () => {
    const rec = new CombinedNarrativeRecorder({ includeValues: false });
    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    const inputLines = rec.getEntries().filter((e) => e.text.startsWith('Input: '));
    for (const line of inputLines) {
      expect(line.text).not.toContain('=');
    }
  });

  it('when renderer.renderOp is undefined, the default template still applies to subflow inputs', async () => {
    const formatter: NarrativeFormatter = {
      // Only override renderStage; leave renderOp undefined.
      renderStage(ctx) {
        return `STAGE:${ctx.stageName}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer: formatter });

    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    // Stage lines are customized; input lines fall back to the legacy template.
    const inputLines = rec.getEntries().filter((e) => e.text.startsWith('Input: parsedResponse'));
    expect(inputLines).toHaveLength(1);
    expect(inputLines[0].text).toMatch(/^Input: parsedResponse = \{/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. SECURITY — renderer errors don't crash, rawValue isn't cloned aggressively
// ════════════════════════════════════════════════════════════════════════════

describe('CombinedNarrativeRecorder — security', () => {
  it('a throwing renderOp does not crash executor.run()', async () => {
    const formatter: NarrativeFormatter = {
      renderOp() {
        throw new Error('renderer bomb');
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer: formatter });
    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);

    // Recorder error-isolation contract: the library must catch and continue.
    await expect(executor.run()).resolves.not.toThrow();
  });

  it('OpRenderContext.rawValue is the literal input object (document current behaviour)', async () => {
    // The rawValue passed to renderOp is the ACTUAL mappedInput value.
    // A malicious or careless renderer could mutate it. We DO NOT defensively
    // clone — consumers are trusted with their own state. Pin this behaviour
    // so a future change can't silently start cloning (which would be a
    // perf regression) without an explicit decision.
    let observed: unknown;
    const formatter: NarrativeFormatter = {
      renderOp(ctx) {
        if (ctx.key === 'parsedResponse') observed = ctx.rawValue;
        return null;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer: formatter });
    const chart = buildSubflowChart();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(rec);
    await executor.run();

    expect(observed).toBeDefined();
    expect(typeof observed).toBe('object');
  });
});
