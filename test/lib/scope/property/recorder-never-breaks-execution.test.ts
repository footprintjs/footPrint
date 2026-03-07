import * as fc from 'fast-check';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { Recorder } from '../../../../src/lib/scope/types';

function makeCtx() {
  return new StageContext('p1', 's1', new SharedMemory(), '', new EventLog());
}

describe('Property: recorder never breaks execution', () => {
  it('throwing recorders do not break getValue', () => {
    fc.assert(
      fc.property(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean()), (key, value) => {
        const ctx = makeCtx();
        ctx.setObject([], key || 'k', value);
        ctx.commit();

        const scope = new ScopeFacade(ctx, 'test');
        const throwingRecorder: Recorder = {
          id: 'bad',
          onRead: () => {
            throw new Error('recorder crash');
          },
        };
        scope.attachRecorder(throwingRecorder);

        // Should not throw despite recorder error
        const result = scope.getValue(key || 'k');
        return result === value;
      }),
      { numRuns: 30 },
    );
  });

  it('throwing recorders do not break setValue', () => {
    fc.assert(
      fc.property(fc.string(), fc.anything(), (key, value) => {
        const scope = new ScopeFacade(makeCtx(), 'test');
        scope.attachRecorder({
          id: 'bad',
          onWrite: () => {
            throw new Error('recorder crash');
          },
        });

        // Should not throw
        scope.setValue(key || 'k', value);
        return true;
      }),
      { numRuns: 30 },
    );
  });

  it('onError is invoked when other hooks throw', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const scope = new ScopeFacade(makeCtx(), 'test');
        let errorCaught = false;

        scope.attachRecorder({
          id: 'thrower',
          onRead: () => {
            throw new Error('boom');
          },
        });
        scope.attachRecorder({
          id: 'catcher',
          onError: () => {
            errorCaught = true;
          },
        });

        scope.getValue(key || 'k');
        return errorCaught === true;
      }),
      { numRuns: 20 },
    );
  });

  it('multiple throwing recorders are all handled', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10 }), (numRecorders) => {
        const scope = new ScopeFacade(makeCtx(), 'test');
        const errorIds: string[] = [];

        for (let i = 0; i < numRecorders; i++) {
          scope.attachRecorder({
            id: `thrower-${i}`,
            onWrite: () => {
              throw new Error(`crash-${i}`);
            },
          });
        }
        scope.attachRecorder({
          id: 'catcher',
          onError: (e: any) => errorIds.push(e.error.message),
        });

        scope.setValue('x', 1);
        return errorIds.length === numRecorders;
      }),
      { numRuns: 20 },
    );
  });
});
