/** Four closed declared projections; this returns branch data, NEVER a cause/admission. */
import { equal, refuse } from '../../../readLawWitness.js';
import type { Bound, Op } from '../branchFacts.js';
import { literal, undef, validateCalls } from '../branchFacts.js';
import { projectionIdentity } from './identity.js';
import { nativeBranches } from './native.js';
import { type ProjectionKind, PROFILES } from './profiles.js';
import { project } from './project.js';

function one(op: Op, bound: Bound, build: boolean) {
  validateCalls(op, bound);
  const profile = PROFILES[op.t as ProjectionKind];
  const projection = project(profile, op, bound.read.result!);
  const writes = nativeBranches(bound, profile, projection, build);
  projection.writes.forEach((expected, index) => {
    const call = writes[index];
    const args = [
      literal([]),
      literal(op.k),
      expected.value,
      undef(),
      ...(expected.method === 'setObject' ? [undef()] : []),
    ];
    if (!equal(call.call.args, args)) return refuse('observed write is not the declared own-read projection');
    projectionIdentity(profile, projection, bound.read, call);
  });
  // An undefined/primitive input still needs its explicit empty graph, even in a no-write branch.
  if (!writes.length && !equal(bound.read.resultIdentities, []))
    return refuse('no-write candidate has missing/nonempty primitive identity facts');
  return { writes, declared: projection.writes };
}
export function projectionBranchPair(op: Op, baseline: Bound, build: Bound) {
  const old = one(op, baseline, false);
  const now = one(op, build, true);
  if (equal(old.declared, now.declared)) return refuse('no changed declared fixture write branch');
  return {
    kind: 'declared-chart-branches' as const,
    opcode: op.t,
    coordinate: baseline.branch.operation.coordinate,
    baselineWrites: old.writes,
    buildWrites: now.writes,
  };
}
