import { describe, expect, it } from 'vitest';
import { observeRootReads, noteRootRead } from './nativeRootReads.ts';
import { StageContext } from '../memory/StageContext.ts';
import { SharedMemory, EventLog } from 'foottrace/write';
import { privateInput, privateCollections } from './subflowHandoff.ts';

describe('native observation leaf controls', () => {
  it('composes nested root observers and restores them exactly', () => {
    const context = {},
      seen = [];
    const outer = observeRootReads(context, (key) => seen.push(['outer', key]));
    const inner = observeRootReads(context, (key) => seen.push(['inner', key]));
    noteRootRead(context, ['literal.dot'], 'leaf');
    inner();
    noteRootRead(context, [], 'second');
    outer();
    noteRootRead(context, [], 'omitted');
    expect(seen).toEqual([
      ['outer', 'literal.dot'],
      ['inner', 'literal.dot'],
      ['outer', 'second'],
    ]);
  });
  it('restores prior staged-write and boundary observers without duplicating old output callbacks', () => {
    const context = new StageContext('run', 'Stage', 'stage', new SharedMemory(), undefined, new EventLog({})),
      seen = [];
    const outer = context.observeStagedWrites(
      (p) => seen.push(['outer', p]),
      (p) => seen.push(['boundary', p]),
    );
    const inner = context.observeStagedWrites((p) => seen.push(['inner', p]));
    context.setGlobal('first', 1);
    context.commit();
    inner();
    context.setGlobal('last', 2);
    context.commit();
    outer();
    context.setGlobal('omitted', 3);
    context.commit();
    expect(seen).toEqual([
      ['inner', ['first']],
      ['outer', ['last']],
      ['boundary', 'committing'],
      ['boundary', 'landed'],
    ]);
  });
  it('safe serving preserves coordinates while withholding the complete new reference channels', () => {
    const raw = {
      version: 1,
      attribution: 'observed-read-prefix',
      parent: { address: { logRunId: 'r', drillPath: [] }, beforeCommitIdx: 1 },
      child: { address: { logRunId: 'r', drillPath: ['m#1'] }, runtimeStageId: 'm#1', commitIdx: 0 },
      writes: [{ path: 'input', reads: ['secret'] }],
      status: 'captured',
      limitations: [],
    };
    const safe = privateInput(raw);
    expect(safe.writes).toEqual([{ path: 'input', reads: [] }]);
    expect(safe.limitations).toEqual(['privacy-active']);
    expect(raw.writes[0].reads).toEqual(['secret']);
    expect(Object.isFrozen(safe.writes)).toBe(true);
    const view = {
      version: 1,
      status: 'captured',
      collections: [
        {
          parent: { path: 'output' },
          slots: [{ child: { address: raw.child.address } }],
          status: 'captured',
          limitations: [],
        },
      ],
    };
    const served = privateCollections(view);
    expect(served.collections[0].slots).toEqual([]);
    expect(view.collections[0].slots).toHaveLength(1);
    expect(served.collections[0].limitations).toEqual(['privacy-active']);
  });
});
