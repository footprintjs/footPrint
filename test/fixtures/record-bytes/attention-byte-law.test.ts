/**
 * C2 optional attention, PR104's one explicitly retained commit-error diagnostic, the mapper-reads law
 * (a subflow mapper's reads are the mount's reads), the read-window law (foottrace 1.13.0: a step that
 * ran beside another says on its first bundle what it could have seen of the log) and the list-form law
 * (12.0.0: an execution tree is its stages in run order, a fork's children `branches`) are the named laws.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { type MountReads, SCOPE_REDACTED, withoutMapperReads } from '../../lib/engine/scenario/mapper-reads-law.js';
import { type ReadWindow, takeReadWindows } from '../../lib/engine/scenario/read-window-law.js';
import { pinnedText } from '../bytes.js';
import { projectAttemptEffectsV11 } from './attempt-effects-v11-projection.js';
import hashes from './pre-attention-hashes.json';
import { SCENARIOS } from './scenarios.js';

const CHANGED = new Set(['failures', 'forkError', 'retry', 'throttledFork', 'readTiers']);

const UNDEFINED = '«undefined»';
const READ_TIERS_FAILURE = "TypeError: Cannot read properties of undefined (reading 'push')";

/** The #124 read-after-delete law (11.0) as the readTiers record shows it: the deletion is kept and the push throws. */
function assertReadTiers124(current: Record<string, any>): void {
  expect(current.failed).toBe(READ_TIERS_FAILURE);
  expect(current.snapshot.sharedState).toEqual({ x: UNDEFINED, y: [1] });
  const [root, stage] = current.snapshot.executionTree;
  expect(root.id).toBe('before-first-write');
  expect(stage.id).toBe('after-first-write');
  expect(stage.runtimeStageId).toBe('after-first-write#1');
  expect(stage.stageReads).toEqual({ x: UNDEFINED });
  expect(stage.stageWrites).toEqual({ x: UNDEFINED });
  expect(stage.errors).toEqual({ stageExecutionError: READ_TIERS_FAILURE });
  expect(stage.attention).toEqual([
    { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] },
  ]);
  expect(current.snapshot.commitLog).toHaveLength(2);
  const commit = current.snapshot.commitLog[1];
  expect(commit.stageId).toBe(stage.id);
  expect(commit.runtimeStageId).toBe(stage.runtimeStageId);
  expect(commit.overwrite).toEqual({ x: UNDEFINED });
  expect(commit.updates).toEqual({});
  expect(commit.trace).toEqual([{ path: 'x', verb: 'set' }]);
}

/** These fixtures are controlled records. Only actual stage-shaped objects lose the new projection. */
function withoutAttention(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutAttention);
  const object = value as Record<string, unknown>;
  const stage =
    typeof object.id === 'string' && typeof object.runtimeStageId === 'string' && Object.hasOwn(object, 'errors');
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (stage && key === 'attention') continue;
    output[key] = withoutAttention(item);
  }
  return output;
}

/** PR104 changes exactly one diagnostic at one known failed commit; no general error-bag exemption. */
function projectCommitErrorDiagnostic(name: string, current: unknown, prior: unknown): void {
  if (name !== 'failures') return;
  type Fixture = {
    uncloneable: {
      failed: string;
      snapshot: {
        executionTree: { id: string; runtimeStageId: string; errors: Record<string, unknown>; attention?: unknown }[];
      };
    };
  };
  const uncloneable = (current as Fixture).uncloneable;
  const stage = uncloneable.snapshot.executionTree[1];
  expect(stage.id).toBe('uncloneable');
  expect(stage.runtimeStageId).toBe('uncloneable#1');
  expect(uncloneable.failed).toMatch(/^DataCloneError: /);
  expect(stage.errors).toEqual({ stageExecutionError: uncloneable.failed });
  expect(stage.attention).toEqual([
    { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] },
  ]);
  const projected = (prior as Fixture).uncloneable.snapshot.executionTree[1];
  expect(projected.id).toBe(stage.id);
  expect(projected.runtimeStageId).toBe(stage.runtimeStageId);
  expect(projected.errors).toEqual({ stageExecutionError: uncloneable.failed });
  delete projected.errors.stageExecutionError;
}

/**
 * The mount-reads law, per scenario (`../../lib/engine/scenario/mapper-reads-law.ts`): each mount whose
 * mappers or merge-back read parent keys, read off the scenario's chart (`scenarios.ts`). No other scenario's
 * mapper reads the parent, and every other outputMapper returns scalars only, which the merge-back sets
 * without a read. subflowBoundary runs under `writeProvenance: 'reads-prefix'`, so its rows name the keys too.
 */
const MAPPER_READS: Record<string, readonly MountReads[]> = {
  // inputMapper: (s) => ({ seed: s.seedValue }) — Start wrote seedValue = 'v'.
  lazySubflow: [
    {
      node: ['snapshot', 'executionTree', 1],
      runtimeStageId: 'sf-lazy#1',
      reads: [{ key: 'seedValue', retained: 'v' }],
    },
  ],
  // inputMapper: (s) => ({ amount: s.amount }) — Prepare wrote amount = 10. The resumed leg starts AT the
  // mount (the pause was inside it) and its inputMapper runs again, for the args.
  interruptSubflow: [
    {
      node: ['paused', 'executionTree', 1],
      runtimeStageId: 'sf-ask#1',
      reads: [{ key: 'amount', retained: 10 }],
    },
    {
      node: ['resumed', 'executionTree', 0],
      runtimeStageId: 'sf-ask#3',
      reads: [{ key: 'amount', retained: 10 }],
    },
  ],
  // outputMapper: (out) => ({ summary: { from: out.from } }) — a plain object with one field: the merge-back reads
  // the root `summary` (Seed wrote { kept: true }) before it sets `summary.from`. No inputMapper.
  addresses: [
    {
      node: ['snapshot', 'executionTree', 0, 'branches', 1, 0],
      runtimeStageId: 'sf-merge#2',
      reads: [{ key: 'summary', retained: { kept: true } }],
    },
  ],
  // inputMapper: (s) => ({ ssnIn: s.ssn, who: s.profile }) — `ssn` is a policy key (placeholder), `profile`
  // a fields key (Seed wrote { name: 'Ada', auth: { token: 't-1' } }; the copy holds the placeholder at the
  // selected `auth.token`). The outputMapper reads only the subflow's output, but it reads
  // the marked `token`, so the taint marks every key it returns (`items`, `meta`, `token`) before the
  // merge-back runs. The merge-back, in the result's order: `items` (an array, appended: a root read,
  // placeholder), `meta` (a plain object: a root read, placeholder, then the older `meta.list` / `meta.obj`
  // reads), `token` (a scalar: no read). The rows: `items`, `meta␟list`, `meta␟obj`, `token`; each lists the
  // law's keys read before it. Both views.
  subflowBoundary: (['snapshot', 'redacted'] as const).map((view) => ({
    node: [view, 'executionTree', 1],
    runtimeStageId: 'sf-in#1',
    reads: [
      { key: 'ssn', retained: SCOPE_REDACTED },
      { key: 'profile', retained: { name: 'Ada', auth: { token: SCOPE_REDACTED } } },
      { key: 'items', retained: SCOPE_REDACTED },
      { key: 'meta', retained: SCOPE_REDACTED },
    ],
    log: [view, 'commitLog'],
    rows: [
      ['ssn', 'profile', 'items'],
      ['ssn', 'profile', 'items', 'meta', 'meta.list'],
      ['ssn', 'profile', 'items', 'meta', 'meta.list', 'meta.obj'],
      ['ssn', 'profile', 'items', 'meta', 'meta.list', 'meta.obj'],
    ],
  })),
};

/**
 * The read-window law, per scenario (`../../lib/engine/scenario/read-window-law.ts`): the steps that ran beside
 * another, with the stamps they carry, in record order. The captured engine wrote no such field, so each is
 * asserted exactly and then taken out of the build's bytes (never added to the old side). Every other
 * scenario's steps run one after another, or only wrote, so it must carry none.
 */
const READ_WINDOWS: Record<string, readonly ReadWindow[]> = {
  // Reader read `k` while the log held Seed's one commit; Writer committed (idx 1, its repeat 2); Reader's
  // second read (`late`) saw the log at 3; Reader committed at idx 3.
  firstTouch: [{ runtimeStageId: 'reader#1', beganAt: 1, sawUntil: 3 }],
  // The Each fan-out read `words` (log at 1, after Split), then its branches committed idx 1–4 under it.
  parallelForEach: [{ runtimeStageId: 'each#1', beganAt: 1 }],
  // Remerge read `profile` before its sibling Child committed (idx 1); in the served and the redacted view.
  nestedPaths: [
    { runtimeStageId: 'remerge#2', beganAt: 1 },
    { runtimeStageId: 'remerge#2', beganAt: 1 },
  ],
};

/**
 * The list-form law (12.0.0): the captured engine linked each stage to the next by `next` and a fork's
 * children by `children`; the build writes the stages in run order and the children as `branches`, one
 * list each. Every tree (`executionTree`, a mount's `stageContexts`) is read back into the linked form,
 * key order included (own fields, then `next`, then `children`), so the hash still judges every byte.
 * The projection is exact only if no list-form stage has a `next` or `children` of its own: asserted.
 */
function linkedChain(chain: unknown): unknown {
  expect(Array.isArray(chain) && chain.length > 0, 'the list form: a tree is a nonempty list').toBe(true);
  let next: Record<string, unknown> | undefined;
  for (let i = (chain as unknown[]).length - 1; i >= 0; i--) {
    const { branches, ...own } = (chain as Record<string, unknown>[])[i]!;
    expect(Object.hasOwn(own, 'next') || Object.hasOwn(own, 'children'), 'the list form has no next/children').toBe(
      false,
    );
    const node: Record<string, unknown> = asLinkedForm(own) as Record<string, unknown>;
    if (next) node.next = next;
    if (branches !== undefined) node.children = (branches as unknown[]).map(linkedChain);
    next = node;
  }
  return next;
}

function asLinkedForm(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(asLinkedForm);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] =
      (key === 'executionTree' || key === 'stageContexts') && Array.isArray(item)
        ? linkedChain(item)
        : asLinkedForm(item);
  }
  return output;
}

describe('C2 record byte boundary against the captured pre-attention engine', () => {
  it.each(Object.keys(SCENARIOS))('%s preserves every byte outside the named law', async (name) => {
    const current: unknown = JSON.parse(projectAttemptEffectsV11(name, pinnedText(await SCENARIOS[name]!())));
    withoutMapperReads(current, MAPPER_READS[name] ?? []);
    expect(takeReadWindows(current), 'the read-window law: exactly the steps that ran beside another').toEqual(
      READ_WINDOWS[name] ?? [],
    );
    if (name === 'readTiers') assertReadTiers124(current as Record<string, unknown>);
    const prior = withoutAttention(current);
    projectCommitErrorDiagnostic(name, current, prior);
    const normalized = JSON.stringify(asLinkedForm(prior), null, 2) + '\n';
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(hashes[name as keyof typeof hashes]);
    if (!CHANGED.has(name)) expect(JSON.stringify(asLinkedForm(current), null, 2) + '\n').toBe(normalized);
  });
});
