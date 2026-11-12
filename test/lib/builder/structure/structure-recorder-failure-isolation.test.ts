import { afterEach, describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/index.js';
import type { StructureRecorder } from '../../../../src/lib/builder/structure/StructureRecorder.js';
import { StructureRecorderDispatcher } from '../../../../src/lib/builder/structure/StructureRecorderDispatcher.js';
import { disableDevMode, enableDevMode } from '../../../../src/lib/devMode.js';

afterEach(() => disableDevMode());

describe('structure recorder failure isolation', () => {
  it('isolates every structure event so one throwing recorder does not silence its sibling', () => {
    disableDevMode();
    const dispatcher = new StructureRecorderDispatcher();
    const fail = () => {
      throw new Error('recorder unavailable');
    };
    const received: string[] = [];
    const recorder: StructureRecorder = {
      id: 'unavailable',
      onStageAdded: fail,
      onStageTagged: fail,
      onEdgeAdded: fail,
      onLoopEdgeAdded: fail,
      onDeciderComplete: fail,
      onSubflowMounted: fail,
    };
    dispatcher.attach(recorder);
    dispatcher.attach({
      id: 'healthy',
      onStageAdded: () => received.push('onStageAdded'),
      onStageTagged: () => received.push('onStageTagged'),
      onEdgeAdded: () => received.push('onEdgeAdded'),
      onLoopEdgeAdded: () => received.push('onLoopEdgeAdded'),
      onDeciderComplete: () => received.push('onDeciderComplete'),
      onSubflowMounted: () => received.push('onSubflowMounted'),
    });
    dispatcher.fireStageAdded({
      stageId: 'stage',
      name: 'Stage',
      type: 'stage',
      spec: { id: 'stage', name: 'Stage', type: 'stage' },
    });
    dispatcher.fireStageTagged({
      stageId: 'stage',
      name: 'Stage',
      tags: ['checkout'],
      spec: { id: 'stage', name: 'Stage', type: 'stage' },
    });
    dispatcher.fireEdgeAdded({ from: 'stage', to: 'next', kind: 'next' });
    dispatcher.fireLoopEdgeAdded({ from: 'next', to: 'stage' });
    dispatcher.fireDeciderComplete({ decider: 'route', type: 'decider', branchIds: ['yes'] });
    dispatcher.fireSubflowMounted({
      subflowId: 'mounted',
      subflowName: 'Mounted',
      subflowPath: 'mounted',
      rootStageId: 'inner',
    });
    expect(received).toEqual([
      'onStageAdded',
      'onStageTagged',
      'onEdgeAdded',
      'onLoopEdgeAdded',
      'onDeciderComplete',
      'onSubflowMounted',
    ]);
    expect(dispatcher.getErrors()).toEqual(
      received.map((method) => ({
        recorderId: 'unavailable',
        method,
        message: 'recorder unavailable',
        error: expect.any(Error),
      })),
    );
  });

  it('caps repeated observer failures with one omission marker and continues delivery', () => {
    disableDevMode();
    const dispatcher = new StructureRecorderDispatcher();
    let delivered = 0;
    dispatcher.attach({
      id: 'broken',
      onEdgeAdded: () => {
        throw new Error('unavailable');
      },
    });
    dispatcher.attach({
      id: 'healthy',
      onEdgeAdded: () => {
        delivered++;
      },
    });
    for (let index = 0; index < 120; index++) dispatcher.fireEdgeAdded({ from: 'a', to: 'b', kind: 'next' });
    const errors = dispatcher.getErrors();
    expect(delivered).toBe(120);
    expect(errors).toHaveLength(101);
    expect(
      errors.slice(0, 100).every((error) => error.recorderId === 'broken' && error.message === 'unavailable'),
    ).toBe(true);
    expect(errors[100]).toMatchObject({ recorderId: '__truncated__', method: '__truncated__', error: null });
    expect(errors[100].message).toContain('further errors suppressed');
  });

  it('a hook throwing a value that cannot be stringified still never breaks the build', () => {
    const hostile = [
      Object.create(null),
      Object.defineProperty({}, 'message', {
        get() {
          throw new Error('message getter');
        },
      }),
      {
        toString() {
          throw new Error('toString');
        },
      },
    ];
    for (const thrown of hostile) {
      enableDevMode();
      const builder = flowChart('Seed', () => {}, 'seed', {
        structureRecorders: [
          {
            id: 'bad',
            onEdgeAdded: () => {
              throw thrown;
            },
          },
        ],
      }).addFunction('A', () => {}, 'a');
      expect(() => builder.build()).not.toThrow();
      const [error] = builder.getStructureBuildErrors();
      expect(error).toMatchObject({ recorderId: 'bad', method: 'onEdgeAdded', error: thrown });
      expect(typeof error.message).toBe('string');
    }
  });

  it('keeps an Error’s own message as the recorded text', () => {
    const builder = flowChart('Seed', () => {}, 'seed', {
      structureRecorders: [
        {
          id: 'bad',
          onEdgeAdded: () => {
            throw new Error('boom');
          },
        },
      ],
    }).addFunction('A', () => {}, 'a');
    builder.build();
    expect(builder.getStructureBuildErrors()[0]?.message).toBe('boom');
  });
});
