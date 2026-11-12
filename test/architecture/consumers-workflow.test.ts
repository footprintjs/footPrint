/**
 * .github/workflows/consumers.yml hands the BASE branch's version to the audit (scripts/consumer-range.mjs,
 * question 1). It must come from the base commit, which the pull request cannot edit, and every action
 * stays pinned by SHA. The real file is parsed; nothing runs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { workflowContextProblems } from '../../scripts/publish-release/workflowContexts';

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { needs?: string; outputs?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync(resolve('.github/workflows/consumers.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

/** A GitHub expression or a shell expansion, spelled without a literal `${` in this file. */
const expr = (inner: string) => '$' + `{{ ${inner} }}`;
const shell = (inner: string) => '$' + `{${inner}}`;

describe('the consumer audit workflow', () => {
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
    const order = pack.steps.map((s) => s.id ?? s.uses ?? s.name);
    expect(order.indexOf('base')).toBeGreaterThan(order.findIndex((s) => s?.startsWith('actions/checkout@')));
  });

  it('hands it to every consumer job, and passes nothing on a manual run', () => {
    const audit = workflow.jobs.consumer.steps.find((s) => s.run?.includes('scripts/audit-consumers.mjs'));
    expect(audit?.env?.BASE_VERSION).toBe(expr('needs.pack.outputs.base_version'));
    expect(audit?.run).toContain(shell('BASE_VERSION:+--base-version "$BASE_VERSION"'));
    expect(audit?.run).not.toContain('${{');
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'workflow_dispatch']);
  });
});
