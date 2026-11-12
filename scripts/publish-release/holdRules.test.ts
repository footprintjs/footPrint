import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { HOLD_ACTION, HOLD_SHA, HOLD_WORKFLOW, publishHoldProblems, pullRequestHoldProblems } from './holdRules';
import type { Workflow } from './workflowRules';

// The real files, not a fixture copy: the rule is about what actually runs at release time.
const release = parse(readFileSync(resolve('.github/workflows/publish.yml'), 'utf8')) as Workflow;
const ci = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')) as Workflow;
// The hold job calls a reusable workflow: no steps, so it is reached as plain data.
type Call = Record<string, any>;
const call = (w: Workflow, name = 'hold') => w.jobs[name] as unknown as Call;
const steps = (w: Workflow) => w.jobs.publish.steps;
const holdStep = (w: Workflow) => steps(w).find((s) => s.uses?.startsWith('footprintjs/ci/'))!;
const publication = (w: Workflow) => steps(w).find((s) => s.run?.trim().endsWith('run.sh" publish'))!;

it('the pinned commit is a full SHA, and the real workflows use it for every pin', () => {
  expect(HOLD_SHA).toMatch(/^[a-f0-9]{40}$/);
  expect(publishHoldProblems(release)).toEqual([]);
  expect(pullRequestHoldProblems(ci)).toEqual([]);
  expect(call(release).uses).toBe(HOLD_WORKFLOW);
  expect(holdStep(release).uses).toBe(HOLD_ACTION);
});

type Change = (workflow: Workflow) => void;
const publishCorruptions: [string, string, Change][] = [
  [
    'job pinned to a branch',
    'hold:job:uses-reviewed-sha',
    (w) => (call(w).uses = 'footprintjs/ci/.github/workflows/hold.yml@main'),
  ],
  [
    'job pinned to another commit',
    'hold:job:uses-reviewed-sha',
    (w) => (call(w).uses = `footprintjs/ci/.github/workflows/hold.yml@${'a'.repeat(40)}`),
  ],
  [
    'job tool_sha drifts from the uses pin',
    'hold:job:with-same-sha-and-mode-only',
    (w) => (call(w).with.tool_sha = 'a'.repeat(40)),
  ],
  ['job runs in the wrong mode', 'hold:job:with-same-sha-and-mode-only', (w) => (call(w).with.mode = 'pull-request')],
  ['job gets an extra input', 'hold:job:with-same-sha-and-mode-only', (w) => (call(w).with.token = 'x')],
  ['job loses its permissions', 'hold:job:permissions-read-only-exact', (w) => delete call(w).permissions],
  [
    'job is given write power',
    'hold:job:permissions-read-only-exact',
    (w) => (call(w).permissions = { ...call(w).permissions, 'id-token': 'write' }),
  ],
  ['job receives a secret', 'hold:job:no-secrets-or-env', (w) => (call(w).secrets = 'inherit')],
  ['job may fail without blocking', 'hold:job:not-allowed-to-fail', (w) => (call(w)['continue-on-error'] = true)],
  ['job removed', 'hold:job:present', (w) => delete w.jobs.hold],
  [
    'job no longer first',
    'hold:job-first',
    (w) => {
      const { hold, ...rest } = w.jobs as Record<string, any>;
      w.jobs = { ...rest, hold };
    },
  ],
  ['job made conditional', 'hold:job-unconditional', (w) => (call(w).if = "github.event_name == 'never'")],
  ['job waits for build', 'hold:job-unconditional', (w) => (call(w).needs = 'build')],
  ['build stops waiting for the hold', 'hold:build-needs-hold', (w) => delete w.jobs.build.needs],
  ['publish stops reaching the hold', 'hold:publish-needs-hold', (w) => delete w.jobs.publish.needs],
  ['publish runs whatever happened before', 'hold:no-if-on-publish', (w) => (w.jobs.publish.if = '${{ always() }}')],
  ['build runs whatever happened before', 'hold:no-if-on-build', (w) => (w.jobs.build.if = '${{ always() }}')],
  [
    'publish allowed to fail',
    'hold:no-continue-on-error-on-publish',
    (w) => ((w.jobs.publish as unknown as Call)['continue-on-error'] = true),
  ],
  [
    'publish loses issues: read',
    'hold:step-permission-issues-read',
    (w) => delete (w.jobs.publish.permissions as any).issues,
  ],
  [
    'publish loses pull-requests: read',
    'hold:step-permission-pull-requests-read',
    (w) => delete (w.jobs.publish.permissions as any)['pull-requests'],
  ],
  [
    'step removed',
    'hold:step-uses-reviewed-sha',
    (w) => (w.jobs.publish.steps = steps(w).filter((s) => s !== holdStep(w))),
  ],
  [
    'step pinned to a tag',
    'hold:step-uses-reviewed-sha',
    (w) => (holdStep(w).uses = 'footprintjs/ci/.github/actions/hold@v1'),
  ],
  [
    'step pinned to another commit',
    'hold:step-uses-reviewed-sha',
    (w) => (holdStep(w).uses = `footprintjs/ci/.github/actions/hold@${'c'.repeat(40)}`),
  ],
  [
    'step moved away from the publication',
    'hold:step-last-before-publish',
    (w) => {
      const s = steps(w);
      const [removed] = s.splice(s.indexOf(holdStep(w)), 1);
      s.unshift(removed);
    },
  ],
  [
    'step after the publication',
    'hold:step-last-before-publish',
    (w) => {
      const s = steps(w);
      const a = s.indexOf(holdStep(w));
      const b = s.indexOf(publication(w));
      [s[a], s[b]] = [s[b], s[a]];
    },
  ],
  [
    'step given another token',
    'hold:step-no-token-input',
    (w) => (holdStep(w).with = { token: '${{ secrets.PERSONAL }}' }),
  ],
  ['step given an environment', 'hold:step-no-token-input', (w) => (holdStep(w).env = { GH_TOKEN: 'x' })],
  ['step skipped by a condition', 'hold:step-unconditional', (w) => (holdStep(w).if = '${{ false }}')],
  ['step allowed to fail', 'hold:step-not-allowed-to-fail', (w) => (holdStep(w)['continue-on-error'] = true)],
  ['publication runs after a failure', 'hold:step-unconditional', (w) => (publication(w).if = '${{ always() }}')],
  ['publication allowed to fail', 'hold:step-not-allowed-to-fail', (w) => (publication(w)['continue-on-error'] = true)],
  // The class "publishes" (publishingSteps.ts): the second reader's three surviving mutations.
  [
    'M18: the route helper publishes inside a multi-line step BEFORE the hold step',
    'hold:publish-text-in-one-step',
    (w) =>
      steps(w).splice(steps(w).indexOf(holdStep(w)), 0, {
        run: 'bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh" publish\necho done',
      }),
  ],
  [
    'M22: `env npm publish` in a step BEFORE the hold step',
    'hold:publish-text-in-one-step',
    (w) =>
      steps(w).splice(steps(w).indexOf(holdStep(w)), 0, { run: 'env npm publish "$ARTIFACT_DIRECTORY/package.tgz"' }),
  ],
  [
    'M19: a second job publishes with a token secret',
    'hold:publish-text-only-in-publish-job',
    (w) => {
      (w.jobs as Record<string, any>).side = {
        'runs-on': 'ubuntu-latest',
        steps: [{ run: 'npm publish', env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' } }],
      };
    },
  ],
  [
    'M19: the same second job also breaks "one step"',
    'hold:publish-text-in-one-step',
    (w) => {
      (w.jobs as Record<string, any>).side = { steps: [{ run: 'npm publish' }] };
    },
  ],
  [
    'the helper publishes a second time AFTER the first',
    'hold:publish-text-in-one-step',
    (w) => steps(w).push({ run: 'bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh" publish' }),
  ],
  [
    'a pnpm publish in the build job',
    'hold:publish-text-only-in-publish-job',
    (w) => w.jobs.build.steps.push({ run: 'pnpm publish' }),
  ],
];

const pullRequestCorruptions: [string, string, Change][] = [
  ['job removed', 'hold:pr-job:present', (w) => delete w.jobs.hold],
  [
    'job pinned to a tag',
    'hold:pr-job:uses-reviewed-sha',
    (w) => (call(w).uses = 'footprintjs/ci/.github/workflows/hold.yml@v1'),
  ],
  ['job runs in the publish mode', 'hold:pr-job:with-same-sha-and-mode-only', (w) => (call(w).with.mode = 'publish')],
  ['job loses its own permissions', 'hold:pr-job:permissions-read-only-exact', (w) => delete call(w).permissions],
  ['job runs on push too', 'hold:pr-job-only-on-pull-request', (w) => delete call(w).if],
  ['job waits for another job', 'hold:pr-job-needs-nothing', (w) => (call(w).needs = 'test')],
  [
    'another job waits for it',
    'hold:pr-job-blocks-nothing:test',
    (w) => ((w.jobs.test as unknown as Call).needs = 'hold'),
  ],
];

describe('each hold rule is independently observable', () => {
  it.each(publishCorruptions)('publish workflow: %s', (_name, rule, change) => {
    // A broken baseline cannot make a negative control pass vacuously.
    expect(publishHoldProblems(release)).toEqual([]);
    const bad = structuredClone(release);
    change(bad);
    expect(publishHoldProblems(bad)).toContain(rule);
  });

  it.each(pullRequestCorruptions)('pull-request workflow: %s', (_name, rule, change) => {
    expect(pullRequestHoldProblems(ci)).toEqual([]);
    const bad = structuredClone(ci);
    change(bad);
    expect(pullRequestHoldProblems(bad)).toContain(rule);
  });
});
