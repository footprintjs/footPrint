import type { JoinedRun, Segment } from '../readLawWitness.js';
import { equal, refuse } from '../readLawWitness.js';
import type { Cause, FixtureFamily } from './types.js';
export const own = (value: unknown, key: PropertyKey): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) return refuse('program field is not own data');
  return descriptor?.value;
};
const at = (value: unknown, path: readonly Segment[]) => {
  for (const part of path) value = own(value, part);
  return value;
};
export function appliedOperation(a: JoinedRun, cause: Cause, family: FixtureFamily): Readonly<Record<string, unknown>> {
  let program: unknown;
  try {
    program = JSON.parse(a.program);
  } catch {
    return refuse('unreadable applied program bytes');
  }
  if (program === null || typeof program !== 'object' || Array.isArray(program))
    return refuse('unknown applied program');
  const top = own(program, 'commitValues');
  const config = own(program, 'cfg');
  const mode = family === 'chart' ? own(config, 'commitValues') : top;
  if (
    family === 'nested' ||
    (family === 'chart' ? top !== undefined || config === undefined : config !== undefined) ||
    (mode !== 'full' && mode !== 'delta') ||
    cause.baselineCommit.encoder.mode !== mode ||
    cause.buildCommit.encoder.mode !== mode
  )
    return refuse('fixture family/encoder does not match actual program encoding');
  if (!cause.baseline.programPath.length || !equal(cause.baseline.programPath, cause.build.programPath))
    return refuse('missing/different actual operation pointer');
  const op = at(program, cause.baseline.programPath);
  if (op === null || typeof op !== 'object' || Array.isArray(op) || typeof own(op, 't') !== 'string')
    return refuse('operation pointer does not name applied fixture data');
  return op as Readonly<Record<string, unknown>>;
}
