/**
 * The required checks of `main` (branch protection) are job names in the workflows a pull request runs.
 * Each must come from exactly ONE job, and that job must not be able to be skipped into a pass: GitHub
 * reports a skipped job as passed, even for a required check. Nor may a job behind a consumer's check pass
 * while one of its steps failed or did not run (`continue-on-error`, a step-level `if`). A sharded
 * consumer's required name is its aggregate's (`shard-verdict`); its shard jobs carry other names. The names are computed from the real
 * workflow files and the real job plan (scripts/consumer-shards.mjs): what GitHub would name each job.
 * Nothing runs on GitHub, so what this cannot see is said in docs/guides/consumer-audit.md.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { consumerJobs } from '../../scripts/consumer-shards.mjs';

/** Branch protection's required status checks on `main` (`strict` is false). Changing one blocks every PR. */
const REQUIRED = [
  'lint',
  'test (22)',
  'test (24)',
  'pack',
  'agentfootprint',
  'agentfootprint-lens',
  'hcifootprint',
  'footprint-playground',
  'footprint-storyreel',
  'vizfootprint',
];

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  'continue-on-error'?: unknown;
  env?: Record<string, string>;
  with?: unknown;
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
  outputs?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
  steps: Step[];
};
type Workflow = { on: unknown; jobs: Record<string, Job> };
type Entry = Record<string, unknown> & { package: string };
type Producer = { file: string; id: string };

const expr = (inner: string) => '$' + `{{ ${inner} }}`;
const family = (): Entry[] => JSON.parse(readFileSync(resolve('scripts/family.json'), 'utf8')).family;
const workflowAt = (file: string) => parse(readFileSync(resolve('.github/workflows', file), 'utf8')) as Workflow;
const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());

/** The workflows a pull request to main starts. */
function pullRequestWorkflows(): Map<string, Workflow> {
  const out = new Map<string, Workflow>();
  for (const file of readdirSync(resolve('.github/workflows')).sort()) {
    const workflow = workflowAt(file);
    const on = workflow.on;
    const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on as object);
    if (events.includes('pull_request')) out.set(file, workflow);
  }
  return out;
}

/** What `pack` hands the consumer jobs for this family (the commit pins do not change a name). */
const outputsFor = (entries: Entry[]): Record<string, unknown> => ({ ...consumerJobs(entries) });

const FROM_PACK = /^\$\{\{ fromJSON\(needs\.pack\.outputs\.([a-z_]+)\) \}\}$/;
function matrixValue(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value;
  const match = FROM_PACK.exec(value);
  if (!match || !Object.hasOwn(outputs, match[1])) throw new Error(`a matrix this test cannot read: ${value}`);
  return outputs[match[1]];
}

/** The matrix rows of a job, for the shapes the workflows use: vectors, or `include` alone. */
function rows(job: Job, outputs: Record<string, unknown>): Record<string, unknown>[] {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{}];
  const keys = Object.keys(matrix);
  if (keys.includes('exclude') || (keys.includes('include') && keys.length > 1))
    throw new Error('a matrix shape this test does not expand');
  if (keys.includes('include')) return matrixValue(matrix.include, outputs) as Record<string, unknown>[];
  let combos: Record<string, unknown>[] = [{}];
  for (const key of keys)
    combos = combos.flatMap((row) =>
      (matrixValue(matrix[key], outputs) as unknown[]).map((v) => ({ ...row, [key]: v })),
    );
  return combos;
}

const MATRIX_REF = /\$\{\{ matrix\.([A-Za-z0-9_-]+) \}\}/g;
/** The check names GitHub gives one job: its `name` with the matrix filled in, or its id plus the matrix values. */
function namesOf(id: string, job: Job, outputs: Record<string, unknown>): string[] {
  return rows(job, outputs).map((row) => {
    const values = Object.values(row).map(String);
    if (job.name === undefined) return values.length ? `${id} (${values.join(', ')})` : id;
    const name = job.name.replace(MATRIX_REF, (_, key: string) => String(row[key]));
    if (name.includes('${{')) throw new Error(`a job name this test cannot read: ${job.name}`);
    return values.length && name === job.name ? `${name} (${values.join(', ')})` : name;
  });
}

/** Every check name a pull request's workflows produce, with the jobs producing it. */
function producers(entries: Entry[], workflows = pullRequestWorkflows()): Map<string, Producer[]> {
  const out = new Map<string, Producer[]>();
  const outputs = outputsFor(entries);
  for (const [file, workflow] of workflows)
    for (const [id, job] of Object.entries(workflow.jobs))
      for (const name of namesOf(id, job, outputs)) out.set(name, [...(out.get(name) ?? []), { file, id }]);
  return out;
}

/**
 * Null when the job cannot be skipped into a pass: it runs `if: always()`, or it has no `if` and needs only
 * jobs that produce a required check and themselves cannot (so a skip means a required check is already
 * red). Otherwise, why not.
 */
function skipProblem(workflow: Workflow, id: string, entries: Entry[]): string | null {
  const job = workflow.jobs[id];
  if (job.if !== undefined) return job.if.trim() === 'always()' ? null : `${id} has \`if: ${job.if}\``;
  const outputs = outputsFor(entries);
  for (const need of needsOf(job)) {
    const needed = workflow.jobs[need];
    if (!namesOf(need, needed, outputs).some((name) => REQUIRED.includes(name)))
      return `${id} needs ${need}, which no required check stands for: a red ${need} would skip ${id} into a pass`;
    const deeper = skipProblem(workflow, need, entries);
    if (deeper) return deeper;
  }
  return null;
}

function requiredProblems(entries: Entry[], workflows = pullRequestWorkflows()): string[] {
  const named = producers(entries, workflows);
  return REQUIRED.flatMap((name) => {
    const jobs = named.get(name) ?? [];
    if (jobs.length !== 1) return [`${name}: ${jobs.length} jobs`];
    const problem = skipProblem(workflows.get(jobs[0].file) as Workflow, jobs[0].id, entries);
    return problem ? [`${name}: ${problem}`] : [];
  });
}

/** The jobs behind a consumer's required check: every one of their steps must run and count. */
const GATED = ['consumer', 'consumer-shard', 'shard-verdict'];

/**
 * How a gated job could pass while a step failed or did not run, or nothing. `continue-on-error` on the
 * job or on a step allows "a job to pass when this step fails"; a step-level `if` can skip a step, and a
 * skipped step leaves its job green. No exception is listed: none of the three jobs has either today.
 */
function stepProblems(id: string, job: Job): string[] {
  const out = Object.hasOwn(job, 'continue-on-error') ? [`${id}: continue-on-error on the job`] : [];
  job.steps.forEach((step, i) => {
    const label = `${id} step ${i + 1} (${step.name ?? step.uses ?? String(step.run).split('\n')[0]})`;
    if (Object.hasOwn(step, 'continue-on-error')) out.push(`${label}: continue-on-error`);
    if (Object.hasOwn(step, 'if')) out.push(`${label}: a step-level if`);
  });
  return out;
}
const gatedProblems = (workflow: Workflow) => GATED.flatMap((id) => stepProblems(id, workflow.jobs[id]));

const consumers = workflowAt('consumers.yml');
const shardedWith = (name: string, count: number) =>
  family().map((entry) => (entry.package === name ? { ...entry, shards: { check: 'npm test', count } } : entry));

describe('the required checks', () => {
  it('each comes from exactly one job of a pull request, and no job can be skipped into one', () => {
    expect(requiredProblems(family())).toEqual([]);
  });

  it('no two jobs share a check name, so a shard name never stands in for a required one', () => {
    const shared = [...producers(family())].filter(([, jobs]) => jobs.length > 1).map(([name]) => name);
    expect(shared).toEqual([]);
    const shardNames = namesOf('consumer-shard', consumers.jobs['consumer-shard'], outputsFor(family()));
    expect(shardNames).toEqual([1, 2, 3, 4].map((i) => `agentfootprint · shard ${i}/4`));
    for (const name of shardNames) expect(REQUIRED).not.toContain(name);
  });

  it.each([
    ['without `if: always()`', undefined],
    ['with `if: !cancelled()`, as an expression', expr('!cancelled()')],
    ['with `if: success()`', 'success()'],
    ['with `if: always() && github.event_name == pull_request`', "always() && github.event_name == 'pull_request'"],
  ])('refuses an aggregate %s: it could be skipped into a pass', (_name, condition) => {
    const changed = structuredClone(consumers);
    if (condition === undefined) delete changed.jobs['shard-verdict'].if;
    else changed.jobs['shard-verdict'].if = condition;
    const workflows = pullRequestWorkflows().set('consumers.yml', changed);
    expect(requiredProblems(family(), workflows)).toEqual([expect.stringMatching(/^agentfootprint: /)]);
  });

  it('refuses a required name produced twice, or not at all', () => {
    const twice = structuredClone(consumers);
    twice.jobs['consumer-shard'].name = expr('matrix.consumer');
    const workflows = pullRequestWorkflows().set('consumers.yml', twice);
    expect(requiredProblems(family(), workflows)).toContain('agentfootprint: 5 jobs');
    const none = structuredClone(consumers);
    delete none.jobs['shard-verdict'];
    expect(requiredProblems(family(), pullRequestWorkflows().set('consumers.yml', none))).toContain(
      'agentfootprint: 0 jobs',
    );
  });
});

describe('every step behind a consumer check counts', () => {
  it('no gated job has continue-on-error, on itself or a step, or a step-level if', () => {
    expect(gatedProblems(consumers)).toEqual([]);
  });

  const auditOf = (job: Job) => job.steps.find((step) => step.run?.includes('scripts/audit-consumers.mjs')) as Step;
  it.each([
    ['a step if on the aggregate step', (w: Workflow) => (w.jobs['shard-verdict'].steps[0].if = 'false')],
    [
      'continue-on-error on the aggregate step',
      (w: Workflow) => (w.jobs['shard-verdict'].steps[0]['continue-on-error'] = true),
    ],
    ['continue-on-error on the aggregate job', (w: Workflow) => (w.jobs['shard-verdict']['continue-on-error'] = true)],
    ['continue-on-error on the shard job', (w: Workflow) => (w.jobs['consumer-shard']['continue-on-error'] = true)],
    [
      "continue-on-error on the shard's audit step",
      (w: Workflow) => (auditOf(w.jobs['consumer-shard'])['continue-on-error'] = true),
    ],
    ["`if: false` on the shard's audit step", (w: Workflow) => (auditOf(w.jobs['consumer-shard']).if = false)],
    [
      "continue-on-error on the consumer job's audit step",
      (w: Workflow) => (auditOf(w.jobs.consumer)['continue-on-error'] = true),
    ],
    ["a step if on the consumer job's checkout", (w: Workflow) => (w.jobs.consumer.steps[0].if = 'always()')],
  ])('refuses %s', (_name, change) => {
    const changed = structuredClone(consumers);
    change(changed);
    expect(gatedProblems(changed)).toHaveLength(1);
  });
});

describe('a shard count in scripts/family.json', () => {
  it.each([2, 3, 4, 8])('of %i yields that many shard jobs and the one aggregate', (count) => {
    const entries = shardedWith('agentfootprint', count);
    const outputs = outputsFor(entries);
    expect(namesOf('consumer-shard', consumers.jobs['consumer-shard'], outputs)).toEqual(
      Array.from({ length: count }, (_, i) => `agentfootprint · shard ${i + 1}/${count}`),
    );
    expect(namesOf('shard-verdict', consumers.jobs['shard-verdict'], outputs)).toEqual(['agentfootprint']);
    expect(namesOf('consumer', consumers.jobs.consumer, outputs)).not.toContain('agentfootprint');
    expect(requiredProblems(entries)).toEqual([]);
  });

  it('on a second consumer gives it its own shard jobs and aggregate, and takes it out of the single jobs', () => {
    const entries = shardedWith('hcifootprint', 2);
    const outputs = outputsFor(entries);
    expect(namesOf('shard-verdict', consumers.jobs['shard-verdict'], outputs)).toEqual([
      'hcifootprint',
      'agentfootprint',
    ]);
    expect(namesOf('consumer-shard', consumers.jobs['consumer-shard'], outputs)).toEqual([
      'hcifootprint · shard 1/2',
      'hcifootprint · shard 2/2',
      ...[1, 2, 3, 4].map((i) => `agentfootprint · shard ${i}/4`),
    ]);
    expect(namesOf('consumer', consumers.jobs.consumer, outputs)).not.toContain('hcifootprint');
    expect(requiredProblems(entries)).toEqual([]);
  });

  it('leaves neither consumer job empty: an empty matrix fails the run', () => {
    const { consumers: single, sharded } = consumerJobs(family());
    expect(single.length).toBeGreaterThan(0);
    expect(sharded.length).toBeGreaterThan(0);
  });
});

describe('the aggregate', () => {
  const verdict = consumers.jobs['shard-verdict'];
  const RESULTS = ['success', 'failure', 'cancelled', 'skipped'];

  it('runs always, after pack and the shard job, and reads the result of every job it needs', () => {
    expect(verdict.if).toBe('always()');
    expect(needsOf(verdict)).toEqual(['pack', 'consumer-shard']);
    expect(verdict.name).toBe(expr('matrix.consumer'));
    expect(verdict.strategy?.matrix).toEqual({ consumer: expr('fromJSON(needs.pack.outputs.sharded)') });
    expect(verdict.steps).toHaveLength(1);
    // Exactly these keys: no `if`, `continue-on-error`, `shell` or `working-directory` can change what it means.
    expect(Object.keys(verdict.steps[0]).sort()).toEqual(['env', 'name', 'run']);
    expect(Object.values(verdict.steps[0].env ?? {}).sort()).toEqual(
      needsOf(verdict)
        .map((need) => expr(`needs.${need}.result`))
        .sort(),
    );
  });

  // As GitHub runs a `run:` step. Every combination of the two results, the cancelled run included.
  it.each(RESULTS.flatMap((pack) => RESULTS.map((shards) => [pack, shards])))(
    'pack %s, shards %s: green only when both succeeded',
    (pack, shards) => {
      const step = verdict.steps[0];
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', String(step.run)], {
        env: { PATH: process.env.PATH ?? '', PACK: pack, SHARDS: shards },
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0, result.stdout).toBe(pack === 'success' && shards === 'success');
    },
  );

  it('reads the ONE shard job result: with two sharded consumers, a red shard of either turns both red', () => {
    const outputs = outputsFor(shardedWith('hcifootprint', 2));
    expect(namesOf('shard-verdict', verdict, outputs)).toHaveLength(2);
    // The same step for every row, reading the shard job's one result: no row can pass while it is red.
    expect(verdict.steps[0].env?.SHARDS).toBe(expr('needs.consumer-shard.result'));
    expect(verdict.steps[0].run).not.toContain('matrix');
  });
});

describe('the shard job', () => {
  const single = consumers.jobs.consumer;
  const shard = consumers.jobs['consumer-shard'];
  const auditAt = (job: Job) => job.steps.findIndex((step) => step.run?.includes('scripts/audit-consumers.mjs'));

  it('is the consumer job with the two shard arguments, and nothing else', () => {
    for (const key of ['needs', 'runs-on', 'timeout-minutes'] as const) expect(shard[key]).toEqual(single[key]);
    expect(shard.strategy?.['fail-fast']).toBe(false);
    expect(shard.strategy?.matrix).toEqual({ include: expr('fromJSON(needs.pack.outputs.shards)') });
    expect(shard.name).toBe(`${expr('matrix.consumer')} · shard ${expr('matrix.shard')}`);
    const at = auditAt(single);
    expect(at).toBeGreaterThan(0);
    expect(auditAt(shard)).toBe(at);
    expect(shard.steps.filter((_, i) => i !== at)).toEqual(single.steps.filter((_, i) => i !== at));
    const [one, part] = [single.steps[at], shard.steps[at]];
    expect(part.run).toBe(
      String(one.run).replace('--only "$CONSUMER"', '--only "$CONSUMER" --shard "$SHARD" --commit "$COMMIT"'),
    );
    expect(part.run).not.toContain('${{');
    expect(part.env).toEqual({ ...one.env, SHARD: expr('matrix.shard'), COMMIT: expr('matrix.commit') });
  });

  it('gets its rows and their one commit from pack, which plans them with scripts/consumer-shards.mjs', () => {
    const pack = consumers.jobs.pack;
    for (const key of ['consumers', 'shards', 'sharded'])
      expect(pack.outputs?.[key]).toBe(expr(`steps.list.outputs.${key}`));
    const list = pack.steps.filter((step) => (step as { id?: string }).id === 'list');
    expect(list).toHaveLength(1);
    expect(list[0].run).toBe('node scripts/consumer-shards.mjs >> "$GITHUB_OUTPUT"');
    expect(single.strategy?.matrix).toEqual({ consumer: expr('fromJSON(needs.pack.outputs.consumers)') });
  });
});
