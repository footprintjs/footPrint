import assert from 'node:assert/strict';

export const behaviors = [
  {
    name: 'runtime IDs preserve nested stage and execution identities',
    covers: {
      foottrace: [
        'buildRuntimeStageId',
        'parseRuntimeStageId',
        'splitStageId',
        'isExecutionKey',
        'stageIdOf',
        'subflowSegmentsOf',
        'idPathSegments',
        'joinPath',
        'PATH_DELIMITER',
        'EXECUTION_DELIMITER',
      ],
    },
    run({ root: r }) {
      assert.equal(r.PATH_DELIMITER, '/');
      assert.equal(r.EXECUTION_DELIMITER, '#');
      const path = r.joinPath('outer', 'inner');
      const id = r.buildRuntimeStageId('work', 3, path);
      assert.equal(id, 'outer/inner/work#3');
      assert.deepEqual(r.parseRuntimeStageId(id), { stageId: 'work', executionIndex: 3, subflowPath: path });
      assert.deepEqual(r.splitStageId(r.stageIdOf(id)), { localStageId: 'work', subflowPath: path });
      assert.deepEqual(r.subflowSegmentsOf(id), ['outer', 'inner']);
      assert.deepEqual(r.idPathSegments(path), ['outer', 'inner']);
      assert.equal(r.isExecutionKey(id), true);
      assert.equal(r.isExecutionKey(path), false);
    },
  },
  {
    name: 'attempt IDs distinguish stage and call attempts and reject invalid counts',
    covers: { foottrace: ['buildAttemptId', 'parseAttemptId'] },
    run({ root: r }) {
      assert.deepEqual(r.parseAttemptId(r.buildAttemptId('outer/work#3', 2)), {
        runtimeStageId: 'outer/work#3',
        attempt: 2,
      });
      assert.deepEqual(r.parseAttemptId(r.buildAttemptId('work#3', 2, { ordinal: 1, attempt: 4 })), {
        runtimeStageId: 'work#3',
        attempt: 2,
        call: { ordinal: 1, attempt: 4 },
      });
      assert.equal(r.parseAttemptId('work#3@0'), undefined);
      assert.throws(() => r.buildAttemptId('work#3', 0), RangeError);
    },
  },
  {
    name: 'nested path reads and diagnostic writes preserve presence and refuse denied selectors',
    covers: {
      'foottrace/paths': [
        'nativeGet',
        'nativeHas',
        'isDeniedSegment',
        'normaliseStateKey',
        'setNestedValue',
        'updateNestedValue',
      ],
    },
    run({ paths: p }) {
      const bag = { own: undefined, nested: { count: 2 }, rows: ['a'] };
      assert.equal(p.nativeHas(bag, ['own']), true);
      assert.equal(p.nativeHas(bag, ['missing']), false);
      assert.equal(p.nativeGet(bag, ['nested', 'count']), 2);
      assert.equal(p.normaliseStateKey('nested.count'), 'nested.count');
      assert.notEqual(p.normaliseStateKey('nested.count'), p.normaliseStateKey(['nested', 'count']));
      p.setNestedValue(bag, [], ['nested'], 'count', 4);
      p.updateNestedValue(bag, [], [], 'rows', ['b']);
      assert.deepEqual(bag, { own: undefined, nested: { count: 4 }, rows: ['a', 'b'] });
      assert.equal(p.isDeniedSegment('__proto__'), true);
      p.setNestedValue(bag, [], ['__proto__'], 'polluted', true);
      assert.equal(Object.hasOwn(bag, '__proto__'), false);
      assert.equal({}.polluted, undefined);
    },
  },
  {
    name: 'writer frames retain read prefixes, live values and scrubbed sink bytes',
    covers: {
      'foottrace/write': ['SharedMemory', 'EventLog', 'RecordFrame', 'LOG_PLACEHOLDER'],
      foottrace: ['readStoredRecord'],
    },
    run({ root: r, write: w }) {
      const entries = [];
      const state = new w.SharedMemory(undefined, { count: 1 });
      const log = new w.EventLog(state.getState(), {
        sink: Object.fromEntries(
          ['opened', 'commit', 'note', 'closed'].map((kind) => [
            kind,
            (entry) => entries.push(kind === 'note' ? { ...entry, kind, note: entry.kind } : { ...entry, kind }),
          ]),
        ),
        address: { logRunId: 'contract', drillPath: [] },
      });
      const frame = new w.RecordFrame(state, log);
      frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
      assert.equal(frame.read([], 'count'), 1);
      frame.noteRead([], 'count');
      frame.write(frame.at([], 'answer'), 2, 'set');
      frame.write(frame.at([], 'secret'), 'private-value', 'set', { whole: true });
      frame.commit(() => ({ stage: 'Work', stageId: 'work', runtimeStageId: 'work#0' }));
      assert.equal(state.getValue([], [], 'answer'), 2);
      assert.equal(state.getValue([], [], 'secret'), 'private-value');
      assert.equal(log.list()[0].overwrite.secret, w.LOG_PLACEHOLDER);
      assert.deepEqual(log.list()[0].trace.find((row) => row.path === 'answer').readKeys, ['count']);
      log.note('opaque', { count: 1 });
      log.close('ok');
      const stored = r.readStoredRecord(JSON.parse(JSON.stringify(entries)));
      const root = stored.root('contract');
      assert.equal(root.complete, true);
      assert.deepEqual(root.gaps, []);
      assert.deepEqual(stored.unread, []);
      assert.equal(root.commitLog[0].overwrite.answer, 2);
      assert.equal(root.notes[0].kind, 'opaque');
      assert.deepEqual(root.source().initialState, { count: 1 });
      const incomplete = r.readStoredRecord(entries.filter((entry) => entry.kind !== 'closed')).root('contract');
      assert.equal(incomplete.complete, false);
      const limited = r.readStoredRecord(entries, { entries: 1 });
      assert.equal(limited.root('contract').complete, false);
      assert.ok(limited.unread.length > 0);
    },
  },
  {
    name: 'value reads distinguish initial state from absent history and fold merge rows',
    covers: { foottrace: ['commitValueAtWithBasis'] },
    run({ root: r, write: w }) {
      assert.deepEqual(r.commitValueAtWithBasis([], -1, 'count', { initialState: { count: 1 } }), {
        value: 1,
        basis: ['never-written', 'from-initial-state'],
      });
      assert.deepEqual(r.commitValueAtWithBasis([], -1, 'count', { initialState: {} }), {
        value: undefined,
        basis: ['never-written'],
      });
      const state = new w.SharedMemory(undefined, { cfg: { a: 1 } });
      const log = new w.EventLog(state.getState());
      const frame = new w.RecordFrame(state, log);
      frame.write(frame.at([], 'cfg'), { b: 2 }, 'merge');
      frame.commit(() => ({ stage: 'Merge', stageId: 'merge', runtimeStageId: 'merge#0' }));
      assert.deepEqual(r.commitValueAtWithBasis(log.list(), 0, 'cfg', { initialState: log.getInitialState() }).value, {
        a: 1,
        b: 2,
      });
      for (const commitValues of ['full', 'delta']) {
        const arrayState = new w.SharedMemory(undefined, { rows: ['a'] });
        const arrayLog = new w.EventLog(arrayState.getState());
        const arrayFrame = new w.RecordFrame(arrayState, arrayLog);
        arrayFrame.useEncoding({ commitValues, writeProvenance: 'reads-prefix' });
        arrayFrame.write(arrayFrame.at([], 'rows'), ['a', 'b'], 'set');
        arrayFrame.commit(() => ({ stage: 'Grow', stageId: 'grow', runtimeStageId: 'grow#0' }));
        assert.deepEqual(
          r.commitValueAtWithBasis(arrayLog.list(), 0, 'rows', {
            initialState: arrayLog.getInitialState(),
          }).value,
          ['a', 'b'],
        );
        assert.deepEqual(arrayState.getValue([], [], 'rows'), ['a', 'b']);
      }
    },
  },
  {
    name: 'causal chains link earlier writers and flatten shared dependencies once',
    covers: { foottrace: ['causalChain', 'flattenCausalDAG'] },
    run({ root: r, write: w }) {
      const state = new w.SharedMemory();
      const log = new w.EventLog(state.getState());
      for (const [index, key, value] of [
        [0, 'input', 2],
        [1, 'answer', 4],
      ]) {
        const frame = new w.RecordFrame(state, log);
        frame.write(frame.at([], key), value, 'set');
        frame.commit(() => ({ stage: key, stageId: key, runtimeStageId: `${key}#${index}` }));
      }
      const dag = r.causalChain(log.list(), 'answer#1', (id) => (id === 'answer#1' ? ['input'] : []));
      assert.ok(dag);
      assert.deepEqual(
        r
          .flattenCausalDAG(dag)
          .map((node) => node.runtimeStageId)
          .sort(),
        ['answer#1', 'input#0'],
      );
      assert.equal(
        r.causalChain(log.list(), 'absent#2', () => []),
        undefined,
      );
      const cut = r.causalChain(log.list(), 'answer#1', () => ['input'], { maxNodes: 1 });
      assert.equal(cut.truncated.byNodes, true);
      assert.equal(r.flattenCausalDAG(cut).length, 1);
    },
  },
  {
    name: 'native source snapshots retain address identity and reject malformed envelopes',
    covers: { 'foottrace/write': ['createReadSourceRecord', 'decodeReadSourceSnapshot'] },
    run({ write: w }) {
      const address = { logRunId: 'source-contract', drillPath: [] };
      const state = new w.SharedMemory(undefined, { count: 1 });
      const source = w.createReadSourceRecord(state, address);
      const frame = new w.RecordFrame(state, source.log);
      const read = frame.readWithSource([], 'count', { runtimeStageId: 'read#0' });
      assert.equal(read.value, 1);
      assert.equal(read.occurrence.source.kind, 'base');
      const snapshot = source.snapshot();
      assert.deepEqual(w.decodeReadSourceSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
      assert.equal(snapshot.occurrences.length, 1);
      assert.equal(w.decodeReadSourceSnapshot({ ...snapshot, address: { logRunId: '', drillPath: [] } }), undefined);
      source.retire();
      assert.equal(source.snapshot().status, 'retired');
    },
  },
  {
    name: 'served records isolate mutable builtins while ordinary containers stay frozen',
    covers: { foottrace: ['deepEqual', 'serveRecord'], 'foottrace/write': ['deepFreeze', 'freezeRecord'] },
    run({ root: r, write: w }) {
      const plain = w.deepFreeze({ nested: { count: 1 } });
      assert.equal(Object.isFrozen(plain.nested), true);
      assert.throws(() => {
        plain.nested.count = 2;
      }, TypeError);
      const record = w.freezeRecord({ nested: { date: new Date(0) }, ordinary: { count: 1 } });
      const first = r.serveRecord(record);
      first.nested.date.setTime(100);
      assert.equal(r.serveRecord(record).nested.date.getTime(), 0);
      assert.equal(r.deepEqual({ nested: [1, 2] }, { nested: [1, 2] }), true);
      assert.equal(r.deepEqual({ nested: [1, 2] }, { nested: [2, 1] }), false);
    },
  },
];
