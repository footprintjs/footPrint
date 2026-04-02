/**
 * Tests for pluggable NarrativeRenderer — verifies that CombinedNarrativeRecorder
 * delegates to custom renderers and falls back to defaults correctly.
 *
 * Coverage: unit, boundary, scenario, property, security.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CombinedNarrativeRecorder } from '../../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';
import type {
  BreakRenderContext,
  DecisionRenderContext,
  ErrorRenderContext,
  ForkRenderContext,
  LoopRenderContext,
  NarrativeRenderer,
  OpRenderContext,
  SelectedRenderContext,
  StageRenderContext,
  SubflowRenderContext,
} from '../../../../../src/lib/engine/narrative/narrativeTypes.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fireStage(rec: CombinedNarrativeRecorder, stageName: string, description?: string): void {
  rec.onStageExecuted({
    stageName,
    description,
    traversalContext: { stageId: `id-${stageName}`, subflowId: undefined } as any,
  } as any);
}

function fireReadWrite(rec: CombinedNarrativeRecorder, stageName: string): void {
  rec.onRead({ stageName, key: 'foo', value: 42 } as any);
  rec.onWrite({ stageName, key: 'bar', value: 'hello', operation: 'set' } as any);
}

function fireDecision(
  rec: CombinedNarrativeRecorder,
  decider: string,
  chosen: string,
  opts?: { description?: string; rationale?: string },
): void {
  rec.onDecision({
    decider,
    chosen,
    description: opts?.description,
    rationale: opts?.rationale,
    traversalContext: { stageId: `id-${decider}`, subflowId: undefined } as any,
  } as any);
}

// ── Unit: default renderer produces identical output to pre-refactor ─────────

describe('pluggable renderer — unit', () => {
  it('default renderer (no custom) produces expected stage text', () => {
    const rec = new CombinedNarrativeRecorder();
    fireStage(rec, 'Init', 'Initialize data');
    fireStage(rec, 'Process');

    const entries = rec.getEntries();
    expect(entries[0].text).toBe('Stage 1: The process began: Initialize data.');
    expect(entries[1].text).toBe('Stage 2: Next, it moved on to Process.');
  });

  it('custom renderStage overrides stage text', () => {
    const renderer: NarrativeRenderer = {
      renderStage(ctx: StageRenderContext) {
        return `[${ctx.stageNumber}] ${ctx.stageName}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    fireStage(rec, 'Init', 'Initialize data');
    fireStage(rec, 'Process');

    const entries = rec.getEntries();
    expect(entries[0].text).toBe('[1] Init');
    expect(entries[1].text).toBe('[2] Process');
  });

  it('custom renderOp overrides step text', () => {
    const renderer: NarrativeRenderer = {
      renderOp(ctx: OpRenderContext) {
        return `${ctx.type.toUpperCase()}: ${ctx.key}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    fireReadWrite(rec, 'Stage1');
    fireStage(rec, 'Stage1');

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps[0].text).toBe('READ: foo');
    expect(steps[1].text).toBe('WRITE: bar');
  });

  it('custom renderDecision overrides condition text', () => {
    const renderer: NarrativeRenderer = {
      renderDecision(ctx: DecisionRenderContext) {
        return `DECIDED: ${ctx.chosen}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    fireDecision(rec, 'Router', 'pathA', { rationale: 'score > 80' });

    const conditions = rec.getEntries().filter((e) => e.type === 'condition');
    expect(conditions[0].text).toBe('DECIDED: pathA');
  });

  it('custom renderFork overrides fork text', () => {
    const renderer: NarrativeRenderer = {
      renderFork(ctx: ForkRenderContext) {
        return `FORK: ${ctx.children.length} paths`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onFork({ children: ['A', 'B', 'C'], traversalContext: {} } as any);

    const forks = rec.getEntries().filter((e) => e.type === 'fork');
    expect(forks[0].text).toBe('FORK: 3 paths');
  });

  it('custom renderSubflow overrides subflow text', () => {
    const renderer: NarrativeRenderer = {
      renderSubflow(ctx: SubflowRenderContext) {
        return `${ctx.direction === 'entry' ? '>>' : '<<'} ${ctx.name}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onSubflowEntry({ name: 'payment', subflowId: 'sf-1', traversalContext: {} } as any);
    rec.onSubflowExit({ name: 'payment', subflowId: 'sf-1', traversalContext: {} } as any);

    const entries = rec.getEntries().filter((e) => e.type === 'subflow');
    expect(entries[0].text).toBe('>> payment');
    expect(entries[1].text).toBe('<< payment');
  });

  it('custom renderLoop overrides loop text', () => {
    const renderer: NarrativeRenderer = {
      renderLoop(ctx: LoopRenderContext) {
        return `LOOP #${ctx.iteration} → ${ctx.target}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onLoop({ target: 'Retry', iteration: 3, traversalContext: {} } as any);

    const loops = rec.getEntries().filter((e) => e.type === 'loop');
    expect(loops[0].text).toBe('LOOP #3 → Retry');
  });

  it('custom renderBreak overrides break text', () => {
    const renderer: NarrativeRenderer = {
      renderBreak(ctx: BreakRenderContext) {
        return `HALT @ ${ctx.stageName}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onBreak({ stageName: 'Final', traversalContext: {} } as any);

    const breaks = rec.getEntries().filter((e) => e.type === 'break');
    expect(breaks[0].text).toBe('HALT @ Final');
  });

  it('custom renderError overrides error text', () => {
    const renderer: NarrativeRenderer = {
      renderError(ctx: ErrorRenderContext) {
        return `ERR[${ctx.stageName}]: ${ctx.message}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onError({ stageName: 'Validate', message: 'bad input', traversalContext: {} } as any);

    const errors = rec.getEntries().filter((e) => e.type === 'error');
    expect(errors[0].text).toBe('ERR[Validate]: bad input');
  });

  it('custom renderSelected overrides selected text', () => {
    const renderer: NarrativeRenderer = {
      renderSelected(ctx: SelectedRenderContext) {
        return `SELECTED ${ctx.selected.length}/${ctx.total}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onSelected({ selected: ['A', 'B'], total: 3, traversalContext: {} } as any);

    const selectors = rec.getEntries().filter((e) => e.type === 'selector');
    expect(selectors[0].text).toBe('SELECTED 2/3');
  });
});

// ── Boundary: renderOp returning null excludes entry ─────────────────────────

describe('pluggable renderer — boundary', () => {
  it('renderOp returning null excludes the entry', () => {
    const renderer: NarrativeRenderer = {
      renderOp(ctx: OpRenderContext) {
        if (ctx.key.startsWith('_internal')) return null;
        return `${ctx.key}: ${ctx.valueSummary}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onRead({ stageName: 'S1', key: '_internal_cache', value: {} } as any);
    rec.onRead({ stageName: 'S1', key: 'name', value: 'Alice' } as any);
    rec.onWrite({ stageName: 'S1', key: '_internal_flag', value: true, operation: 'set' } as any);
    rec.onWrite({ stageName: 'S1', key: 'score', value: 95, operation: 'set' } as any);
    fireStage(rec, 'S1');

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);
    expect(steps[0].text).toBe('name: "Alice"');
    expect(steps[1].text).toBe('score: 95');
  });

  it('renderOp returning null for all ops → zero step entries', () => {
    const renderer: NarrativeRenderer = {
      renderOp() {
        return null;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onRead({ stageName: 'S1', key: 'a', value: 1 } as any);
    rec.onWrite({ stageName: 'S1', key: 'b', value: 2, operation: 'set' } as any);
    fireStage(rec, 'S1');

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(0);
    // Stage entry should still exist
    const stages = rec.getEntries().filter((e) => e.type === 'stage');
    expect(stages).toHaveLength(1);
  });

  it('partial renderer — only renderStage provided, everything else defaults', () => {
    const renderer: NarrativeRenderer = {
      renderStage(ctx: StageRenderContext) {
        return `#${ctx.stageNumber} ${ctx.stageName}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onRead({ stageName: 'S1', key: 'x', value: 10 } as any);
    fireStage(rec, 'S1');
    fireDecision(rec, 'Decide', 'yes');

    const entries = rec.getEntries();
    // Custom stage
    expect(entries[0].text).toBe('#1 S1');
    // Default op
    expect(entries[1].text).toContain('Read x');
    // Custom stage for decider (renderStage is shared for stages+deciders)
    expect(entries[2].text).toBe('#2 Decide');
    // Default decision
    expect(entries[3].text).toContain('[Condition]:');
  });

  it('renderer with empty object — all defaults', () => {
    const rec = new CombinedNarrativeRecorder({ renderer: {} });
    fireStage(rec, 'Init');
    const entries = rec.getEntries();
    expect(entries[0].text).toBe('Stage 1: The process began with Init.');
  });

  it('formatValue + renderer interaction: renderOp receives custom-formatted valueSummary', () => {
    const captured: OpRenderContext[] = [];
    const rec = new CombinedNarrativeRecorder({
      formatValue: (value) => `<<${String(value)}>>`,
      renderer: {
        renderOp(ctx: OpRenderContext) {
          captured.push({ ...ctx });
          return `${ctx.key} → ${ctx.valueSummary}`;
        },
      },
    });
    rec.onWrite({ stageName: 'S1', key: 'score', value: 42, operation: 'set' } as any);
    fireStage(rec, 'S1');

    expect(captured).toHaveLength(1);
    // valueSummary should use the custom formatValue, not the default summarizeValue
    expect(captured[0].valueSummary).toBe('<<42>>');
    expect(captured[0].rawValue).toBe(42);
    // The rendered text uses the custom valueSummary
    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps[0].text).toBe('score → <<42>>');
  });
});

// ── Scenario: renderer that filters memory_* keys produces clean narrative ──

describe('pluggable renderer — scenario', () => {
  it('renderer filters memory_* keys from narrative', () => {
    const renderer: NarrativeRenderer = {
      renderOp(ctx: OpRenderContext) {
        if (ctx.key.startsWith('memory_')) return null;
        return `${ctx.type === 'read' ? 'Read' : 'Wrote'} ${ctx.key}: ${ctx.valueSummary}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });

    // Simulate reads/writes including memory_* keys
    rec.onRead({ stageName: 'Apply', key: 'memory_preparedMessages', value: ['msg1'] } as any);
    rec.onRead({ stageName: 'Apply', key: 'userQuery', value: 'hello' } as any);
    rec.onWrite({ stageName: 'Apply', key: 'memory_lastAccess', value: Date.now(), operation: 'set' } as any);
    rec.onWrite({ stageName: 'Apply', key: 'response', value: 'world', operation: 'set' } as any);
    fireStage(rec, 'Apply');

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);
    expect(steps[0].text).toBe('Read userQuery: "hello"');
    expect(steps[1].text).toBe('Wrote response: "world"');
  });

  it('full custom renderer replaces all text', () => {
    const renderer: NarrativeRenderer = {
      renderStage: (ctx) => `STAGE:${ctx.stageName}`,
      renderOp: (ctx) => `OP:${ctx.type}:${ctx.key}`,
      renderDecision: (ctx) => `DECISION:${ctx.chosen}`,
      renderFork: (ctx) => `FORK:${ctx.children.length}`,
      renderSelected: (ctx) => `SELECTED:${ctx.selected.length}`,
      renderSubflow: (ctx) => `SUBFLOW:${ctx.direction}:${ctx.name}`,
      renderLoop: (ctx) => `LOOP:${ctx.iteration}`,
      renderBreak: (ctx) => `BREAK:${ctx.stageName}`,
      renderError: (ctx) => `ERROR:${ctx.message}`,
    };
    const rec = new CombinedNarrativeRecorder({ renderer });

    // Fire all event types
    rec.onRead({ stageName: 'S1', key: 'x', value: 1 } as any);
    fireStage(rec, 'S1');
    fireDecision(rec, 'D1', 'yes');
    rec.onFork({ children: ['A', 'B'], traversalContext: {} } as any);
    rec.onSelected({ selected: ['A'], total: 2, traversalContext: {} } as any);
    rec.onSubflowEntry({ name: 'sub', subflowId: 'sf', traversalContext: {} } as any);
    rec.onSubflowExit({ name: 'sub', subflowId: 'sf', traversalContext: {} } as any);
    rec.onLoop({ target: 'S1', iteration: 2, traversalContext: {} } as any);
    rec.onBreak({ stageName: 'Final', traversalContext: {} } as any);
    rec.onError({ stageName: 'Err', message: 'fail', traversalContext: {} } as any);

    const texts = rec.getEntries().map((e) => e.text);
    expect(texts).toEqual([
      'STAGE:S1',
      'OP:read:x',
      'STAGE:D1',
      'DECISION:yes',
      'FORK:2',
      'SELECTED:1',
      'SUBFLOW:entry:sub',
      'SUBFLOW:exit:sub',
      'LOOP:2',
      'BREAK:Final',
      'ERROR:fail',
    ]);
  });
});

// ── Property: default renderer = pre-refactor output for any event sequence ──

describe('pluggable renderer — property', () => {
  it('default renderer (no custom) produces identical output to default for any stage sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
        async (stageNames) => {
          // With no renderer (pre-refactor path)
          const recDefault = new CombinedNarrativeRecorder();
          // With empty renderer (all fallbacks)
          const recEmpty = new CombinedNarrativeRecorder({ renderer: {} });

          for (const name of stageNames) {
            fireStage(recDefault, name);
            fireStage(recEmpty, name);
          }

          const defaultEntries = recDefault.getEntries();
          const emptyEntries = recEmpty.getEntries();

          expect(defaultEntries.length).toBe(emptyEntries.length);
          for (let i = 0; i < defaultEntries.length; i++) {
            expect(defaultEntries[i].text).toBe(emptyEntries[i].text);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it('custom renderer receives all context fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          stageName: fc.string({ minLength: 1, maxLength: 20 }),
          key: fc.string({ minLength: 1, maxLength: 20 }),
          value: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
        }),
        async ({ stageName, key, value }) => {
          const captured: OpRenderContext[] = [];
          const renderer: NarrativeRenderer = {
            renderOp(ctx: OpRenderContext) {
              captured.push(ctx);
              return `${ctx.key}=${ctx.valueSummary}`;
            },
          };
          const rec = new CombinedNarrativeRecorder({ renderer });
          rec.onRead({ stageName, key, value } as any);
          fireStage(rec, stageName);

          expect(captured).toHaveLength(1);
          expect(captured[0].key).toBe(key);
          expect(captured[0].rawValue).toBe(value);
          expect(captured[0].type).toBe('read');
          expect(captured[0].stepNumber).toBe(1);
          expect(typeof captured[0].valueSummary).toBe('string');
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ── Security: renderer receives redacted values, not originals ──────────────

describe('pluggable renderer — security', () => {
  it('renderOp receives "[REDACTED]" for redacted values (when recorder captures them)', () => {
    const captured: OpRenderContext[] = [];
    const renderer: NarrativeRenderer = {
      renderOp(ctx: OpRenderContext) {
        captured.push({ ...ctx });
        return `${ctx.key}: ${ctx.valueSummary}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });

    // Simulate redacted write — ScopeFacade dispatches event.value as '[REDACTED]'
    rec.onWrite({
      stageName: 'Init',
      key: 'secret',
      value: '[REDACTED]',
      operation: 'set',
    } as any);
    rec.onWrite({
      stageName: 'Init',
      key: 'public',
      value: 'visible',
      operation: 'set',
    } as any);
    fireStage(rec, 'Init');

    expect(captured).toHaveLength(2);
    // Redacted value should be '[REDACTED]', not the original
    expect(captured[0].rawValue).toBe('[REDACTED]');
    expect(captured[0].valueSummary).toBe('"[REDACTED]"');
    // Public value is visible
    expect(captured[1].rawValue).toBe('visible');
  });

  it('renderDecision receives evidence but not raw scope data', () => {
    const captured: DecisionRenderContext[] = [];
    const renderer: NarrativeRenderer = {
      renderDecision(ctx: DecisionRenderContext) {
        captured.push({ ...ctx });
        return `Chose ${ctx.chosen}`;
      },
    };
    const rec = new CombinedNarrativeRecorder({ renderer });
    rec.onDecision({
      decider: 'Router',
      chosen: 'approved',
      rationale: 'high score',
      description: 'checked credit',
      traversalContext: { stageId: 'id-router' },
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].chosen).toBe('approved');
    expect(captured[0].rationale).toBe('high score');
    expect(captured[0].description).toBe('checked credit');
    expect(captured[0].decider).toBe('Router');
  });
});
