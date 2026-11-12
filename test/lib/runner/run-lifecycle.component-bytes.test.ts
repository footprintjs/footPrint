/**
 * Real component-absent2488+#142 output, captured twice per encoding.
 * Only existing named volatile fields/duration text are normalized, and the one named law the capture
 * predates is taken out after it is asserted: the Sub mount's node carries the keys its inputMapper and
 * merge-back read
 * (`../engine/scenario/mapper-reads-law.ts`). A second named law the capture predates (foottrace 1.13.0) is
 * taken out the same way: the fork child that ran beside its sibling (`child-b#5`) carries `beganAt`, which
 * an engine on an older foottrace cannot write (`../engine/scenario/read-window-law.ts`; the exact stamps are
 * `UNTAGGED_READ_WINDOWS`, asserted before they are removed, so a build that lost them fails here).
 * A third (13.0.0, the list form): the build writes an execution tree as its stages in run order and a
 * fork's children as `branches`, where the capture linked them by `next` / `children`. The build's trees
 * (`executionTree`, a mount's `stageContexts`) are read back into the linked form, key order included,
 * so every other byte is still compared.
 */
import { expect, it } from 'vitest';

import {
  runUntaggedFixture,
  UNTAGGED_MAPPER_READS,
  UNTAGGED_READ_WINDOWS,
} from '../engine/scenario/declared-tags-untagged-fixture.js';
import { withoutMapperReadsText } from '../engine/scenario/mapper-reads-law.js';
import { withSettledAttemptDurations } from '../engine/scenario/p1a-attempt-evidence.js';
import { withoutReadWindowsText } from '../engine/scenario/read-window-law.js';
import delta from './fixtures/component-absent-2488-f2.delta.json';
import full from './fixtures/component-absent-2488-f2.full.json';

/** A mount path named in the linked form (`executionTree`, then `next` per stage) in the list form. */
function listPath(path: readonly (string | number)[]): (string | number)[] {
  const out: (string | number)[] = [];
  for (let i = 0; i < path.length; i++) {
    out.push(path[i]!);
    if (path[i] !== 'executionTree' || path[i + 1] !== 'next') continue;
    let index = 0;
    while (path[i + 1] === 'next') {
      index++;
      i++;
    }
    out.push(index);
  }
  return out;
}

/** One list-form chain as the linked form the capture holds: own fields, then `next`, then `children`. */
function linkedChain(chain: Record<string, unknown>[]): unknown {
  expect(chain.length, 'the list form: a tree is a nonempty list').toBeGreaterThan(0);
  let next: Record<string, unknown> | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const { branches, ...own } = chain[i]!;
    expect(Object.hasOwn(own, 'next') || Object.hasOwn(own, 'children'), 'the list form has no next/children').toBe(
      false,
    );
    const node = asLinkedForm(own) as Record<string, unknown>;
    if (next) node.next = next;
    if (branches !== undefined) node.children = (branches as Record<string, unknown>[][]).map(linkedChain);
    next = node;
  }
  return next;
}

function asLinkedForm(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(asLinkedForm);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const tree = (key === 'executionTree' || key === 'stageContexts') && Array.isArray(item);
    out[key] = tree ? linkedChain(item as Record<string, unknown>[]) : asLinkedForm(item);
  }
  return out;
}

/** The same on a record's JSON text, re-serialised in the same layout. */
function asLinkedFormText(json: string): string {
  const space = json.includes('\n') ? 2 : undefined;
  return JSON.stringify(asLinkedForm(JSON.parse(json)), null, space);
}

const MAPPER_READS = UNTAGGED_MAPPER_READS.map((mount) => ({ ...mount, node: listPath(mount.node) }));

it.each(['full', 'delta'] as const)(
  'unused component cells preserve component-absent %s record bytes',
  async (mode) => {
    const before = JSON.stringify(mode === 'full' ? full : delta, null, 2);
    const windowless = withoutReadWindowsText(await runUntaggedFixture(mode), UNTAGGED_READ_WINDOWS);
    const build = asLinkedFormText(withoutMapperReadsText(windowless, MAPPER_READS));
    expect(withSettledAttemptDurations(build)).toBe(before);
  },
);
