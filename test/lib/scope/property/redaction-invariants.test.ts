import * as fc from 'fast-check';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { ReadEvent, Recorder, WriteEvent } from '../../../../src/lib/scope/types';

function makeCtx() {
  return new StageContext('p1', 's1', 's1', new SharedMemory(), '', new EventLog());
}

describe('Property: redaction invariants', () => {
  it('redacted setValue never leaks raw value to any recorder', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && s !== '__proto__' && s !== 'constructor' && s !== 'prototype'),
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        fc.nat({ max: 5 }),
        (key, value, numRecorders) => {
          const scope = new ScopeFacade(makeCtx(), 'test');
          const allWriteEvents: WriteEvent[] = [];

          for (let i = 0; i < numRecorders + 1; i++) {
            scope.attachRecorder({
              id: `r-${i}`,
              onWrite: (e) => allWriteEvents.push(e),
            });
          }

          scope.setValue(key, value, true);

          // Every recorder must see '[REDACTED]', never the raw value
          return allWriteEvents.every((e) => e.value === '[REDACTED]' && e.redacted === true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('redacted key reads never leak raw value to any recorder', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && s !== '__proto__' && s !== 'constructor' && s !== 'prototype'),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (key, value) => {
          const ctx = makeCtx();
          const scope = new ScopeFacade(ctx, 'test');
          const readEvents: ReadEvent[] = [];

          scope.setValue(key, value, true);
          ctx.commit();

          scope.attachRecorder({
            id: 'r',
            onRead: (e) => readEvents.push(e),
          });

          scope.getValue(key);

          return readEvents.length === 1 && readEvents[0].value === '[REDACTED]' && readEvents[0].redacted === true;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('runtime always returns real value regardless of redaction', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && s !== '__proto__' && s !== 'constructor' && s !== 'prototype'),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (key, value) => {
          const ctx = makeCtx();
          const scope = new ScopeFacade(ctx, 'test');
          scope.attachRecorder({ id: 'r' });

          scope.setValue(key, value, true);
          ctx.commit();

          const result = scope.getValue(key);
          return JSON.stringify(result) === JSON.stringify(value);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('non-redacted setValue never sets redacted flag', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && s !== '__proto__' && s !== 'constructor' && s !== 'prototype'),
        fc.oneof(fc.string(), fc.integer()),
        (key, value) => {
          const scope = new ScopeFacade(makeCtx(), 'test');
          const events: WriteEvent[] = [];
          scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

          scope.setValue(key, value);

          return events.length === 1 && events[0].redacted === undefined;
        },
      ),
      { numRuns: 30 },
    );
  });

  it('throwing recorder does not prevent redaction for other recorders', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && s !== '__proto__' && s !== 'constructor' && s !== 'prototype'),
        fc.string(),
        (key, value) => {
          const scope = new ScopeFacade(makeCtx(), 'test');
          const goodEvents: WriteEvent[] = [];

          // Throwing recorder first
          scope.attachRecorder({
            id: 'bad',
            onWrite: () => {
              throw new Error('crash');
            },
          });
          // Good recorder after
          scope.attachRecorder({
            id: 'good',
            onWrite: (e) => goodEvents.push(e),
          });

          scope.setValue(key, value, true);

          return goodEvents.length === 1 && goodEvents[0].value === '[REDACTED]';
        },
      ),
      { numRuns: 30 },
    );
  });

  it('deleteValue followed by non-redacted setValue removes redaction', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && s !== '__proto__' && s !== 'constructor' && s !== 'prototype'),
        fc.string(),
        fc.string(),
        (key, secret, nonSecret) => {
          const ctx = makeCtx();
          const scope = new ScopeFacade(ctx, 'test');
          const readEvents: ReadEvent[] = [];

          scope.setValue(key, secret, true);
          ctx.commit();
          scope.deleteValue(key);
          ctx.commit();
          scope.setValue(key, nonSecret);
          ctx.commit();

          scope.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });
          scope.getValue(key);

          return readEvents.length === 1 && readEvents[0].redacted === undefined;
        },
      ),
      { numRuns: 30 },
    );
  });
});
