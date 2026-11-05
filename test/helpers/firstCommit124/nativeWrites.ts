import type { JoinedRun } from '../readLawWitness.js';
import { equal, refuse } from '../readLawWitness.js';
import type { NativeFact } from '../readWitness.js';
import type { BranchReceipt, Context, FixtureCall } from './types.js';
import { key, stringPath } from './valueFacts.js';

function prefix(read: NativeFact, get: NativeFact) {
  if (!read.call || get.address === undefined) return refuse('missing actual read address operands');
  const suffix = [...stringPath(read.call.args[0]), key(read.call.args[1])];
  if (get.address.length < suffix.length || !equal(get.address.slice(-suffix.length), suffix))
    return refuse('canonical read does not join actual user path/key suffix');
  return get.address.slice(0, get.address.length - suffix.length); // Observed prefix, never recognise/guess a namespace.
}
function verb(call: FixtureCall): 'delete' | 'set' | 'merge' {
  if (call.method === 'updateObject') return 'merge';
  if (call.method !== 'setObject') return refuse('unsupported staged-call producer');
  const override = call.call.args[5];
  if (override?.kind === 'string' && override.value === 'delete') return 'delete';
  if (override !== undefined && override.kind !== 'undefined') return refuse('unknown setObject operation override');
  return 'set';
}
function stageSide(
  run: JoinedRun,
  branch: BranchReceipt,
  read: NativeFact,
  get: NativeFact,
  declared: readonly FixtureCall[],
) {
  const actual = branch.calls.filter((call) => call.phase === 'write');
  if (actual.length !== declared.length || actual.some((call, i) => call !== declared[i]))
    return refuse('declared branch does not account for EVERY actual StageContext write');
  const canonicalPrefix = prefix(read, get);
  const used = new Set<number>();
  for (const call of declared) {
    const method = verb(call);
    const path = stringPath(call.call.args[0]);
    const name = key(call.call.args[1]);
    const writes = run.native.events.filter(
      (event) =>
        event.tier === 'buffer-call' &&
        event.start > call.start &&
        event.end < call.end &&
        ['delete', 'set', 'merge'].includes(event.method),
    );
    if (writes.length !== 1) return refuse('actual StageContext write has an ambiguous native producer');
    const row = writes[0];
    const object = call.call.objects[2];
    const value = call.call.args[2];
    if (
      row.outcome !== 'returned' ||
      row.phase !== 'write' ||
      row.method !== method ||
      row.frame !== read.frame ||
      row.buffer !== get.buffer ||
      row.epoch !== get.epoch ||
      !equal(row.address, [...canonicalPrefix, ...path, name]) ||
      used.has(row.id)
    )
      return refuse('actual staged write does not join this frame/buffer/epoch/address');
    if (method !== 'delete') {
      if (!equal(row.value, value)) return refuse('native staged value differs from actual call argument');
      const hasObject = ['array', 'object', 'date'].includes(value.kind);
      if (
        hasObject
          ? !Number.isSafeInteger(object) || object! <= 0 || row.valueObject !== object
          : row.valueObject !== undefined
      )
        return refuse('native producer does not use the actual argument object identity');
    }
    used.add(row.id);
  }
  const all = run.native.events.filter(
    (row) =>
      row.tier === 'buffer-call' &&
      row.phase === 'write' &&
      row.start > branch.operation.start &&
      row.end < branch.operation.end &&
      ['delete', 'set', 'merge'].includes(row.method),
  );
  if (all.length !== used.size || all.some((row) => !used.has(row.id)))
    return refuse('independent unaccounted native write inside the operation');
}
export function validateNativeWrites(context: Context, old: readonly FixtureCall[], now: readonly FixtureCall[]) {
  stageSide(context.a, context.cause.baseline, context.reads[0].read, context.reads[0].get, old);
  stageSide(context.b, context.cause.build, context.reads[1].read, context.reads[1].get, now);
}
