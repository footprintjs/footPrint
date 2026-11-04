import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { minimalChildEnv } from '../../test/helpers/childProcessEnv';
import { CHECKOUT, DOWNLOAD, releaseWorkflowProblems, type Step, type Workflow } from './workflowRules';
import { workflowContextProblems } from './workflowContexts';

// These are the actual YAML run bodies, not a parallel fixture copy of the route.
const release = parse(readFileSync(resolve('.github/workflows/publish.yml'), 'utf8')) as Workflow;
const docs = parse(readFileSync(resolve('.github/workflows/docs.yml'), 'utf8')) as Workflow;
const publisher = (workflow: Workflow) => workflow.jobs.publish;
const checkout = (workflow: Workflow) =>
  publisher(workflow).steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
const download = (workflow: Workflow) =>
  publisher(workflow).steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
const upload = (workflow: Workflow) =>
  workflow.jobs.build.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
const admit = (workflow: Workflow) => publisher(workflow).steps.find((s) => s.run?.trim().endsWith('run.sh" admit'))!;
const publish = (workflow: Workflow) =>
  publisher(workflow).steps.find((s) => s.run?.trim().endsWith('run.sh" publish'))!;
function effectiveEnv(workflow: Workflow, step: Step) {
  return { ...workflow.env, ...publisher(workflow).env, ...step.env };
}
function alterEnv(workflow: Workflow, key: string, value: string) {
  for (const step of [admit(workflow), publish(workflow)]) step.env = { ...step.env, [key]: value };
}

it('the real workflows admit only the isolated, event-bound tarball publication and stable docs', () => {
  expect(releaseWorkflowProblems(release, docs)).toEqual([]);
});

it.each(['publish', 'docs', 'ci'])('each real workflow uses only available expression contexts: %s', (name) => {
  const workflow = parse(readFileSync(resolve(`.github/workflows/${name}.yml`), 'utf8'));
  expect(workflowContextProblems(workflow)).toEqual([]);
});

type Change = (workflow: Workflow, documentation: Workflow) => void;
const corruptions: [string, string, Change][] = [
  [
    'runner context returns to job-level environment',
    'context:runner:jobs.publish.env.RESTORED_TEMP',
    (w) => {
      publisher(w).env = { ...publisher(w).env, RESTORED_TEMP: '${{ runner.temp }}' };
    },
  ],
  [
    'docs uses a secret directly in a job condition',
    'context:secrets:jobs.build.if',
    (_, d) => {
      d.jobs.build.if = '${{ secrets.DEPLOY_ENABLED }}';
    },
  ],
  [
    'publication loses its step-local intake binding',
    'paths:ARTIFACT_DIRECTORY',
    (w) => {
      delete publish(w).env!.ARTIFACT_DIRECTORY;
    },
  ],
  [
    'publication loses its step-local npm directory binding',
    'paths:PUBLISH_DIRECTORY',
    (w) => {
      delete publish(w).env!.PUBLISH_DIRECTORY;
    },
  ],
  [
    'workflow-wide OIDC',
    'oidc:top-level',
    (w) => {
      w.permissions = { 'id-token': 'write' };
    },
  ],
  [
    'write-all inherited OIDC',
    'oidc:top-level',
    (w) => {
      w.permissions = 'write-all';
    },
  ],
  [
    'OIDC on dependency build',
    'oidc:other-job',
    (w) => {
      w.jobs.build.permissions = { 'id-token': 'write' };
    },
  ],
  [
    'checkout floats',
    'checkout:reviewed-sha',
    (w) => {
      checkout(w).uses = 'actions/checkout@v7';
    },
  ],
  [
    'checkout uses an unreviewed SHA',
    'checkout:reviewed-sha',
    (w) => {
      checkout(w).uses = `actions/checkout@${'a'.repeat(40)}`;
    },
  ],
  [
    'download floats on old unzip',
    'download:reviewed-sha',
    (w) => {
      download(w).uses = 'actions/download-artifact@v4';
    },
  ],
  [
    'download uses an unreviewed SHA',
    'download:reviewed-sha',
    (w) => {
      download(w).uses = `actions/download-artifact@${'b'.repeat(40)}`;
    },
  ],
  [
    'checkout trusts build source',
    'checkout:event-sha',
    (w) => {
      checkout(w).with!.ref = '${{ needs.build.outputs.source }}';
    },
  ],
  [
    'checkout keeps credentials',
    'checkout:no-credentials',
    (w) => {
      checkout(w).with!['persist-credentials'] = true;
    },
  ],
  [
    'checkout defaults credentials',
    'checkout:no-credentials',
    (w) => {
      delete checkout(w).with!['persist-credentials'];
    },
  ],
  [
    'checkout becomes full',
    'checkout:only-helper-and-manifest',
    (w) => {
      delete checkout(w).with!['sparse-checkout'];
    },
  ],
  [
    'checkout omits source manifest',
    'checkout:only-helper-and-manifest',
    (w) => {
      checkout(w).with!['sparse-checkout'] = 'scripts/publish-release';
    },
  ],
  [
    'checkout widens sparse tree',
    'checkout:only-helper-and-manifest',
    (w) => {
      checkout(w).with!['sparse-checkout'] += '\n.';
    },
  ],
  [
    'checkout falls inside intake',
    'checkout:trusted-source',
    (w) => {
      checkout(w).with!.path = '${{ runner.temp }}/fp-release-intake';
    },
  ],
  [
    'download defaults workspace',
    'download:isolated-absolute-intake',
    (w) => {
      delete download(w).with!.path;
    },
  ],
  [
    'download goes to workspace',
    'download:isolated-absolute-intake',
    (w) => {
      download(w).with!.path = '${{ github.workspace }}/trusted-source';
    },
  ],
  [
    'download uses relative intake',
    'download:isolated-absolute-intake',
    (w) => {
      download(w).with!.path = 'fp-release-intake';
    },
  ],
  [
    'download escapes intended intake',
    'download:isolated-absolute-intake',
    (w) => {
      download(w).with!.path = '${{ runner.temp }}/fp-release-intake/../trusted-source';
    },
  ],
  [
    'download merges broad artifacts',
    'download:one-named-artifact',
    (w) => {
      download(w).with!.pattern = '*';
    },
  ],
  [
    'upload widens to repository',
    'upload:exact-tarball',
    (w) => {
      upload(w).with!.path = '.';
    },
  ],
  [
    'upload permits many archives',
    'upload:exact-tarball',
    (w) => {
      upload(w).with!.path = '*.tgz';
    },
  ],
  [
    'source admission removed',
    'source:absolute-admit',
    (w) => {
      publisher(w).steps = publisher(w).steps.filter((s) => s !== admit(w));
    },
  ],
  [
    'source admission after intake',
    'order:source-before-download',
    (w) => {
      const steps = publisher(w).steps;
      const a = steps.indexOf(admit(w));
      const d = steps.indexOf(download(w));
      [steps[a], steps[d]] = [steps[d], steps[a]];
    },
  ],
  [
    'source tag trusts build',
    'source:event-tag',
    (w) => {
      alterEnv(w, 'RELEASE_TAG', '${{ needs.build.outputs.version }}');
    },
  ],
  [
    'source prerelease fabricated',
    'source:event-prerelease',
    (w) => {
      alterEnv(w, 'RELEASE_PRERELEASE', 'false');
    },
  ],
  [
    'source SHA trusts build',
    'source:event-sha',
    (w) => {
      alterEnv(w, 'GITHUB_SHA', '${{ needs.build.outputs.source }}');
    },
  ],
  [
    'source path becomes intake',
    'paths:TRUSTED_SOURCE',
    (w) => {
      alterEnv(w, 'TRUSTED_SOURCE', '${{ runner.temp }}/fp-release-intake');
    },
  ],
  [
    'npm cwd becomes source',
    'paths:PUBLISH_DIRECTORY',
    (w) => {
      alterEnv(w, 'PUBLISH_DIRECTORY', '${{ github.workspace }}/trusted-source');
    },
  ],
  [
    'publisher calls an artifact helper',
    'publish:absolute-helper',
    (w) => {
      publish(w).run = 'bash scripts/publish-release/run.sh publish';
    },
  ],
  [
    'stage moves before source tests',
    'gates:before-stage:npm test',
    (w) => {
      const steps = w.jobs.build.steps;
      const stage = steps.findIndex((s) => s.run?.includes('run.sh stage'));
      const tests = steps.findIndex((s) => s.run?.trim() === 'npm test');
      [steps[stage], steps[tests]] = [steps[tests], steps[stage]];
    },
  ],
  [
    'docs grant OIDC during install',
    'docs:write-only-deploy',
    (_, d) => {
      d.jobs.build.permissions = { 'id-token': 'write' };
    },
  ],
  [
    'docs grant Pages during install',
    'docs:write-only-deploy',
    (_, d) => {
      d.jobs.build.permissions = { pages: 'write' };
    },
  ],
  [
    'docs top-level write remains',
    'docs:no-top-level-write',
    (_, d) => {
      d.permissions = { pages: 'write', 'id-token': 'write' };
    },
  ],
  [
    'docs prerelease guard removed',
    'docs:release-guard:release:true',
    (_, d) => {
      delete d.jobs.build.if;
      delete d.jobs.deploy.if;
    },
  ],
  [
    'docs blocks final releases too',
    'docs:release-guard:release:false',
    (_, d) => {
      d.jobs.build.if = "github.event_name != 'release'";
    },
  ],
  [
    'docs deploy independent of guarded build',
    'docs:deploy-needs-build',
    (_, d) => {
      delete d.jobs.deploy.needs;
    },
  ],
];
for (const name of ['build', 'publish']) {
  corruptions.push(
    [
      `${name} toolchain reads source before setup`,
      `toolchain:before-checkout:${name}`,
      (workflow) => {
        const job = workflow.jobs[name];
        const source = job.steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
        const setup = job.steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
        [job.steps[source], job.steps[setup]] = [job.steps[setup], job.steps[source]];
      },
    ],
    [
      `${name} npm upgrade runs lifecycle scripts`,
      `toolchain:upgrade-without-scripts:${name}`,
      (workflow) => {
        const step = workflow.jobs[name].steps.find(
          (step) => step.run === 'npm install -g npm@11.19.0 --ignore-scripts --registry=https://registry.npmjs.org',
        )!;
        step.run = 'npm install -g npm@11.19.0';
      },
    ],
  );
}
for (const command of [
  'npm ci',
  'npm pack',
  'npm version 11.0.0',
  'npm install tool',
  'npm install -g tool',
  'npm install -g npm@11',
  'npm install --global npm@11.19.0 --registry https://invalid.example',
  'npx tool',
]) {
  corruptions.push([
    `OIDC command ${command}`,
    'publish:no-dependency-or-floating-tool',
    (w) => {
      publisher(w).steps.push({ run: command });
    },
  ]);
}

describe('each structural regression is independently observable', () => {
  it.each(corruptions)('%s', (_, rule, change) => {
    // A broken positive baseline cannot make a negative control pass vacuously.
    expect(releaseWorkflowProblems(release, docs)).toEqual([]);
    const badRelease = structuredClone(release);
    const badDocs = structuredClone(docs);
    change(badRelease, badDocs);
    expect(releaseWorkflowProblems(badRelease, badDocs)).toContain(rule);
  });
});

it('the actual publish run body cannot execute a helper supplied by artifact intake', () => {
  const step = publisher(release).steps.find((s) => /\brun\.sh["']?\s+publish\s*$/.test(s.run ?? ''));
  expect(step?.run).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), 'fp workflow isolation '));
  const source = join(root, 'workspace', 'trusted-source');
  const intake = join(root, 'temp', 'fp-release-intake');
  const log = join(root, 'trusted.log');
  const stolen = join(root, 'artifact-ran');
  try {
    for (const directory of [source, intake])
      mkdirSync(join(directory, 'scripts/publish-release'), { recursive: true });
    writeFileSync(join(source, 'scripts/publish-release/run.sh'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$PROBE_LOG"\n');
    writeFileSync(join(intake, 'scripts/publish-release/run.sh'), '#!/bin/sh\nprintf attacker > "$STOLEN"\n');
    chmodSync(join(source, 'scripts/publish-release/run.sh'), 0o700);
    const env = Object.fromEntries(
      Object.entries(effectiveEnv(release, step!)).map(([key, value]) => [
        key,
        value
          .replaceAll('${{ github.workspace }}', join(root, 'workspace'))
          .replaceAll('${{ runner.temp }}', join(root, 'temp')),
      ]),
    );
    const result = spawnSync('bash', ['-euc', step!.run!], {
      cwd: intake,
      env: { ...minimalChildEnv(process.env), ...env, TRUSTED_SOURCE: source, PROBE_LOG: log, STOLEN: stolen },
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(stolen)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('publish\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('the reviewed actions retain the exact checkout and fixed-unzip download revisions', () => {
  expect(checkout(release).uses).toBe(CHECKOUT);
  expect(download(release).uses).toBe(DOWNLOAD);
});
