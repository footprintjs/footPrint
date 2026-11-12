import type { Job, Step, Workflow } from './workflowRules';

/**
 * Test-only admission of the release hold check (footprintjs/ci docs/HOLD.md): nothing publishes
 * while an open issue or pull request carries the label `hold-release`.
 *
 * WHY each rule exists, in the order a release meets them:
 * - the check is code from ANOTHER repository running in the job that holds `id-token: write`, so
 *   it is pinned to one reviewed full commit, never a branch or tag (a moved tag would change what
 *   runs at the moment of publication);
 * - the `hold` job is the early signal but does not run again on "Re-run failed jobs" (a green
 *   job is reused), so the step directly before the publish step is what holds;
 * - a check that can be skipped is not a check: no `if:` and no `continue-on-error` on the jobs
 *   or steps between the hold and the publication, and no `token:` input (the job's own token
 *   is the only one the step may receive).
 */

/** The reviewed footprintjs/ci commit. The job's `uses:` and `tool_sha` and the step must all be this. */
export const HOLD_SHA = 'b14f372d4c26e9f3059068b250544aa320b834aa';
export const HOLD_WORKFLOW = `footprintjs/ci/.github/workflows/hold.yml@${HOLD_SHA}`;
export const HOLD_ACTION = `footprintjs/ci/.github/actions/hold@${HOLD_SHA}`;

/** A job that calls a reusable workflow has `uses:` and `with:` instead of steps. */
interface CallJob {
  if?: unknown;
  needs?: string | string[];
  permissions?: Record<string, string> | 'read-all' | 'write-all';
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  env?: unknown;
  ['continue-on-error']?: unknown;
}

const READ_ONLY = { contents: 'read', issues: 'read', 'pull-requests': 'read' };
const needsOf = (job: { needs?: string | string[] } | undefined): string[] =>
  job?.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];

/** Jobs that `name` waits for, directly or through other jobs. */
function reaches(jobs: Record<string, { needs?: string | string[] }>, name: string, target: string): boolean {
  const seen = new Set<string>();
  const walk = (current: string): boolean => {
    if (seen.has(current)) return false;
    seen.add(current);
    return needsOf(jobs[current]).some((next) => next === target || walk(next));
  };
  return walk(name);
}

function callProblems(job: CallJob | undefined, mode: string, label: string): string[] {
  const problems: string[] = [];
  const require = (ok: unknown, rule: string) => {
    if (!ok) problems.push(`${label}:${rule}`);
  };
  require(job !== undefined, 'present');
  if (!job) return problems;
  require(job.uses === HOLD_WORKFLOW, 'uses-reviewed-sha');
  require(JSON.stringify(job.with) === JSON.stringify({ tool_sha: HOLD_SHA, mode }), 'with-same-sha-and-mode-only');
  require(job.permissions !== undefined &&
    JSON.stringify(job.permissions) === JSON.stringify(READ_ONLY), 'permissions-read-only-exact');
  require(job.secrets === undefined && job.env === undefined, 'no-secrets-or-env');
  require(job['continue-on-error'] === undefined || job['continue-on-error'] === false, 'not-allowed-to-fail');
  return problems;
}

/** The publish workflow: the `hold` job first, and the step directly before the publication. */
export function publishHoldProblems(release: Workflow): string[] {
  const problems = callProblems(release.jobs.hold as unknown as CallJob, 'publish', 'hold:job');
  const require = (ok: unknown, rule: string) => {
    if (!ok) problems.push(rule);
  };
  const hold = release.jobs.hold as unknown as CallJob | undefined;
  const publishing = release.jobs.publish;
  require(Object.keys(release.jobs)[0] === 'hold', 'hold:job-first');
  require(hold !== undefined && needsOf(hold).length === 0 && hold.if === undefined, 'hold:job-unconditional');
  // The early signal reaches every job that leads to the publish, through the jobs that already need it.
  require(reaches(release.jobs, 'publish', 'hold'), 'hold:publish-needs-hold');
  require(reaches(release.jobs, 'build', 'hold'), 'hold:build-needs-hold');
  // A job that may be skipped or ignored on failure would let the publish run without its gate.
  for (const name of ['build', 'publish'])
    for (const field of ['if', 'continue-on-error'] as const)
      require((release.jobs[name] as unknown as CallJob)?.[field] === undefined, `hold:no-${field}-on-${name}`);
  if (!publishing) return problems;
  const permissions = publishing.permissions;
  require(typeof permissions === 'object' && permissions['issues'] === 'read', 'hold:step-permission-issues-read');
  require(typeof permissions === 'object' &&
    permissions['pull-requests'] === 'read', 'hold:step-permission-pull-requests-read');
  const steps: Step[] = publishing.steps;
  const holds = steps.filter((step) => step.uses?.startsWith('footprintjs/ci/'));
  require(holds.length === 1 && holds[0].uses === HOLD_ACTION, 'hold:step-uses-reviewed-sha');
  const step = holds[0];
  const publication = steps.findIndex((s) => s.run?.trim().endsWith('run.sh" publish'));
  require(step && publication >= 0 && steps.indexOf(step) === publication - 1, 'hold:step-last-before-publish');
  // The step takes the job's own token by the action's default: no input at all.
  require(step && step.with === undefined && step.env === undefined, 'hold:step-no-token-input');
  for (const guarded of [step, steps[publication]]) {
    if (!guarded) continue;
    require(guarded.if === undefined, 'hold:step-unconditional');
    require(guarded['continue-on-error'] === undefined ||
      guarded['continue-on-error'] === false, 'hold:step-not-allowed-to-fail');
  }
  return problems;
}

/** The pull-request workflow: its own job, no dependants, only for the `pull_request` event. */
export function pullRequestHoldProblems(ci: Workflow): string[] {
  const problems = callProblems(ci.jobs.hold as unknown as CallJob, 'pull-request', 'hold:pr-job');
  const require = (ok: unknown, rule: string) => {
    if (!ok) problems.push(rule);
  };
  const hold = ci.jobs.hold as unknown as CallJob | undefined;
  // `pull-request` mode refuses every other event, so the `push` run of the workflow must skip it.
  require(hold?.if === "github.event_name == 'pull_request'", 'hold:pr-job-only-on-pull-request');
  require(hold !== undefined && needsOf(hold).length === 0, 'hold:pr-job-needs-nothing');
  for (const [name, job] of Object.entries(ci.jobs as Record<string, Job>))
    require(name === 'hold' || !needsOf(job).includes('hold'), `hold:pr-job-blocks-nothing:${name}`);
  return problems;
}
