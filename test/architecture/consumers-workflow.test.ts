/**
 * .github/workflows/consumers.yml hands the BASE branch's version to the audit (scripts/consumer-range.mjs,
 * question 1). It must come from the base commit, read before any of the pull request's code runs, and every action
 * stays pinned by SHA. The real file is parsed; nothing runs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { workflowContextProblems } from '../../scripts/publish-release/workflowContexts';

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = { needs?: string; outputs?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync(resolve('.github/workflows/consumers.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

/** A GitHub expression or a shell expansion, spelled without a literal `${` in this file. */
const expr = (inner: string) => '$' + `{{ ${inner} }}`;
const shell = (inner: string) => '$' + `{${inner}}`;

/** One immutable reader identity must reach both checkouts and both archive witnesses. */
function assertReaderBindings(value: typeof workflow): void {
  expect(value.env?.PROTOCOL_READER_HEAD).toMatch(/^[a-f0-9]{40}$/);
  for (const [name, operation] of [
    ['reader-pack', 'witness.mjs reader'],
    ['protocol', 'verify.mjs'],
    ['protocol', 'candidate-artifact.mjs reader'],
  ]) {
    const job = value.jobs[name];
    expect(job.env?.PROTOCOL_READER_HEAD).toBeUndefined();
    const checkouts = job.steps.filter((step) => step.with?.repository === 'footprintjs/foottrace');
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with?.ref).toBe(expr('env.PROTOCOL_READER_HEAD'));
    const calls = job.steps.filter((step) => step.run?.includes(`scripts/subflow-protocol/${operation}`));
    expect(calls).toHaveLength(1);
    expect(calls[0].run?.trim().endsWith(' "$PROTOCOL_READER_HEAD"')).toBe(true);
    for (const step of job.steps) expect(step.env?.PROTOCOL_READER_HEAD).toBeUndefined();
  }
}

const engineBind = 'node scripts/subflow-protocol/bind-source.mjs';
const engineWitness = 'node scripts/subflow-protocol/witness.mjs engine "$RUNNER_TEMP/candidate"';

/** The pack uses the shared event admission before package code and at witness time. */
function assertProtocolBindings(value: typeof workflow): void {
  expect(value.on).toEqual({ pull_request: { branches: ['main'] }, workflow_dispatch: null });
  const steps = value.jobs.pack.steps;
  expect(steps[0].uses).toMatch(/^actions\/checkout@/);
  expect(steps[0].with?.ref).toBeUndefined();
  const bindings = steps.filter((step) => step.run === engineBind);
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toBe(steps[1]);
  expect(bindings[0].if).toBeUndefined();
  expect(bindings[0].env).toBeUndefined();
  const witnesses = steps.filter((step) => step.run === engineWitness);
  expect(witnesses).toHaveLength(1);
  expect(witnesses[0].if).toBeUndefined();
  expect(witnesses[0].env).toBeUndefined();
  const pack = steps.findIndex((step) => step.name === 'Pack the candidate');
  expect(pack).toBeGreaterThan(1);
  expect(steps.indexOf(witnesses[0])).toBeGreaterThan(pack);
}

describe('the consumer audit workflow', () => {
  it('binds both reader checkouts and original-pack proofs to one immutable reader source', () => {
    assertReaderBindings(workflow);
  });

  it.each([
    'missing-pin',
    'mutable-pin',
    'pack-checkout',
    'proof-checkout',
    'witness',
    'proof',
    'archive-receipt',
    'job-override',
    'step-override',
  ])('rejects a split or mutable reader identity: %s', (fault) => {
    const changed = structuredClone(workflow);
    changed.env ??= {};
    const pack = changed.jobs['reader-pack'];
    const proof = changed.jobs.protocol;
    if (fault === 'missing-pin') delete changed.env.PROTOCOL_READER_HEAD;
    if (fault === 'mutable-pin') changed.env.PROTOCOL_READER_HEAD = expr('github.sha');
    if (fault === 'pack-checkout' || fault === 'proof-checkout') {
      const job = fault === 'pack-checkout' ? pack : proof;
      job.steps.find((step) => step.with?.repository === 'footprintjs/foottrace')!.with!.ref = '0'.repeat(40);
    }
    if (['witness', 'proof', 'archive-receipt'].includes(fault)) {
      const job = fault === 'witness' ? pack : proof;
      const script =
        fault === 'witness' ? 'witness.mjs reader' : fault === 'proof' ? 'verify.mjs' : 'candidate-artifact.mjs reader';
      const step = job.steps.find((one) => one.run?.includes(`scripts/subflow-protocol/${script}`));
      if (!step?.run) throw new Error(`Missing ${script} workflow step`);
      step.run = step.run.replace('"$PROTOCOL_READER_HEAD"', '0'.repeat(40));
    }
    if (fault === 'job-override') proof.env = { PROTOCOL_READER_HEAD: '0'.repeat(40) };
    if (fault === 'step-override') pack.steps[0].env = { PROTOCOL_READER_HEAD: '0'.repeat(40) };
    expect(() => assertReaderBindings(changed)).toThrow();
  });

  it('binds engine source to the event at checkout and again at packing', () => {
    assertProtocolBindings(workflow);
  });

  it.each([
    'guarded-binding',
    'head-only-checkout',
    'mixed-ref',
    'missing-witness',
    'early-witness',
    'manual-input',
    'unexpected-trigger',
  ])('rejects a source-binding trust regression: %s', (fault) => {
    const changed = structuredClone(workflow);
    const steps = changed.jobs.pack.steps;
    const binding = steps[1];
    const witness = steps.findIndex((step) => step.run === engineWitness);
    if (fault === 'guarded-binding') binding.if = "github.event_name == 'workflow_dispatch'";
    if (fault === 'head-only-checkout')
      steps[0].with = { ...steps[0].with, ref: expr('github.event.pull_request.head.sha') };
    if (fault === 'mixed-ref') binding.env = { PROTOCOL_ENGINE_HEAD: expr('github.event.pull_request.head.sha') };
    if (fault === 'missing-witness') steps.splice(witness, 1);
    if (fault === 'early-witness') steps.unshift(...steps.splice(witness, 1));
    if (fault === 'manual-input') changed.on.workflow_dispatch = { inputs: { sha: { type: 'string' } } };
    if (fault === 'unexpected-trigger') changed.on.merge_group = null;
    expect(() => assertProtocolBindings(changed)).toThrow();
  });
  it('says what reading the base delivers, and does not claim more', () => {
    for (const file of ['.github/workflows/consumers.yml', 'docs/guides/consumer-audit.md']) {
      const text = readFileSync(resolve(file), 'utf8').replace(/\s*\n#?\s*/g, ' ');
      expect(text, file).toContain('an ordinary edit of the version no longer decides who may block');
      expect(text, file).not.toMatch(/never from a file the pull request can edit|which the pull request cannot edit/);
    }
  });

  it.each([
    ['consumer', 'engine', 'pack', 'scripts/audit-consumers.mjs'],
    ['consumer-shard', 'engine', 'pack', 'scripts/audit-consumers.mjs'],
    ['protocol', 'engine', 'pack', 'scripts/subflow-protocol/verify.mjs'],
    ['protocol', 'reader', 'reader-pack', 'scripts/subflow-protocol/verify.mjs'],
  ])('binds %s %s inputs to the producer ZIP and gates package use', (job, role, producer, command) => {
    const steps = workflow.jobs[job].steps;
    const id = expr(`needs.${producer}.outputs.artifact_id`);
    const verify = steps.findIndex((step) =>
      step.run?.includes(`scripts/subflow-protocol/candidate-artifact.mjs ${role} `),
    );
    expect(verify).toBeGreaterThan(0);
    const download = steps[verify - 1];
    expect(download.uses).toMatch(/^actions\/download-artifact@/);
    expect(download.with?.['artifact-ids']).toBe(id);
    expect(download.with?.['skip-decompress']).toBe(true);
    expect(download.with?.name).toBeUndefined();
    expect(steps[verify].env).toEqual({
      ARTIFACT_ID: id,
      ARTIFACT_DIGEST: expr(`needs.${producer}.outputs.artifact_digest`),
    });
    expect(steps[verify].if).toBeUndefined();
    expect(verify).toBeLessThan(steps.findIndex((step) => step.run?.includes(command)));
  });

  it('uses only available expression contexts', () => {
    expect(workflowContextProblems(workflow)).toEqual([]);
  });

  it('pins every action to a full commit SHA', () => {
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps.filter((s) => s.uses)) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('reads the base version from the base commit, on pull requests only, and checks its shape', () => {
    const pack = workflow.jobs.pack;
    expect(pack.outputs?.base_version).toBe(expr('steps.base.outputs.version'));
    const step = pack.steps.find((s) => s.id === 'base');
    expect(step).toBeDefined();
    expect(step?.if).toBe("github.event_name == 'pull_request'");
    // The SHA comes in through the environment, never interpolated into the script.
    expect(step?.env).toEqual({ BASE_SHA: expr('github.event.pull_request.base.sha') });
    expect(step?.run).not.toContain('${{');
    expect(step?.run).toContain('git show "$BASE_SHA:package.json"');
    expect(step?.run).toContain('/^[0-9A-Za-z.+-]{1,64}$/');
    // Not the checked-out package.json, which is the pull request's own.
    expect(step?.run).not.toMatch(/require\(['"]\.\/package\.json['"]\)/);
    // Immediately after the exact source check and before setup, installs, or the build.
    const order = pack.steps.map((s) => s.id ?? s.uses ?? s.run ?? s.name);
    expect(order[0]).toMatch(/^actions\/checkout@/);
    expect(order[1]).toBe(engineBind);
    expect(order[2]).toBe('base');
  });

  it('hands it to every consumer job and every shard job, and passes nothing on a manual run', () => {
    for (const job of ['consumer', 'consumer-shard']) {
      const audit = workflow.jobs[job].steps.find((s) => s.run?.includes('scripts/audit-consumers.mjs'));
      expect(audit?.env?.BASE_VERSION, job).toBe(expr('needs.pack.outputs.base_version'));
      expect(audit?.run, job).toContain(shell('BASE_VERSION:+--base-version "$BASE_VERSION"'));
      expect(audit?.run, job).not.toContain('${{');
    }
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'workflow_dispatch']);
  });
});
