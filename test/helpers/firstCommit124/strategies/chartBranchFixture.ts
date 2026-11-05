/** Scripted branch/receipt DATA shared by adjacent inert controls only. */
export const UNDEF = Symbol('fixture undefined');
export const fact = (value: any): any =>
  value === UNDEF
    ? { kind: 'undefined' }
    : value === null
    ? { kind: 'null' }
    : value instanceof Date
    ? { kind: 'date', value: value.getTime() }
    : typeof value !== 'object'
    ? { kind: typeof value, value: typeof value === 'number' ? String(value) : value }
    : {
        kind: Array.isArray(value) ? 'array' : 'object',
        ...(Array.isArray(value) ? { value: value.length } : {}),
        entries: Object.entries(value).map(([key, item]) => [key, true, fact(item)]),
      };
export const coord = ['chart', 0, 'seed', 'invocation', 0, 'op', 1];
export type Expected = { key?: string; value: any; id?: number; merge?: boolean };
export function side(
  readValue: any,
  writes: Expected[],
  readId = 11,
  readObject = readValue !== UNDEF && readValue !== null && typeof readValue === 'object' ? 1 : undefined,
  methods: readonly string[] = ['getValue'],
) {
  const read: any = {
    id: readId,
    start: 10,
    end: 12,
    leg: '0',
    method: 'getValue',
    outcome: 'returned',
    frame: 1,
    result: fact(readValue),
    resultObject: readObject,
    operation: coord,
    call: { args: [fact([]), fact('a')], objects: [50, undefined] },
  };
  const calls = [
    read,
    ...methods
      .slice(1)
      .map((method, i) => ({ ...read, id: readId + 100 * (i + 1), start: 14 + i * 4, end: 16 + i * 4, method })),
    ...writes.map((write, i) => ({
      id: 20 + i,
      start: 20 + (methods.length - 1) * 4 + i * 4,
      end: 23 + (methods.length - 1) * 4 + i * 4,
      leg: '0',
      method: write.merge ? 'updateObject' : 'setObject',
      outcome: 'returned',
      frame: 1,
      operation: coord,
      call: {
        args: [
          fact([]),
          fact(write.key ?? 'a'),
          fact(write.value),
          fact(UNDEF),
          ...(!write.merge ? [fact(UNDEF)] : []),
        ],
        objects: [51 + i, undefined, write.id, undefined, ...(!write.merge ? [undefined] : [])],
      },
    })),
  ];
  read.resultIdentities = readObject === undefined ? [] : [{ path: [], object: readObject }];
  const bound: any = {
    read,
    branch: {
      operation: { coordinate: coord, frame: 1, start: 5, end: 99, nativeId: readId },
      programPath: ['seed', 1],
      path: [],
      calls,
      edits: [],
    },
  };
  attachNative(bound);
  return bound;
}

/** Inert existing-port data, not native execution. Each node is a distinct original object. */
function attachNative(bound: any) {
  const header = { stageId: 's', runtimeStageId: 's#1', runId: 'r' };
  const build = bound.read.result.kind === 'undefined';
  const common = { leg: '0', frame: 1, header, outcome: 'returned', buffer: 1, epoch: 0 };
  const facts = { kind: 'object', entries: [['a', true, bound.read.result]] };
  const point = (at: number) => ({
    layout: build ? 'build-record-state' : 'baseline-stage-shared-memory',
    at,
    memory: 500,
    generation: 600,
    facts,
  });
  const deleted: any = {
    ...common,
    id: 2,
    start: 2,
    end: 4,
    tier: 'buffer-call',
    method: 'delete',
    phase: 'write',
    address: ['a'],
    heapBefore: point(2.1),
    heapAfter: point(3.9),
  };
  const events = [deleted];
  for (const call of bound.branch.calls) {
    Object.assign(call, { header, tier: 'stage-call', phase: call.method.startsWith('get') ? 'read' : 'write' });
    events.push(call);
    if (call.phase === 'read') {
      call.resultIdentities = bound.read.resultIdentities;
      const get: any = {
        ...common,
        id: 1000 + call.id,
        start: call.start + 0.1,
        end: call.start + 0.2,
        tier: 'buffer-call',
        method: 'get',
        phase: 'read',
        operation: coord,
        address: ['a'],
        base: { found: !build, value: bound.read.result },
        result: { kind: 'undefined' },
      };
      Object.assign(call, {
        gets: [get.id],
        heapBefore: point(call.start + 0.05),
        heapAfter: point(call.end - 0.05),
        memoryGets: build ? [] : [2000 + call.id],
      });
      events.push(get);
      if (!build)
        events.push({
          ...common,
          id: 2000 + call.id,
          start: call.start + 0.3,
          end: call.end - 0.1,
          tier: 'memory-get',
          method: 'getValue',
          phase: 'read',
          operation: coord,
          parentRead: call.id,
          receiverObject: 500,
          call: {
            args: [fact('r'), call.call.args[0], call.call.args[1]],
            objects: [undefined, call.call.objects[0], undefined],
          },
          result: call.result,
          resultObject: call.resultObject,
          heapBefore: point(call.start + 0.4),
          heapAfter: point(call.end - 0.2),
        });
    } else {
      const id = call.call.objects[2];
      call.call.identities = call.call.args.map((value: any, i: number) =>
        i === 0
          ? [{ path: [], object: call.call.objects[0] }]
          : i === 2 && ['object', 'array', 'date'].includes(value.kind)
          ? [{ path: [], object: id }]
          : [],
      );
      events.push({
        ...common,
        id: 3000 + call.id,
        start: call.start + 0.4,
        end: call.start + 0.6,
        tier: 'buffer-call',
        method: call.method === 'updateObject' ? 'merge' : 'set',
        phase: 'write',
        operation: coord,
        address: [call.call.args[1].value],
        value: call.call.args[2],
        valueObject: id,
      });
    }
  }
  bound.native = { leg: '0', events, issues: [] };
}
