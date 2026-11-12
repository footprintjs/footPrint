/**
 * What the two files on "a hidden object keeps its rule wherever a stage puts it" share: one hidden
 * value, a run under a policy with a recorder that turns every event into text at once, and the three
 * views a test asks (the real state, the state as it is shown, everything the run keeps or serves).
 *
 * Not a test: `redaction-follows-a-hidden-object.test.ts` and
 * `redaction-follows-what-a-stage-puts-in-later.test.ts` import it.
 */
import type { CommitValuesMode } from 'foottrace';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

export type S = Record<string, any> & {
  $getValue(key: string): any;
  $setValue(key: string, value: unknown): void;
  $update(key: string, value: unknown): void;
};

export const SECRET = 'sk-live-SUPER-SECRET-BYTES';
export const KEYS = { keys: ['secret'] };
export const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

/** What a recorder was handed at each read, write and commit, turned into text AT ONCE, as a log sink does. */
export const events = new WeakMap<object, string[]>();

/**
 * Everything the run keeps or serves under the policy, as one text: the log, what each stage kept of its
 * reads and writes (the execution tree), the whole redacted snapshot, and every event a recorder was
 * handed while the run went on. Not the plain live state: that is real by design.
 */
export function served(executor: FlowChartExecutor<never, never>): string {
  const plain = executor.getSnapshot();
  return JSON.stringify([
    plain.commitLog,
    plain.executionTree,
    executor.getSnapshot({ redact: true }),
    events.get(executor) ?? [],
  ]);
}

export async function run(chart: unknown, commitValues: CommitValuesMode, policy: object = KEYS, input?: object) {
  const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
  executor.setRedactionPolicy(policy as never);
  const seen: string[] = [];
  events.set(executor, seen);
  const keep = (event: unknown) => {
    seen.push(JSON.stringify(event, (_key, value) => (value instanceof Map ? [...value] : value)));
  };
  executor.attachScopeRecorder({ id: 'sink', onRead: keep, onWrite: keep, onCommit: keep });
  await executor.run(input === undefined ? undefined : ({ input } as never));
  return executor as FlowChartExecutor<never, never>;
}

/** Stage `A` writes the hidden value and a public record `a`. What follows is the test's. */
export const start = (secret: unknown) =>
  flowChart<S>(
    'A',
    (s) => {
      s.secret = secret;
      s.a = { x: 1 };
    },
    'a',
  );

export const live = (executor: FlowChartExecutor<never, never>) =>
  executor.getSnapshot().sharedState as Record<string, any>;
export const shown = (executor: FlowChartExecutor<never, never>) =>
  executor.getSnapshot({ redact: true }).sharedState as Record<string, any>;
