/**
 * The deprecated per-dial members (9.35.0, F5) — forwarders over the run policy — keep their
 * old observable behaviour. Each case runs the OLD call on the published package
 * (`footprintjs-baseline`, the differential tests' control) and on this build, and the two
 * observations must be equal: the getter, inheritance by createNext/createChild, the effect on
 * the record, and (runtime setters) the snapshot discriminant.
 *
 * Test types: Regression (old call → same result) · Differential (published package as control).
 */
import * as baseline from 'footprintjs-baseline/advanced';
import { describe, expect, it } from 'vitest';

import * as current from '../../../src/advanced';

type Lib = Pick<typeof current, 'StageContext' | 'ExecutionRuntime' | 'SharedMemory' | 'EventLog' | 'RedactionRule'>;
const LIBS: Array<[string, Lib]> = [
  ['published', baseline as unknown as Lib],
  ['build', current],
];

const SEED = { list: [1], n: 1, secret: 'seeded' };

/** One stage on `ctx`: read n, grow list, write secret; commit. What the dials can change. */
function stage(ctx: any) {
  ctx.getValue([], 'n');
  ctx.setObject([], 'list', [1, 2]);
  ctx.setObject([], 'secret', 'pw');
  const snap = ctx.getSnapshot();
  ctx.commit();
  return { stageReads: snap.stageReads, stageWrites: snap.stageWrites };
}

/** A bare frame driven by the old per-dial setter. */
function frameCase(lib: Lib, use: string, get: string, mode: string) {
  const mem = new lib.SharedMemory(undefined, structuredClone(SEED));
  const log = new lib.EventLog(mem.getState());
  const ctx: any = new lib.StageContext('', 'S', 's', mem, '', log);
  ctx[use](mode);
  const inherited = [ctx.createNext('', 'N', 'n')[get](), ctx.createChild('', 'b', 'C', 'c')[get]()];
  const tracked = stage(ctx);
  return { got: ctx[get](), inherited, tracked, bundle: log.list()[0] };
}

/** A runtime driven by the old setters. */
function runtimeCase(lib: Lib, act: (rt: any, lib: Lib) => void) {
  const rt: any = new lib.ExecutionRuntime('Root', 'root', undefined, structuredClone(SEED));
  act(rt, lib);
  const tracked = stage(rt.rootStageContext);
  const snap = rt.getSnapshot();
  return {
    tracked,
    commitLog: snap.commitLog,
    commitValues: snap.commitValues,
    writeProvenance: snap.writeProvenance,
    mirror: rt.redactedStore?.getState(),
  };
}

const FRAME: Array<[string, string, string]> = [
  ['useReadTracking', 'getReadTracking', 'summary'],
  ['useWriteTracking', 'getWriteTracking', 'summary'],
  ['useCommitValues', 'getCommitValues', 'delta'],
  ['useWriteProvenance', 'getWriteProvenance', 'reads-prefix'],
];

const rule = (lib: Lib) => new lib.RedactionRule({ keys: ['secret'] });
const RUNTIME: Array<[string, (rt: any, lib: Lib) => void]> = [
  ['useReadTracking', (rt) => rt.useReadTracking('off')],
  ['useWriteTracking', (rt) => rt.useWriteTracking('off')],
  ['useCommitValues', (rt) => rt.useCommitValues('delta')],
  ['useWriteProvenance', (rt) => rt.useWriteProvenance('reads-prefix')],
  ['useRedaction', (rt, lib) => rt.useRedaction(rule(lib))],
  [
    'enableRedactedMirror (after useRedaction; idempotent)',
    (rt, lib) => {
      rt.useRedaction(rule(lib));
      rt.enableRedactedMirror();
      const store = rt.redactedStore;
      rt.enableRedactedMirror();
      if (rt.redactedStore !== store) throw new Error('enableRedactedMirror is not idempotent');
    },
  ],
];

describe('deprecated StageContext per-dial members — same observable result as before F5', () => {
  it.each(FRAME)('%s / %s', (use, get, mode) => {
    const [[, published], [, build]] = LIBS;
    const was = frameCase(published, use, get, mode);
    expect(frameCase(build, use, get, mode)).toEqual(was);
    expect(was.got).toBe(mode);
  });
});

describe('deprecated ExecutionRuntime setters — same observable result as before F5', () => {
  it.each(RUNTIME)('%s', (_name, act) => {
    const [[, published], [, build]] = LIBS;
    expect(runtimeCase(build, act)).toEqual(runtimeCase(published, act));
  });
});
