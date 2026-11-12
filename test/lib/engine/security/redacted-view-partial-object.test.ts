/**
 * KNOWN GAP — a field added INSIDE a wholly hidden value makes every redacted view show that value as
 * an object with only the added field.
 *
 * The case. A policy hides a whole key (`keys: ['session']`). One stage writes
 * `session = { token, user }`: every redacted view shows `session: 'REDACTED'`, which is right. A
 * sub-flowchart then hands back `{ session: { refreshed: true } }`. The engine writes that field at a
 * path INSIDE the key (`session/refreshed`), and the record scrubs the value at that path. Replayed onto
 * the placeholder, the row turns the text `'REDACTED'` into the object `{ refreshed: 'REDACTED' }`.
 *
 * What is NOT wrong: nothing secret is shown. The token and the user never appear, and the value of the
 * new field is hidden too. Only the field's name shows, as a path always does.
 *
 * What IS wrong: the shape. `session` really holds three fields. The redacted state and the state
 * folded from the log now say it holds one. A reader of the redacted view (a time-travel screen, a
 * model reading the record) is told that `token` and `user` are gone, and nothing says that the rest
 * is hidden. A hidden value that is still hidden should still read `'REDACTED'`.
 *
 * Found 2026-11-11 by running the copy-on-write differentials with a fresh seed
 * (`COW_DIFF_SEED=11`): the redacted state of a generated chart had FEWER keys than engine 9.28.0's,
 * which the rule "this build may hide more, never show a different value" refuses. Under a policy
 * those differentials still fail with a fresh seed, for this reason, until the gap is closed.
 *
 * Each test asserts TODAY's behaviour. When the gap closes, the expectations marked "today" become
 * `'REDACTED'`, and the file's title loses its first two words.
 *
 * Test type: security scenario (known-gap witness).
 */
import type { CommitValuesMode } from 'foottrace';
import { stateAt } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;

const TOKEN = 't-123-SECRET';
const USER = 'ada-SECRET';

async function run(commitValues: CommitValuesMode) {
  const refresh = flowChart<S>(
    'Refresh',
    (s) => {
      s.done = true;
    },
    'refresh',
  ).build();
  const chart = flowChart<S>(
    'Login',
    (s) => {
      s.session = { token: TOKEN, user: USER };
      s.profile = { name: 'Ada', email: 'ada@example.org' };
    },
    'login',
  )
    .addSubFlowChart('mount', refresh, 'Mount', {
      inputMapper: () => ({}),
      // One new field for each object. The engine writes each at a path inside its key.
      outputMapper: () => ({ session: { refreshed: true }, profile: { seen: 1 } }),
    } as never)
    .build();
  const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
  executor.setRedactionPolicy({ keys: ['session'], fields: { profile: ['email'] } });
  await executor.run();
  return { plain: executor.getSnapshot(), redacted: executor.getSnapshot({ redact: true }) };
}

describe.each(['full', 'delta'] as const)('a field added inside a wholly hidden value (%s)', (commitValues) => {
  it('KNOWN GAP: the redacted views show the hidden value as an object with only the added field', async () => {
    const { plain, redacted } = await run(commitValues);

    // What is really there: three fields.
    expect(plain.sharedState.session).toEqual({ token: TOKEN, user: USER, refreshed: true });

    // After Login the log says the whole value is hidden. That is right.
    const login = plain.commitLog.findIndex((bundle) => bundle.stageId === 'login');
    expect((stateAt(plain, login).state as S).session).toBe('REDACTED');

    // The mount's row is on a path inside the key, and the value at that path is scrubbed.
    const inside = 'session\u001frefreshed';
    const mount = plain.commitLog.findIndex((bundle) => bundle.trace.some((row) => row.path === inside));
    expect(mount).toBeGreaterThan(login);
    expect(plain.commitLog[mount].redactedPaths).toContain(inside);

    // Today: from that stop on, both redacted views show one field, and no sign that the rest is hidden.
    expect((stateAt(plain, mount).state as S).session).toEqual({ refreshed: 'REDACTED' });
    expect(redacted.sharedState.session).toEqual({ refreshed: 'REDACTED' });
  });

  it('nothing secret is shown: not in the redacted snapshot, and not in what the plain one keeps beside state', async () => {
    const { plain, redacted } = await run(commitValues);
    // Everything served under the policy: the whole redacted snapshot, and the plain snapshot without
    // its live state (the live heap is the caller's own values, which no policy covers).
    const { sharedState: _live, ...keptBesideState } = plain;
    const served = JSON.stringify([redacted, keptBesideState]);
    expect(served).not.toContain(TOKEN);
    expect(served).not.toContain(USER);
    expect(served).not.toContain('ada@example.org');
    // The value of the added field is hidden as well: the key is hidden as a whole.
    expect(served).not.toContain('"refreshed":true');
  });

  it('a value with ONE hidden field is not affected: the added field joins the fields already shown', async () => {
    const { plain, redacted } = await run(commitValues);
    const shown = { name: 'Ada', email: 'REDACTED', seen: 1 };
    expect(redacted.sharedState.profile).toEqual(shown);
    expect((stateAt(plain, plain.commitLog.length - 1).state as S).profile).toEqual(shown);
  });
});
