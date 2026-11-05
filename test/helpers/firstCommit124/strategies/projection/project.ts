/** Own-engine fixture value projections only. No engine, heap, merge or replay algorithm. */
import { refuse } from '../../../readLawWitness.js';
import type { ValueFact } from '../../../readWitness.js';
import type { Op } from '../branchFacts.js';
import { array, denseValues, literal, record, rows } from '../branchFacts.js';
import type { Profile } from './profiles.js';

export interface Projection {
  readonly writes: readonly { readonly method: 'setObject' | 'updateObject'; readonly value: ValueFact }[];
  readonly active: boolean;
  readonly literal: ValueFact;
  readonly literalAt?: readonly string[];
  readonly selected?: string;
}
function field(value: ValueFact, name: string, next: ValueFact): ValueFact {
  const entries = rows(value).map((row) => [...row] as [string, boolean, ValueFact]);
  if (entries.some(([, enumerable]) => !enumerable)) return refuse('projection object has non-enumerable members');
  const index = entries.findIndex(([key]) => key === name);
  if (index < 0) entries.push([name, true, next]);
  else entries[index][2] = next;
  return { kind: 'object', entries };
}
export function project(profile: Profile, op: Op, read: ValueFact): Projection {
  const value = literal(op.v);
  const set = (value: ValueFact) => ({ method: 'setObject' as const, value });
  switch (profile.projection) {
    case 'append':
    case 'deep-copy-append': {
      const present = read.kind === 'array';
      const prefix = present ? denseValues(read) : [];
      return {
        active: present,
        writes: [set(array([...prefix, value]))],
        literal: value,
        literalAt: [String(prefix.length)],
      };
    }
    case 'element-field': {
      const prefix = read.kind === 'array' ? denseValues(read) : [];
      const selected = prefix[op.i!];
      if (selected?.kind !== 'object') return { active: false, writes: [], literal: value };
      prefix[op.i!] = field(selected, op.p!, value);
      return {
        active: true,
        writes: [set(array(prefix))],
        selected: String(op.i),
        literal: value,
        literalAt: [String(op.i), op.p!],
      };
    }
    case 'literal-field': {
      const payload = record(op.p!, value);
      return {
        active: read.kind === 'object',
        writes: [{ method: read.kind === 'object' ? 'updateObject' : 'setObject', value: payload }],
        literal: payload,
        literalAt: [],
      };
    }
    default:
      return refuse('unknown declared projection rule');
  }
}
