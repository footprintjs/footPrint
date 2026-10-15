/**
 * P1a (10.1) — the named change the untagged 9.20.0 reference predates: a stage with a declared retry policy
 * carries its attempt evidence (design docs/design/2026-10-time-and-failure-evidence.md, §5, §8, §9).
 *
 *   - its execution-tree node gains `attempts` (one record per attempt, with the retry-or-stop decision) and
 *     `attemptSummary` — placed after `flowMessages`, before `next`;
 *   - its narrative renders ONE `'attempt'` line per attempt instead of the 9.15 `'retry'` line: the two retry
 *     entries become the first two attempt lines (same step numbers), and the successful third attempt adds one.
 *
 * The commit log, the fold base, the checkpoint and every other byte stay 9.20.0's. A reference is never
 * regenerated (it exists to be old), so the correction is written out here, by hand — an oracle independent of
 * the code that makes the records. A narrative duration is the clock's, so the build's text is settled to
 * `«ms»` before the comparison (`withSettledAttemptDurations`); `startedAt` / `durationMs` are dropped by
 * `stableJSON` like every other clock field.
 */

type Json = Record<string, unknown>;

/** A filter row of the retry rule table, as `decide()` records it. */
function filterRow(
  ruleIndex: number,
  branch: string,
  label: string,
  key: string,
  op: string,
  threshold: unknown,
  actualSummary: string,
  matched: boolean,
): Json {
  return {
    type: 'filter',
    ruleIndex,
    branch,
    matched,
    label,
    conditions: [{ key, op, threshold, actualSummary, result: matched, redacted: false }],
  };
}

/** The six unmatched rows of a failed attempt `n` of 3 that is retried. */
function retriedRows(n: number): Json[] {
  return [
    filterRow(0, 'done', 'succeeded', 'outcome', 'eq', 'ok', '"failed"', false),
    filterRow(1, 'stop', 'paused', 'outcome', 'eq', 'paused', '"failed"', false),
    filterRow(2, 'stop', 'aborted', 'aborted', 'eq', true, 'false', false),
    filterRow(3, 'stop', 'exhausted', 'attempt', 'gte', 3, String(n), false),
    {
      type: 'function',
      ruleIndex: 4,
      branch: 'stop',
      matched: false,
      label: 'declined',
      inputs: [{ key: 'retryOn', valueSummary: 'true', redacted: false }],
    },
    filterRow(5, 'stop', 'no-time-left', 'timeLeftAfterWaitMs', 'lte', 0, 'Infinity', false),
  ];
}

const DECISION_TAIL = { default: 'retry', defaultLabel: 'retryable' };

/** The fixture's Flaky stage (`flaky#2`): fails twice ("flaky attempt n"), succeeds on the third of three. */
const FLAKY_ATTEMPTS: Json[] = [
  ...[1, 2].map((n) => ({
    series: 'flaky#2',
    kind: 'stage',
    attempt: n,
    of: 3,
    outcome: 'failed',
    category: 'unknown',
    decision: { rules: retriedRows(n), chosen: 'retry', ...DECISION_TAIL },
    next: 'retry',
    reason: 'retryable',
    delayMs: 0,
    error: { message: `flaky attempt ${n}`, name: 'Error' },
  })),
  {
    series: 'flaky#2',
    kind: 'stage',
    attempt: 3,
    of: 3,
    outcome: 'ok',
    decision: {
      rules: [filterRow(0, 'done', 'succeeded', 'outcome', 'eq', 'ok', '"ok"', true)],
      chosen: 'done',
      ...DECISION_TAIL,
    },
    next: 'done',
    reason: 'succeeded',
  },
];

const FLAKY_SUMMARY: Json = {
  count: 3,
  ok: 1,
  failed: 2,
  timeout: 0,
  aborted: 0,
  paused: 0,
  last: { next: 'done', reason: 'succeeded' },
};

const attemptLine = (text: string, stepNumber: number): Json => ({
  type: 'attempt',
  text,
  depth: 1,
  stageName: 'Flaky',
  stageId: 'flaky',
  runtimeStageId: 'flaky#2',
  stepNumber,
});

/** The node `id` in an execution tree (`next` / `children`), or undefined. */
function findNode(tree: unknown, id: string): Json | undefined {
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as Json | undefined;
    if (!node || typeof node !== 'object') continue;
    if (node.id === id) return node;
    stack.push(node.next, ...((node.children as unknown[]) ?? []));
  }
  return undefined;
}

/** Re-key `node` with `attempts` / `attemptSummary` inserted where `snapshotSelf` writes them: before `next`. */
function withAttemptsOnNode(node: Json): void {
  const entries = Object.entries(node);
  for (const key of Object.keys(node)) delete node[key];
  for (const [key, value] of entries) {
    if (key === 'next') {
      node.attempts = FLAKY_ATTEMPTS;
      node.attemptSummary = FLAKY_SUMMARY;
    }
    node[key] = value;
  }
  if (!Object.prototype.hasOwnProperty.call(node, 'attempts')) {
    node.attempts = FLAKY_ATTEMPTS;
    node.attemptSummary = FLAKY_SUMMARY;
  }
}

/** Apply the P1a change to the paused leg of the parsed 9.20.0 reference (the resumed leg has no retried stage). */
export function withAttemptEvidence(reference: { paused: { executionTree: unknown; narrative: Json[] } }): void {
  const flaky = findNode(reference.paused.executionTree, 'flaky');
  if (!flaky) throw new Error('P1a correction: the reference has no flaky node');
  withAttemptsOnNode(flaky);

  const narrative: Json[] = [];
  for (const entry of reference.paused.narrative) {
    if (entry.type === 'retry' && entry.stageId === 'flaky') {
      const n = entry.stepNumber === 2 ? 1 : 2;
      narrative.push(
        attemptLine(
          `Attempt ${n} of 3 at Flaky failed in «ms» (flaky attempt ${n}), retrying immediately.`,
          entry.stepNumber as number,
        ),
      );
      continue;
    }
    narrative.push(entry);
    if (entry.runtimeStageId === 'flaky#2' && entry.text === 'Step 5: Write attempts = 3') {
      narrative.push(attemptLine('Attempt 3 of 3 at Flaky succeeded in «ms».', 6));
    }
  }
  if (narrative.length !== reference.paused.narrative.length + 1) {
    throw new Error('P1a correction: the reference narrative did not have the two retry lines it should');
  }
  reference.paused.narrative = narrative;
}

/** A narrative attempt line's duration is the clock's: settle it in the build's JSON text. */
export function withSettledAttemptDurations(json: string): string {
  return json.replace(
    /(Attempt \d+ of \d+ at [^"]*?(?:succeeded in|failed in|timed out after|paused after|was aborted after) )\d+(?:\.\d+)?m?s/g,
    '$1«ms»',
  );
}
