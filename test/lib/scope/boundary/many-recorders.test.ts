import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { Recorder } from '../../../../src/lib/scope/types';

function makeCtx() {
  return new StageContext('p1', 's1', 's1', new SharedMemory(), '', new EventLog());
}

describe('Boundary: many recorders', () => {
  it('50 recorders all receive events', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const counts: number[] = [];

    for (let i = 0; i < 50; i++) {
      const idx = i;
      counts[idx] = 0;
      scope.attachRecorder({
        id: `r-${idx}`,
        onWrite: () => {
          counts[idx]++;
        },
      });
    }

    scope.setValue('x', 1);

    for (let i = 0; i < 50; i++) {
      expect(counts[i]).toBe(1);
    }
  });

  it('50 recorders with mixed throwing do not break execution', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    let errorCount = 0;

    for (let i = 0; i < 50; i++) {
      scope.attachRecorder({
        id: `r-${i}`,
        onRead:
          i % 2 === 0
            ? () => {
                throw new Error(`crash-${i}`);
              }
            : undefined,
      });
    }
    scope.attachRecorder({
      id: 'catcher',
      onError: () => {
        errorCount++;
      },
    });

    // Should not throw
    scope.getValue('x');
    expect(errorCount).toBe(25);
  });

  it('detaching all recorders leaves scope functional', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');

    for (let i = 0; i < 20; i++) {
      scope.attachRecorder({ id: `r-${i}` });
    }
    expect(scope.getRecorders()).toHaveLength(20);

    for (let i = 0; i < 20; i++) {
      scope.detachRecorder(`r-${i}`);
    }
    expect(scope.getRecorders()).toHaveLength(0);

    // Still works
    scope.setValue('x', 1);
    expect(scope.getValue('x')).toBeDefined();
  });

  it('100 MetricRecorders track independently', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const recorders: MetricRecorder[] = [];

    for (let i = 0; i < 100; i++) {
      const rec = new MetricRecorder(`m-${i}`);
      recorders.push(rec);
      scope.attachRecorder(rec);
    }

    scope.setValue('a', 1);
    scope.getValue('a');

    for (const rec of recorders) {
      expect(rec.getMetrics().totalWrites).toBe(1);
      expect(rec.getMetrics().totalReads).toBe(1);
    }
  });
});
