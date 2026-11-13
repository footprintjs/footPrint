/**
 * One line of `runs.jsonl` per run: what the report reads (report.mjs for
 * part 1, report2.mjs for part 2). One owner for the fields of a row.
 *
 * Every row: `setup`, the task (`fault` in part 1's rows; `task` and
 * `taskType` in every row written now, `fault` kept on a fault's row so part
 * 1's report reads it), `program`, `repeat`, `model`, `solved` (the task
 * done right: the edit fixes every hidden order, or the answer equals the
 * expected one), `stopReason`, the token counts with `newTokens` and
 * `resentTokens` (harness/tokens.mjs), the tool counts, `transcript`.
 * A fault row adds part 1's scoring fields; a question row adds `kind`,
 * `fixture`, `answered`, `answer`, `expected`, `answerProblem` and the files
 * the agent changed (`editedFiles`: prints it added, for instance).
 * Gone since part 2: `namedFaultyStep` (harness/score.mjs says why).
 * Example: `{ setup: 3, task: 'run-tax-rate', taskType: 'question', solved: true, answer: 6, … }`.
 */
import { retriedFrom } from './retries.mjs';
import { newAndResent } from './tokens.mjs';

/** The fields every finished run has. */
function common({ item, program, model, counts, transcript }) {
  return {
    setup: item.setup, program: program.id, repeat: item.repeat, model: model.name,
    stopReason: counts.stopReason, error: counts.error,
    requests: counts.requests, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, thinkingTokens: counts.thinkingTokens,
    newTokens: counts.newTokens, resentTokens: counts.resentTokens, retries: counts.retries, requestsWithoutUsage: counts.requestsWithoutUsage ?? 0, retried: counts.retried ?? [],
    largestRequestTokens: counts.largestRequestTokens, finalContextTokens: counts.finalContextTokens, toolCalls: counts.toolCalls, toolErrors: counts.toolErrors,
    readFileChars: counts.readFileChars, runOrderCalls: counts.toolCalls.run_order ?? 0, runTestsCalls: counts.toolCalls.run_tests ?? 0, edits: counts.edits,
    wallMs: counts.wallMs, transcript,
  };
}

/** A fault's row. */
export function faultRow({ item, task, program, model, counts, score, transcript }) {
  const base = common({ item, program, model, counts, transcript });
  return {
    setup: base.setup, ...(item.task !== undefined ? { task: task.id } : {}), taskType: 'fault', fault: task.id,
    faultClass: task.class, inDecision: task.inDecision, distance: task.distance,
    ...base,
    solved: counts.stopReason === 'error' ? false : score.solved,
    editedFaultyFile: score.editedFaultyFile, editedFiles: score.editedFiles,
    changedOutsideSrc: score.changedOutsideSrc, wrongFixtures: score.wrongFixtures, scoringProblem: score.scoringProblem,
    doneSummary: counts.doneSummary,
  };
}

/** A question's row. */
export function questionRow({ item, task, program, model, counts, score, editedFiles, transcript }) {
  const base = common({ item, program, model, counts, transcript });
  return {
    setup: base.setup, task: task.id, taskType: 'question', kind: task.kind, fixture: task.fixture ?? null,
    ...base,
    solved: counts.stopReason === 'error' ? false : score.solved,
    answered: counts.answered, answer: counts.answered ? (counts.answer ?? null) : null,
    expected: score.expected, answerProblem: score.answerProblem, editedFiles,
  };
}

/**
 * The row of a run that started and never finished (batch.mjs ·
 * interruptedRow): its tokens are what its transcript holds.
 * What is recoverable (RULE-2.md, "Changed after the fairness readings":
 * what the harness can record of an unfinished run): the usage of every
 * request whose response was logged.
 * What is not: a request in flight when the harness stopped (a `request`
 * line with no `response` after it; counted in `requestsWithoutUsage`), and
 * everything, when the transcript itself is missing (`tokensKnown: false`).
 * @param {any} started a line of started.jsonl @param {any} task the task, when loaded
 * @param {any[] | null} events the transcript's events, or null when the transcript is missing
 */
export function unfinishedRow(started, task, events) {
  const usages = (events ?? []).filter((e) => e.type === 'response').map((e) => e.usage ?? {});
  const requested = (events ?? []).filter((e) => e.type === 'request').length;
  const last = usages.at(-1) ?? {};
  const isQuestion = (started.taskType ?? (task?.type === 'question' ? 'question' : 'fault')) === 'question';
  const id = started.task ?? started.fault;
  return {
    setup: started.setup,
    ...(started.task !== undefined ? { task: id } : {}),
    taskType: isQuestion ? 'question' : 'fault',
    ...(isQuestion
      ? { kind: task?.kind ?? null, fixture: task?.fixture ?? null }
      : { fault: id, faultClass: task?.class ?? null, inDecision: task?.inDecision ?? null, distance: task?.distance ?? null }),
    repeat: started.repeat, model: started.model ?? null, solved: false,
    stopReason: 'interrupted', error: 'the harness stopped before the run finished',
    requests: usages.length,
    inputTokens: usages.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0),
    outputTokens: usages.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0),
    ...newAndResent(usages),
    requestsWithoutUsage: Math.max(0, requested - usages.length),
    retries: (events ?? []).filter((e) => e.type === 'retry').length,
    retried: retriedFrom(events ?? []),
    tokensKnown: events !== null,
    finalContextTokens: (last.input_tokens ?? 0) + (last.output_tokens ?? 0),
    transcript: started.transcript,
  };
}
