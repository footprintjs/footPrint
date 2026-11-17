import { describe, expect, it } from 'vitest';
import { ReadPrefix } from './prefix.ts';
import { InputCapture } from './input.ts';
import { FanoutCapture } from './fanout.ts';
import { generatedInput } from './generated.ts';
import { mapperScope } from '../mapperScope.ts';
import { referenceBytes } from '../../../capture/subflowHandoff.ts';
import { keepCollection, fanoutView, resetFanoutView } from '../../../capture/fanoutCollections.ts';

const parent = { logRunId: 'run-a', drillPath: [] };
const child = { logRunId: 'run-a', drillPath: ['mount#1'] };
function setup() {
  const policy = { captureInputHandoff: true, captureFanoutHandoff: true, readTracking: 'off' };
  const runtime = { executionHistory: { address: parent, length: 1 } };
  const context = {
    runtimeStageId: 'mount#1',
    getPolicy: () => policy,
    rootKeys: () => ['name'],
    hasRootKey: (key) => key === 'name',
    readLiveRoot: () => 7,
    getRedactionRule: () => undefined,
  };
  return { runtime, context, policy };
}
const seed = { idx: 0, runtimeStageId: 'mount#1', trace: [{ path: 'seed' }] };
function collection(index = 0) {
  return {
    version: 1,
    attribution: 'observed-scope-collection',
    parent: { address: parent, runtimeStageId: `fan#${index}`, commitIdx: index, path: 'out' },
    totalItems: 0,
    branchCount: 0,
    slots: [],
    status: 'captured',
    limitations: [],
  };
}
describe('bounded observation authorities', () => {
  it('charges actual UTF8 including astral and lone-surrogate replacement bytes', () => {
    for (const text of ['ascii', 'é', '界', '🙂', '\ud800', '\udc00', 'a🙂界é'])
      expect(referenceBytes(text)).toBe(new TextEncoder().encode(text).length);
    const prefix = new ReadPrefix();
    prefix.read('界'.repeat(22000));
    expect(prefix.exhausted).toBe(true);
    expect(prefix.snapshot()).toEqual([]);
  });
  it('bounds unique source references and does not charge a duplicate as another source', () => {
    const prefix = new ReadPrefix();
    for (let i = 0; i < 4096; i++) prefix.read(String(i));
    prefix.read('0');
    expect(prefix.exhausted).toBe(false);
    prefix.read('extra');
    expect(prefix.exhausted).toBe(true);
    expect(prefix.snapshot()).toHaveLength(4096);
  });
  it('withholds a parent prefix after an actual observed log advance', () => {
    const { runtime, context } = setup();
    const capture = InputCapture.begin(runtime, context, { inputMapper: () => ({}) });
    const view = mapperScope(context, 'inputMapper');
    capture.watch(view.scope);
    expect(view.scope.name).toBe(7);
    view.close();
    runtime.executionHistory.length++;
    expect(capture.finish(child, seed, false)).toMatchObject({
      status: 'partial',
      limitations: ['parent-log-advanced'],
      writes: [{ path: 'seed', reads: [] }],
    });
  });
  it('restored seeds are explicit partial observations without mapped writes', () => {
    const { runtime, context } = setup();
    const capture = InputCapture.begin(runtime, context, { inputMapper: () => ({}) });
    expect(capture.finish(child, seed, true)).toMatchObject({
      status: 'partial',
      limitations: ['resume-seed'],
      writes: [],
    });
  });
  it('requires actual seed index, runtime and whole immediate-child address', () => {
    const { runtime, context } = setup();
    const capture = InputCapture.begin(runtime, context, { inputMapper: () => ({}) });
    for (const [address, bundle] of [
      [undefined, seed],
      [child, undefined],
      [child, { ...seed, idx: 1 }],
      [child, { ...seed, runtimeStageId: 'other#1' }],
      [{ ...child, logRunId: 'other' }, seed],
      [{ ...child, drillPath: ['prefix#0', 'mount#1'] }, seed],
      [{ ...child, drillPath: ['other#1'] }, seed],
    ])
      expect(capture.finish(address, bundle, false)).toBeUndefined();
  });
  it('caps writes without changing the admitted bundle', () => {
    const { runtime, context } = setup();
    const capture = InputCapture.begin(runtime, context, { inputMapper: () => ({}) });
    const bundle = { ...seed, trace: Array.from({ length: 257 }, (_, i) => ({ path: `write${i}` })) };
    const handoff = capture.finish(child, bundle, false);
    expect(handoff.writes).toHaveLength(256);
    expect(handoff.limitations).toContain('budget-exhausted');
    expect(bundle.trace).toHaveLength(257);
  });
  it('omits an unknown whole slot and preserves known failed-slot identity', () => {
    const { runtime, context } = setup();
    const capture = new FanoutCapture(runtime, context);
    capture.count(3, 3);
    // Native generated origins are only obtained from the private registration authority.
    const options = [{}, {}, {}];
    options.forEach((o, i) => capture.register(o, i, true));
    generatedInput(options[0]).settled(child, 2, true, false);
    generatedInput(options[1]).settled({ ...child, drillPath: ['mount#2'] }, 3, false, true);
    generatedInput(options[2]).settled(undefined, 0, true, false);
    let written;
    context.observeStagedWrites = (observer) => {
      written = observer;
      return () => {};
    };
    capture.watchWrite();
    written(['answers']);
    capture.finish({ idx: 1, runtimeStageId: 'mount#1', trace: [{ path: 'answers' }] });
    const actual = fanoutView(runtime).collections[0];
    expect(actual.slots.map((slot) => [slot.index, slot.observation])).toEqual([
      [0, 'failed-slot'],
      [1, 'explicit-output'],
    ]);
    expect(actual.slots[0].child).toEqual({ address: child, beforeCommitIdx: 2 });
    expect(actual.limitations).toEqual(
      expect.arrayContaining(['failed-slot', 'explicit-output', 'missing-child-record']),
    );
    expect(actual.status).toBe('partial');
  });
  it('caps parent collections, makes overflow explicit and never changes prior snapshots', () => {
    const runtime = {};
    for (let i = 0; i < 128; i++) keepCollection(runtime, collection(i));
    const held = fanoutView(runtime);
    keepCollection(runtime, collection(128));
    const final = fanoutView(runtime);
    expect(final.status).toBe('partial');
    expect(final.collections).toHaveLength(128);
    expect(final.collections.at(-1).limitations).toEqual(['budget-exhausted']);
    expect(held.status).toBe('captured');
    expect(held.collections.at(-1).limitations).toEqual([]);
    resetFanoutView(runtime);
    expect(fanoutView(runtime)).toBeUndefined();
    expect(held.collections).toHaveLength(128);
  });
  it('budgets parent path references by UTF8 rather than code units', () => {
    const runtime = {};
    keepCollection(runtime, { ...collection(), parent: { ...collection().parent, path: '界'.repeat(22000) } });
    expect(fanoutView(runtime)).toEqual({ version: 1, status: 'partial', collections: [] });
  });
});
