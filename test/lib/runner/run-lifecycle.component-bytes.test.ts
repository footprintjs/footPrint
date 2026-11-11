/**
 * Real component-absent2488+#142 output, captured twice per encoding.
 * Only existing named volatile fields/duration text are normalized, and the one named law the capture
 * predates is taken out after it is asserted: the Sub mount's node carries the keys its inputMapper and
 * merge-back read
 * (`../engine/scenario/mapper-reads-law.ts`). A second named law the capture predates (foottrace 1.13.0) is
 * taken out the same way: the fork child that ran beside its sibling (`child-b#5`) carries `beganAt`, which
 * an engine on an older foottrace cannot write (`../engine/scenario/read-window-law.ts`; the exact stamps are
 * `UNTAGGED_READ_WINDOWS`, asserted before they are removed, so a build that lost them fails here).
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

it.each(['full', 'delta'] as const)(
  'unused component cells preserve component-absent %s record bytes',
  async (mode) => {
    const before = JSON.stringify(mode === 'full' ? full : delta, null, 2);
    const windowless = withoutReadWindowsText(await runUntaggedFixture(mode), UNTAGGED_READ_WINDOWS);
    const build = withoutMapperReadsText(windowless, UNTAGGED_MAPPER_READS);
    expect(withSettledAttemptDurations(build)).toBe(before);
  },
);
