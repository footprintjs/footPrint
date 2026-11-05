import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { expect, it } from 'vitest';
import { parse } from 'yaml';

import { minimalChildEnv } from '../../test/helpers/childProcessEnv';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: unknown;
  shell?: string;
  ['continue-on-error']?: unknown;
};
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      if?: unknown;
      ['continue-on-error']?: unknown;
      steps: Step[];
    }
  >;
};
type Observation = { command: string; args: string[]; input?: string; cwd?: string };

const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')) as Workflow;
const stepName = 'Check workflow syntax and expression contexts';
const version = '1.7.12';
// Pinned official actionlint_1.7.12_linux_amd64.tar.gz checksum, not a computed fixture digest.
const checksum = '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
const url = `https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz`;
const workflowArguments = [
  '.github/workflows/publish.yml',
  '.github/workflows/docs.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/foottrace-candidate.yml',
];

function requiredStep(value: Workflow): Step {
  const job = value.jobs.lint;
  expect(job, 'the required lint job exists').toBeDefined();
  expect(job.if, 'lint must run unconditionally').toBeUndefined();
  expect([undefined, false], 'lint cannot ignore failure').toContain(job['continue-on-error']);
  const candidates = job.steps.filter((step) => step.name === stepName);
  expect(candidates, 'exactly one workflow syntax check is required').toHaveLength(1);
  const step = candidates[0];
  expect(step.if, 'the syntax check cannot be skipped').toBeUndefined();
  expect([undefined, false], 'the syntax check cannot ignore failure').toContain(step['continue-on-error']);
  expect([undefined, 'bash'], 'the checked shell body runs in bash').toContain(step.shell);
  expect(step.uses).toBeUndefined();
  expect(typeof step.run).toBe('string');
  expect(step.run?.trim().length).toBeGreaterThan(0);
  expect(step.env?.ACTIONLINT_VERSION).toBe(version);
  expect(step.env?.ACTIONLINT_SHA256).toBe(checksum);
  return step;
}

// These inert commands model process results and log arguments. They do not
// download, hash, unpack or run actionlint. Only the actual CI shell body runs.
function shellFixture(step: Step, rejectChecksum: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fp actionlint step ')));
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace');
  const temporary = join(root, 'runner temporary');
  const log = join(root, 'commands.jsonl');
  const lintStub = join(root, 'actionlint-stub');
  const executable = (path: string, body: string) => {
    writeFileSync(path, '#!/usr/bin/env node\n' + body);
    chmodSync(path, 0o700);
  };
  try {
    for (const path of [bin, workspace, temporary]) mkdirSync(path);
    const record = `const fs = require('node:fs');
const args = process.argv.slice(2);
const record = (row) => fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(row) + '\\n');
`;
    executable(
      join(bin, 'curl'),
      record +
        `
record({ command: 'download', args });
const output = args[args.indexOf('--output') + 1];
if (!output || args.indexOf('--output') < 0) process.exit(81);
fs.writeFileSync(output, 'inert archive bytes, never downloaded or extracted');
`,
    );
    executable(
      join(bin, 'sha256sum'),
      record +
        `
record({ command: 'checksum', args, input: fs.readFileSync(0, 'utf8') });
process.exit(process.env.REJECT_CHECKSUM === 'yes' ? 1 : 0);
`,
    );
    executable(
      join(bin, 'tar'),
      record +
        `
record({ command: 'extract', args });
const directory = args[args.indexOf('-C') + 1];
if (!directory || args.indexOf('-C') < 0) process.exit(82);
const target = require('node:path').join(directory, 'actionlint');
fs.copyFileSync(process.env.ACTIONLINT_STUB, target);
fs.chmodSync(target, 0o700);
`,
    );
    executable(
      lintStub,
      record +
        `
record({ command: 'lint', args, cwd: process.cwd() });
`,
    );
    const base = minimalChildEnv(process.env);
    const result = spawnSync('bash', ['-c', step.run!], {
      cwd: workspace,
      env: {
        ...base,
        ...workflow.env,
        ...workflow.jobs.lint.env,
        ...step.env,
        PATH: [bin, base.PATH].filter(Boolean).join(delimiter),
        RUNNER_TEMP: temporary,
        PROBE_LOG: log,
        ACTIONLINT_STUB: lintStub,
        REJECT_CHECKSUM: rejectChecksum ? 'yes' : 'no',
      },
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const observations: Observation[] = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
    return { result, observations, workspace, temporary };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('CI requires one active checksum-pinned actionlint step in the lint job', () => {
  const step = requiredStep(workflow);
  const steps = workflow.jobs.lint.steps;
  const checkout = steps.findIndex((candidate) => candidate.uses?.startsWith('actions/checkout@'));
  const setup = steps.findIndex((candidate) => candidate.uses?.startsWith('actions/setup-node@'));
  expect(checkout).toBeGreaterThanOrEqual(0);
  expect(steps.indexOf(step)).toBe(checkout + 1);
  expect(setup).toBeGreaterThan(steps.indexOf(step));
});

it('the actual CI shell checks the pinned archive before extraction and lints exactly four workflows', () => {
  const { result, observations, workspace, temporary } = shellFixture(requiredStep(workflow), false);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(observations.map((row) => row.command)).toEqual(['download', 'checksum', 'extract', 'lint']);
  const [download, verified, extracted, lint] = observations;
  const archive = download.args[download.args.indexOf('--output') + 1];
  expect(archive.startsWith(temporary + '/')).toBe(true);
  expect(download.args).toEqual(['--fail', '--silent', '--show-error', '--location', url, '--output', archive]);
  expect(verified.args).toEqual(['--check', '--strict', '-']);
  expect(verified.input).toBe(`${checksum}  ${archive}\n`);
  const directory = extracted.args[extracted.args.indexOf('-C') + 1];
  expect(archive).toBe(join(directory, 'actionlint.tar.gz'));
  expect(extracted.args).toEqual(['-xzf', archive, '-C', directory, 'actionlint']);
  expect(lint.args).toEqual(['-shellcheck=', '-pyflakes=', ...workflowArguments]);
  expect(lint.cwd).toBe(workspace);
});

it('a simulated checksum failure stops the actual CI shell before extraction or lint invocation', () => {
  const { result, observations } = shellFixture(requiredStep(workflow), true);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBe(0);
  expect(observations.map((row) => row.command)).toEqual(['download', 'checksum']);
  expect(observations[1].args).toEqual(['--check', '--strict', '-']);
});

type Change = (value: Workflow) => void;
const inactiveSteps: [string, Change][] = [
  [
    'check deleted',
    (value) => {
      value.jobs.lint.steps = value.jobs.lint.steps.filter((step) => step.name !== stepName);
    },
  ],
  [
    'check duplicated',
    (value) => {
      value.jobs.lint.steps.push(structuredClone(requiredStep(value)));
    },
  ],
  [
    'lint job disabled',
    (value) => {
      value.jobs.lint.if = false;
    },
  ],
  [
    'lint job conditional',
    (value) => {
      value.jobs.lint.if = '${{ false }}';
    },
  ],
  [
    'lint job allowed to fail',
    (value) => {
      value.jobs.lint['continue-on-error'] = true;
    },
  ],
  [
    'step disabled',
    (value) => {
      requiredStep(value).if = false;
    },
  ],
  [
    'step conditional',
    (value) => {
      requiredStep(value).if = '${{ false }}';
    },
  ],
  [
    'step allowed to fail',
    (value) => {
      requiredStep(value)['continue-on-error'] = true;
    },
  ],
];

it.each(inactiveSteps)('required-step admission catches %s', (_name, change) => {
  requiredStep(workflow);
  const changed = structuredClone(workflow);
  change(changed);
  expect(() => requiredStep(changed)).toThrow();
});
