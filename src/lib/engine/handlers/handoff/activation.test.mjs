import { DEFAULT_RUN_POLICY, runPolicy, ExecutionRuntime } from '../../../../advanced.ts';
import { derivePolicy } from '../../../memory/runPolicy.ts';
import { describe, it, expect } from 'vitest';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../index.ts';
import { subflowCapture } from '../../../../subflow-capture.ts';
import { resolveSubflowCapture } from '../../../capture/subflowCapability.ts';
import { detachAndJoinLater } from '../../../detach/spawn.ts';
import { createWorkerThreadDriver } from '../../../detach/drivers/workerThread.ts';
import { createSendBeaconDriver } from '../../../detach/drivers/sendBeacon.ts';
import { StageContext } from '../../../memory/StageContext.ts';
import { SharedMemory, EventLog } from 'foottrace/write';

function chart() {
  return flowChart(
    'Stage',
    (s) => {
      s.answer = 1;
    },
    'stage',
  ).build();
}
function noFunctions(value, token, seen = new Set()) {
  expect(value).not.toBe(token);
  expect(typeof value).not.toBe('function');
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (slot && 'value' in slot) noFunctions(slot.value, token, seen);
  }
}
describe('explicit optional capture activation', () => {
  it('retains native authority through real derived and redacted stage policies', async () => {
    for (const redact of [false, true]) {
      const child = flowChart(
        'Child',
        (s) => {
          s.answer = s.seed;
        },
        'child',
      ).build();
      const built = flowChart(
        'Start',
        (s) => {
          s.x = 7;
        },
        'start',
      )
        .addSubFlowChartNext('mount', child, 'Mount', { inputMapper: (p) => ({ seed: p.x }) })
        .build();
      const factory = built.scopeFactory;
      expect(typeof factory).toBe('function');
      const executor = new FlowChartExecutor(built, {
        ...subflowCapture({ input: true }),
        scopeFactory(context, ...args) {
          context.usePolicy(derivePolicy(context.getPolicy(), { readTracking: 'off' }));
          const rule = context.getPolicy().redaction;
          if (rule) context.useRedactionRule(rule);
          return factory(context, ...args);
        },
      });
      if (redact) executor.setRedactionPolicy({ keys: ['x'] });
      await executor.run();
      const result = executor.getSnapshot().subflowResults.mount;
      expect(result.inputHandoff).toBeDefined();
      expect(result.inputHandoff.writes[0].reads).toEqual(redact ? [] : ['x']);
      if (redact) expect(result.inputHandoff.limitations).toContain('privacy-active');
      expect(result.treeContext.globalContext.answer).toBe(7);
    }
  });
  it('public advanced policy objects cannot confer structural callback authority', () => {
    let effects = 0;
    const fake = {
      input: true,
      fanout: true,
      beginInput() {
        effects++;
      },
      beginFanout() {
        effects++;
      },
      view() {
        effects++;
      },
      reset() {
        effects++;
      },
    };
    const policy = runPolicy({}, undefined, false, fake);
    expect(Object.keys(policy)).toEqual(Object.keys(DEFAULT_RUN_POLICY));
    const runtime = new ExecutionRuntime('Stage', 'stage', undefined, undefined, { ...policy, subflowCapture: fake });
    runtime.getSnapshot();
    runtime.resumeReadSources('next');
    expect(effects).toBe(0);
  });
  it('starts a fresh parent collection view on same-executor resume', async () => {
    const branch = flowChart(
      'Work',
      (s) => {
        s.x = s.item;
      },
      'work',
    ).build();
    const built = flowChart(
      'Start',
      (s) => {
        s.items = [1];
      },
      'start',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s) => s.items,
        branch: () => branch,
        into: 'answers',
        maxBranches: 2,
      })
      .addFunction('Pause', (s) => interrupt(s, { question: 'continue' }), 'pause')
      .build();
    const executor = new FlowChartExecutor(built, subflowCapture({ fanout: true }));
    await executor.run();
    const held = executor.getSnapshot();
    expect(held.fanoutCollections.collections).toHaveLength(1);
    await executor.resume(executor.getCheckpoint(), { answer: 'yes' });
    expect(executor.getSnapshot().fanoutCollections).toBeUndefined();
    expect(held.fanoutCollections.collections).toHaveLength(1);
  });
  it('accepts only own plain boolean config without calling accessors', () => {
    let effects = 0;
    for (const opts of [
      null,
      [],
      () => {},
      new Date(),
      { other: true },
      { input: 1 },
      { input: undefined },
      {
        get input() {
          effects++;
          return true;
        },
      },
      Object.create({ input: true }),
      { [Symbol()]: true },
    ])
      expect(() => subflowCapture(opts)).toThrow('Invalid subflow capture configuration');
    expect(effects).toBe(0);
    for (const opts of [{}, Object.create(null), { input: false, fanout: false }, { input: true }, { fanout: true }])
      expect(Object.isFrozen(subflowCapture(opts))).toBe(true);
  });
  it('binds exact selected flags and refuses cloned, serialized or callback tokens', () => {
    const options = subflowCapture({ input: true });
    for (const candidate of [
      { ...options, subflowCapture: structuredClone(options.subflowCapture) },
      JSON.parse(JSON.stringify(options)),
      { ...options, captureFanoutHandoff: true },
      {
        ...options,
        subflowCapture: {
          beginInput: () => {
            throw new Error('must not run');
          },
        },
      },
    ])
      expect(() => new FlowChartExecutor(chart(), candidate)).toThrow('Invalid subflow capture configuration');
    expect(Object.isFrozen(resolveSubflowCapture(options))).toBe(true);
  });
  it('reuses authority without sharing run collectors and preserves output-only/default controls', async () => {
    const capability = subflowCapture({ fanout: true });
    const branch = flowChart(
      'Work',
      (s) => {
        s.x = s.item;
      },
      'work',
    ).build();
    const built = flowChart(
      'Start',
      (s) => {
        s.items = [1];
      },
      'start',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s) => s.items,
        branch: () => branch,
        into: 'answers',
        maxBranches: 2,
      })
      .build();
    const a = new FlowChartExecutor(built, capability),
      b = new FlowChartExecutor(chart(), capability);
    await a.run();
    const held = a.getSnapshot();
    await b.run();
    expect(held.fanoutCollections.collections).toHaveLength(1);
    expect(b.getSnapshot().fanoutCollections).toBeUndefined();
    await a.run();
    const fresh = a.getSnapshot();
    expect(fresh.fanoutCollections.collections).toHaveLength(1);
    expect(fresh.logAddress.logRunId).not.toBe(held.logAddress.logRunId);
    for (const opts of [
      { captureOutputHandoff: true },
      { ...subflowCapture(), captureOutputHandoff: true },
      { ...subflowCapture({ input: true }), captureOutputHandoff: true },
    ]) {
      const executor = new FlowChartExecutor(chart(), opts);
      await executor.run();
      expect(executor.getSnapshot().sharedState.answer).toBe(1);
      expect(executor.getSnapshot().captureOutputHandoff).toBe(true);
    }
  });
  it('keeps capability/backend out of snapshots, recorders, sink rows and pause checkpoints', async () => {
    const options = subflowCapture({ input: true, fanout: true });
    const rows = [];
    const built = flowChart(
      'Start',
      (s) => {
        s.answer = 1;
      },
      'start',
    )
      .addFunction('Pause', (s) => interrupt(s, { question: 'continue' }), 'pause')
      .build();
    const executor = new FlowChartExecutor(built, {
      ...options,
      sink: {
        opened: (row) => rows.push(row),
        commit: (row) => rows.push(row),
        note: (row) => rows.push(row),
        closed: (row) => rows.push(row),
      },
    });
    executor.attachFlowRecorder({
      id: 'test-observer',
      onStageEnd() {},
      toSnapshot: () => ({ meta: { observation: 'test' } }),
    });
    await executor.run();
    noFunctions(executor.getSnapshot(), options.subflowCapture);
    noFunctions(executor.getSnapshot({ redact: true }), options.subflowCapture);
    noFunctions(executor.getCheckpoint(), options.subflowCapture);
    noFunctions(rows, options.subflowCapture);
    await executor.resume(executor.getCheckpoint(), { answer: 'yes' });
    noFunctions(executor.getSnapshot(), options.subflowCapture);
  });
  it('retains the released frame observer instance keys', () => {
    const frame = new StageContext('run', 'Stage', 'stage', new SharedMemory(), undefined, new EventLog());
    expect(Object.keys(frame)).toContain('_stagedWriteObserver');
    expect(Object.keys(frame)).toContain('_writeBoundaryObserver');
    expect(Object.keys(frame)).not.toContain('subflowCapture');
  });
});

describe('transport configuration refuses before effects while business input remains opaque', () => {
  it('preserves ordinary driver getter timing and order on both builder doors', async () => {
    for (const inherited of [false, true])
      for (const method of ['addDetachAndForget', 'addDetachAndJoinLater']) {
        const events = [];
        const driver = {
          name: 'test',
          schedule() {
            events.push('schedule');
            return { status: 'done' };
          },
        };
        const options = {
          get driver() {
            events.push('driver');
            return driver;
          },
          inputMapper() {
            events.push('mapper');
            return {};
          },
          onHandle() {
            events.push('handle');
          },
        };
        const builder = flowChart('Start', () => {}, 'start');
        builder[method]('detach', chart(), inherited ? Object.create(options) : options);
        expect(events).toEqual([]);
        await new FlowChartExecutor(builder.build()).run();
        expect(events).toEqual(
          method === 'addDetachAndForget'
            ? ['mapper', 'driver', 'schedule']
            : ['mapper', 'driver', 'schedule', 'handle'],
        );
      }
  });
  it('refuses plain-data driver claims before input mapping, without invoking accessors', () => {
    let effects = 0;
    for (const method of ['addDetachAndForget', 'addDetachAndJoinLater']) {
      const options = {
        driver: {
          captureInputHandoff: false,
          schedule() {
            effects++;
          },
        },
        inputMapper() {
          effects++;
        },
        onHandle() {
          effects++;
        },
      };
      expect(() => flowChart('Start', () => {}, 'start')[method]('detach', chart(), options)).toThrow(
        /subflow capture configuration/,
      );
    }
    expect(effects).toBe(0);
  });
  it('checks a getter-supplied driver at its original stage-time read before scheduling', async () => {
    const events = [];
    const options = {
      get driver() {
        events.push('driver');
        return {
          name: 'test',
          captureInputHandoff: true,
          schedule() {
            events.push('schedule');
          },
        };
      },
      inputMapper() {
        events.push('mapper');
        return {};
      },
    };
    const built = flowChart('Start', () => {}, 'start')
      .addDetachAndForget('detach', chart(), options)
      .build();
    expect(events).toEqual([]);
    await expect(new FlowChartExecutor(built).run()).rejects.toThrow(/subflow capture configuration/);
    expect(events).toEqual(['mapper', 'driver']);
  });
  it('rechecks mutable transport configuration before scheduling or serializing', () => {
    let effects = 0;
    const options = {
      url: 'unused',
      serialize() {
        effects++;
        return 'unused';
      },
    };
    const beacon = createSendBeaconDriver(options);
    options.captureInputHandoff = true;
    expect(() => beacon.schedule(chart(), {}, 'test')).toThrow(/subflow capture configuration/);
    const builderOptions = {
      driver: {
        name: 'test',
        schedule() {
          effects++;
          return {};
        },
      },
      inputMapper() {
        effects++;
      },
    };
    const built = flowChart('Start', () => {}, 'start')
      .addDetachAndForget('detach', chart(), builderOptions)
      .build();
    builderOptions.captureFanoutHandoff = true;
    const executor = new FlowChartExecutor(built);
    return executor.run().then(
      () => {
        throw new Error('must refuse');
      },
      (error) => {
        expect(String(error)).toContain('Invalid subflow capture configuration');
        expect(effects).toBe(0);
      },
    );
  });
  it('refuses builder/driver/worker/beacon claims before setup or callback effects', () => {
    let effects = 0;
    const child = chart();
    const worker = {
      on() {
        effects++;
      },
      postMessage() {
        effects++;
      },
    };
    const driver = {
      name: 'test',
      schedule() {
        effects++;
        return {};
      },
    };
    for (const capture of [
      { captureInputHandoff: false },
      { captureFanoutHandoff: true },
      subflowCapture({ input: true }),
    ]) {
      expect(() => createWorkerThreadDriver({ ...capture, worker })).toThrow(/subflow capture configuration/);
      expect(() =>
        createSendBeaconDriver({
          ...capture,
          get url() {
            effects++;
            return 'unused';
          },
          serialize() {
            effects++;
          },
        }),
      ).toThrow(/subflow capture configuration/);
      expect(() => detachAndJoinLater({ ...driver, ...capture }, child, {}, 'test')).toThrow(
        /subflow capture configuration/,
      );
      for (const method of ['addDetachAndForget', 'addDetachAndJoinLater']) {
        const builder = flowChart('Start', () => {}, 'start');
        expect(() =>
          builder[method]('detach', child, {
            ...capture,
            driver,
            inputMapper() {
              effects++;
            },
            onHandle() {
              effects++;
            },
          }),
        ).toThrow(/subflow capture configuration/);
      }
    }
    expect(effects).toBe(0);
  });
  it('passes arbitrary business input through bare detach unchanged', () => {
    const input = { captureInputHandoff: true, subflowCapture: { customer: 'ordinary input' } };
    let handed;
    const handle = { status: 'done' };
    expect(
      detachAndJoinLater(
        {
          name: 'test',
          schedule(_child, data) {
            handed = data;
            return handle;
          },
        },
        chart(),
        input,
        'test',
      ),
    ).toBe(handle);
    expect(handed).toBe(input);
  });
  it('a custom in-process runner can explicitly create its own same-instance factory', async () => {
    const { createMicrotaskBatchDriver } = await import('../../../detach/drivers/microtaskBatch.ts');
    let snapshot;
    const driver = createMicrotaskBatchDriver(async (child) => {
      const executor = new FlowChartExecutor(child, subflowCapture({ input: true }));
      await executor.run();
      snapshot = executor.getSnapshot();
    });
    await detachAndJoinLater(driver, chart(), {}, 'test').wait();
    expect(snapshot.sharedState.answer).toBe(1);
  });
});
