import { describe, expect, it } from 'vitest';

import { workflowContextProblems } from '../workflowContexts';

const job = (value: Record<string, unknown>) => ({ jobs: { publish: value } });
const expression = (root: string) => '${{ ' + root + '.value }}';
const normal = ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs', 'job', 'runner', 'env', 'secrets', 'steps'];

describe('position-specific context availability', () => {
  it.each(['runner', 'env', 'job', 'steps'])('rejects %s in job.env', (context) => {
    expect(workflowContextProblems(job({ env: { DIRECTORY: expression(context) } }))).toEqual([
      `context:${context}:jobs.publish.env.DIRECTORY`,
    ]);
  });

  it.each(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs', 'secrets'])('allows %s in job.env', (context) => {
    expect(workflowContextProblems(job({ env: { VALUE: expression(context) } }))).toEqual([]);
  });

  it.each(normal)('allows %s in job outputs and step inputs', (context) => {
    expect(
      workflowContextProblems(
        job({
          outputs: { result: expression(context) },
          steps: [
            { env: { VALUE: expression(context) }, with: { value: expression(context) }, run: expression(context) },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it.each(['name', 'runs-on', 'timeout-minutes', 'concurrency'])('does not give secrets to job %s', (field) => {
    expect(workflowContextProblems(job({ [field]: expression('secrets') }))).toEqual([
      `context:secrets:jobs.publish.${field}`,
    ]);
  });

  it('rejects secrets in implicit job/step if without printing the property or value', () => {
    const problems = workflowContextProblems(
      job({
        if: "!cancelled() && secrets.PRIVATE_CREDENTIAL != 'private-value'",
        steps: [{ if: "runner.os == 'Linux' && secrets.SECOND_CREDENTIAL != ''" }],
      }),
    );
    expect(problems).toEqual(['context:secrets:jobs.publish.if', 'context:secrets:jobs.publish.steps[0].if']);
    expect(problems.join('\n')).not.toMatch(/CREDENTIAL|private-value|runner\.os/);
  });

  it('limits job if and strategy to their earlier context set', () => {
    expect(
      workflowContextProblems(
        job({
          if: '${{ matrix.enabled && needs.build.result == inputs.expected }}',
          strategy: { matrix: { value: expression('strategy'), other: expression('needs') } },
        }),
      ),
    ).toEqual(['context:matrix:jobs.publish.if', 'context:strategy:jobs.publish.strategy.matrix.value']);
  });

  it('checks workflow-level env, run-name and concurrency separately', () => {
    expect(
      workflowContextProblems({
        env: { TOKEN: expression('secrets'), BAD: expression('needs') },
        'run-name': expression('secrets'),
        concurrency: { group: expression('github'), 'cancel-in-progress': expression('runner') },
      }),
    ).toEqual(['context:needs:env.BAD', 'context:secrets:run-name', 'context:runner:concurrency.cancel-in-progress']);
  });

  it('distinguishes environment name from environment URL', () => {
    expect(
      workflowContextProblems(
        job({
          environment: {
            name: expression('runner'),
            url: '${{ steps.deploy.outputs.url || runner.temp || env.URL || job.status }}',
          },
        }),
      ),
    ).toEqual(['context:runner:jobs.publish.environment.name']);
    expect(workflowContextProblems(job({ environment: { url: expression('secrets') } }))).toEqual([
      'context:secrets:jobs.publish.environment.url',
    ]);
  });

  it('permits env and secrets in credentials, and runtime contexts in container/service env', () => {
    expect(
      workflowContextProblems(
        job({
          container: {
            image: expression('matrix'),
            credentials: { username: expression('env'), password: expression('secrets') },
            env: { HOST: expression('runner'), STATUS: expression('job'), TOKEN: expression('secrets') },
          },
          services: {
            database: {
              image: expression('inputs'),
              credentials: { password: expression('secrets') },
              env: { HOST: expression('runner'), STATUS: expression('job'), TOKEN: expression('env') },
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('does not give steps to container/service env or runner to credentials/image', () => {
    expect(
      workflowContextProblems(
        job({
          container: {
            image: expression('runner'),
            credentials: { password: expression('runner') },
            env: { BAD: expression('steps') },
          },
          services: { database: { env: { BAD: expression('steps') } } },
        }),
      ),
    ).toEqual([
      'context:runner:jobs.publish.container.image',
      'context:runner:jobs.publish.container.credentials.password',
      'context:steps:jobs.publish.container.env.BAD',
      'context:steps:jobs.publish.services.database.env.BAD',
    ]);
  });

  it('separates job defaults.run from workflow defaults.run', () => {
    expect(
      workflowContextProblems({
        defaults: { run: { shell: expression('github') } },
        ...job({ defaults: { run: { shell: expression('env'), 'working-directory': expression('runner') } } }),
      }),
    ).toEqual(['context:github:defaults.run.shell', 'context:runner:jobs.publish.defaults.run.working-directory']);
  });

  it('checks nested reusable inputs and keeps their secret mapping separate', () => {
    expect(
      workflowContextProblems(
        job({
          with: { config: { nested: [expression('inputs'), expression('secrets')] } },
          secrets: { token: expression('secrets') },
        }),
      ),
    ).toEqual(['context:secrets:jobs.publish.with.config.nested[1]']);
  });

  it('gives workflow_call outputs jobs, and input defaults only github/inputs/vars', () => {
    expect(
      workflowContextProblems({
        on: {
          workflow_call: {
            inputs: { mode: { default: expression('inputs') }, bad: { default: expression('needs') } },
            outputs: { release: { value: expression('jobs') }, bad: { value: expression('steps') } },
          },
        },
      }),
    ).toEqual([
      'context:needs:on.workflow_call.inputs.bad.default',
      'context:steps:on.workflow_call.outputs.bad.value',
    ]);
  });
});

describe('expression roots rather than substring matching', () => {
  it('ignores text outside expressions and literal/property/function identifiers inside', () => {
    expect(
      workflowContextProblems(
        job({
          env: {
            OUTSIDE: 'runner.temp and job.status are ordinary text',
            SINGLE: "${{ format('runner.temp it''s secrets.VALUE }} still quoted', github.ref) }}",
            PROPERTIES: '${{ github.runner && needs.steps.outputs.job && inputs.env }}',
            STRINGS: "${{ contains(inputs.text, 'env.VALUE') && format('{0}', vars.job) }}",
          },
        }),
      ),
    ).toEqual([]);
  });

  it('detects roots accessed with dot, index, whitespace and bare function arguments', () => {
    expect(
      workflowContextProblems(
        job({
          env: {
            DOT: expression('runner'),
            INDEX: "${{ runner [ 'temp' ] }}",
            BARE: '${{ toJSON(env) }}',
            COMPUTED: '${{ github[runner.os] }}',
          },
        }),
      ),
    ).toEqual([
      'context:runner:jobs.publish.env.DOT',
      'context:runner:jobs.publish.env.INDEX',
      'context:env:jobs.publish.env.BARE',
      'context:runner:jobs.publish.env.COMPUTED',
    ]);
  });

  it('finds compound multiline roots and deduplicates one root at one value path', () => {
    expect(
      workflowContextProblems(
        job({ env: { DIRECTORY: "${{\n format('{0}-{1}', runner.temp,\n toJSON(env)) || runner.os\n}}" } }),
      ),
    ).toEqual(['context:runner:jobs.publish.env.DIRECTORY', 'context:env:jobs.publish.env.DIRECTORY']);
  });

  it('does not turn numbers, literals or a function identifier into contexts', () => {
    expect(
      workflowContextProblems(
        job({ if: '${{ github.run_number > 1e3 && inputs.enabled != 0xff && true && null == null && success() }}' }),
      ),
    ).toEqual([]);
  });

  it('checks each expression span and reports unknown root names without property values', () => {
    expect(
      workflowContextProblems(job({ env: { DIRECTORY: 'prefix ${{ imaginary.PRIVATE }} suffix ${{ runner.temp }}' } })),
    ).toEqual(['context:imaginary:jobs.publish.env.DIRECTORY', 'context:runner:jobs.publish.env.DIRECTORY']);
  });

  it('escapes unusual YAML path keys rather than emitting control characters', () => {
    const problems = workflowContextProblems({ jobs: { 'publish\njob': { env: { VALUE: expression('runner') } } } });
    expect(problems).toEqual(['context:runner:jobs["publish\\njob"].env.VALUE']);
    expect(problems[0]).not.toContain('\n');
  });
});

it('supports the publish, docs and CI sibling position shapes', () => {
  const siblings = [
    {
      jobs: {
        build: { outputs: { version: '${{ steps.release.outputs.version }}' } },
        publish: {
          env: { TRUSTED_SOURCE: '${{ github.workspace }}/trusted-source' },
          steps: [
            { env: { INTAKE: '${{ runner.temp }}/intake' }, run: 'echo "$INTAKE"' },
            { with: { path: '${{ runner.temp }}/intake' } },
          ],
        },
      },
    },
    {
      concurrency: { group: 'pages' },
      jobs: {
        deploy: {
          if: "github.event_name != 'release' || !github.event.release.prerelease",
          environment: {
            name: 'github-pages',
            url: '${{ steps.deployment.outputs.page_url }}',
          },
        },
      },
    },
    {
      jobs: {
        test: {
          strategy: { matrix: { node: [22, 24] } },
          'runs-on': '${{ matrix.os }}',
          steps: [{ with: { 'node-version': '${{ matrix.node }}' }, env: { CI_TOKEN: '${{ secrets.CI_TOKEN }}' } }],
        },
      },
    },
  ];
  for (const workflow of siblings) expect(workflowContextProblems(workflow)).toEqual([]);
});

it('is a context-policy subset over unknown input, not a workflow schema validator', () => {
  for (const value of [undefined, null, false, 1, [], {}]) expect(workflowContextProblems(value)).toEqual([]);
});
