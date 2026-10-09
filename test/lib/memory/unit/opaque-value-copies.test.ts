/**
 * An OPAQUE value (a Blob, a DOMException — content this library cannot read) and the two questions
 * `deepEqual` answers about it (9.44.2, `memory/equality.ts · OpaqueRule`).
 *
 *   unit      `'identity'` (the replacement check): equal only to itself. `'copies'` (both sides are
 *             copies of one record): equal to any other of its kind — copies never share identity
 *   scenario  the writer rule: a container rewritten around an untouched Blob does not WRITE the Blob
 *             (`findLastWriter` names the stage that wrote it, as 9.44 did) — identity would blame
 *             every later rewrite of the container, because each commit re-copies the Blob
 *   scenario  the borrowed-mutation guard: a stage that only READS a Blob is not warned that it
 *             changed it in place (the retained read is a copy)
 *   scenario  the replacement check still sees a new Blob: replacing one commits a row
 */
import { describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../../src';
import { deepEqual } from '../../../../src/lib/memory/equality';
import { findLastWriter } from '../../../../src/trace';

describe("deepEqual's two rules for an opaque value", () => {
  it("'identity' — equal only to itself; 'copies' — equal to another of its kind, never to another kind", () => {
    const blob = new Blob(['a']);
    expect(deepEqual(blob, blob)).toBe(true);
    expect(deepEqual(blob, structuredClone(blob))).toBe(false);
    expect(deepEqual(blob, structuredClone(blob), 'copies')).toBe(true);
    expect(deepEqual({ b: blob }, { b: structuredClone(blob) }, 'copies')).toBe(true);
    expect(deepEqual(blob, new DOMException('m'), 'copies')).toBe(false);
    expect(deepEqual(blob, {}, 'copies')).toBe(false);
  });
});

describe('the readers that compare copies of one record', () => {
  it('the writer rule: rewriting the container around an untouched Blob does not write the Blob', async () => {
    const chart = flowChart(
      'Seed',
      (scope: any) => {
        scope.$setValue('cfg', { file: new Blob(['x']), n: 1 });
      },
      'seed',
    )
      .addFunction(
        'Bump',
        (scope: any) => {
          const cfg = scope.$getValue('cfg');
          scope.$setValue('cfg', { ...cfg, n: 2 }); // the same Blob, a new container
        },
        'bump',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const { commitLog } = executor.getSnapshot();
    expect(findLastWriter(commitLog, 'cfg\u001ffile')?.stageId).toBe('seed');
    expect(findLastWriter(commitLog, 'cfg\u001fn')?.stageId).toBe('bump');
  });

  it('the borrowed-mutation guard: a stage that only reads a Blob is not warned it changed it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableDevMode();
    try {
      const chart = flowChart(
        'Seed',
        (scope: any) => {
          scope.$setValue('doc', { file: new Blob(['x']) });
        },
        'seed',
      )
        .addFunction(
          'Read',
          (scope: any) => {
            scope.seen = scope.$getValue('doc') !== undefined;
          },
          'read',
        )
        .build();
      await new FlowChartExecutor(chart).run();
      expect(warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('IN PLACE'))).toEqual([]);
    } finally {
      disableDevMode();
      warn.mockRestore();
    }
  });

  it('the replacement check still sees a new Blob: replacing one commits a row', async () => {
    const chart = flowChart(
      'Seed',
      (scope: any) => {
        scope.$setValue('file', new Blob(['x']));
      },
      'seed',
    )
      .addFunction(
        'Replace',
        (scope: any) => {
          scope.$setValue('file', new Blob(['x']));
        },
        'replace',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().commitLog[1].trace.map((row) => row.path)).toEqual(['file']);
  });
});
