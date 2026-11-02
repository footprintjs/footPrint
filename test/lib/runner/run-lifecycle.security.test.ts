import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { BoundRun, PausableHandler, RunLifecycle, RunSlot, TypedScope } from '../../../src';
import { createRunLifecycle, flowChart } from '../../../src';

describe('run lifecycle private data boundary', () => {
  it('omits private credentials/programs from every native retention door', async () => {
    const secret = 'PRIVATE-LIFECYCLE-CREDENTIAL-1428';
    const privateValue = {
      secret,
      program: () => secret,
      toJSON() {
        throw new Error('private value was serialized');
      },
    };
    const sink = memorySink();
    const events: unknown[] = [];
    let captured!: BoundRun;
    const handler: PausableHandler<TypedScope<{ visible?: string }>> = {
      execute: async (scope) => {
        captured = owner.forScope(scope);
        expect(captured.read(slot)).toEqual({ present: true, value: privateValue });
        scope.visible = 'public';
        scope.$emit('visible', { value: 'public' });
        return { question: 'continue?' };
      },
      resume: async (scope) => {
        scope.visible = 'continued';
      },
    };
    const chart = flowChart('pause', handler, 'pause').build();
    const owner: RunLifecycle = createRunLifecycle(chart, { runnerId: 'private', executorOptions: { sink } });
    const slot: RunSlot<typeof privateValue> = owner.slot('runtime');
    await owner.withRun((run) => {
      run.set(slot, privateValue);
      return run.execute(
        { kind: 'run' },
        {
          attachments: [
            {
              recorder: {
                id: 'all-events',
                onEmit: (event) => {
                  events.push(event);
                },
                onWrite: (event) => {
                  events.push(event);
                },
                onStageExecuted: (event) => {
                  events.push(event);
                },
              },
            },
          ],
          narrative: {},
        },
      );
    });
    const view = owner.view()!;
    const checkpoint = owner.continuation()!.checkpoint();
    for (const value of [view.snapshot(), view.getNarrativeEntries(), sink.entries, events, checkpoint]) {
      expect(JSON.stringify(value)).not.toContain(secret);
    }
    expect(captured.retired).toBe(true);
    expect(captured.read(slot)).toEqual({ present: true, value: privateValue });
    expect(() => captured.take(slot)).toThrow('retired');
  });

  it('refuses fabricated/cross-owner keys and never probes an unregistered strict proxy', async () => {
    const chart = flowChart('work', async () => undefined, 'work').build();
    const one = createRunLifecycle(chart, { runnerId: 'one' });
    const two = createRunLifecycle(chart, { runnerId: 'two' });
    const foreign = two.slot<number>('leg');
    let probes = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          probes += 1;
          throw new Error('must not probe');
        },
      },
    );
    expect(() => one.forScope(proxy)).toThrow('no registered native');
    expect(probes).toBe(0);
    await one.withRun((run) => {
      for (const key of [foreign, {} as typeof foreign]) {
        expect(() => run.read(key)).toThrow('another lifecycle or is fabricated');
        expect(() => run.set(key, 1)).toThrow('another lifecycle or is fabricated');
        expect(() => run.take(key)).toThrow('another lifecycle or is fabricated');
      }
    });
  });
});
