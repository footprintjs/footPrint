/** Test-only admission of the real workflow's publication boundaries; no Actions execution. */
export interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  ['working-directory']?: string;
}
type Permissions = Record<string, string> | 'read-all' | 'write-all';
export interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Permissions;
  env?: Record<string, string>;
  steps: Step[];
}
export interface Workflow {
  permissions?: Permissions;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

export const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'; // v7.0.1
export const DOWNLOAD = 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333'; // v8.0.2
const PATHS = {
  TRUSTED_SOURCE: '${{ github.workspace }}/trusted-source',
  ARTIFACT_DIRECTORY: '${{ runner.temp }}/fp-release-intake',
  PUBLISH_DIRECTORY: '${{ runner.temp }}/fp-release-publish',
};
const permission = (value: Permissions | undefined, key: string) =>
  value === 'write-all' ? 'write' : typeof value === 'object' ? value?.[key] : undefined;
const HELPER = 'bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh"';
const action = (job: Job, name: string) => job.steps.filter((s) => s.uses?.split('@')[0] === name);
const statements = (body = '') =>
  body
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n|&&|\|\||;/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
const instructions = (job: Job) => job.steps.flatMap((s) => statements(s.run));
const envFor = (workflow: Workflow, job: Job, step: Step = {}) => ({ ...workflow.env, ...job.env, ...step.env });
const pathOf = (path: unknown, env: Record<string, string>) =>
  typeof path === 'string' ? path.replace(/\$\{\{\s*env\.([A-Z_]+)\s*\}\}/g, (_, key: string) => env[key] ?? '') : '';

/** Evaluate only the small expression grammar used for release guards, never eval workflow text. */
function condition(text: string | undefined, event: string, prerelease: boolean): boolean | undefined {
  if (text === undefined) return true;
  const source = text.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1');
  const tokens =
    source.match(/\s+|!=|==|&&|\|\||[!()]|'[^']*'|true|false|github\.(?:event_name|event\.release\.prerelease)/g) ?? [];
  if (tokens.join('') !== source || tokens.length > 100) return undefined;
  const input = tokens.filter((t) => t.trim());
  let cursor = 0;
  const take = (value: string) => input[cursor] === value && ++cursor > 0;
  function atom(): string | boolean {
    if (take('!')) return !atom();
    if (take('(')) {
      const value = either();
      if (!take(')')) throw new Error('guard');
      return value;
    }
    const token = input[cursor++];
    if (token === 'github.event_name') return event;
    if (token === 'github.event.release.prerelease') return prerelease;
    if (token === 'true' || token === 'false') return token === 'true';
    if (token?.startsWith("'")) return token.slice(1, -1);
    throw new Error('guard');
  }
  function comparison(): string | boolean {
    const left = atom();
    if (take('==')) return left === atom();
    if (take('!=')) return left !== atom();
    return left;
  }
  function both(): string | boolean {
    let value = comparison();
    while (take('&&')) {
      const right = comparison();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  }
  function either(): string | boolean {
    let value = both();
    while (take('||')) {
      const right = both();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  }
  try {
    const value = either();
    return cursor === input.length ? Boolean(value) : undefined;
  } catch {
    return undefined;
  }
}

/** Fixed boundaries from the reviewed tarball route; individual rules have corruption controls. */
export function releaseWorkflowProblems(release: Workflow, docs: Workflow): string[] {
  const problems: string[] = [];
  const require = (ok: unknown, rule: string) => {
    if (!ok) problems.push(rule);
  };
  const publishing = release.jobs.publish;
  const build = release.jobs.build;
  require(permission(release.permissions, 'id-token') !== 'write', 'oidc:top-level');
  for (const [name, job] of Object.entries(release.jobs))
    require(name === 'publish' || permission(job.permissions, 'id-token') !== 'write', 'oidc:other-job');
  if (!publishing || !build) return [...problems, 'jobs:build-and-publish'];
  require(permission(publishing.permissions, 'id-token') === 'write', 'oidc:publish');
  require(permission(publishing.permissions, 'contents') === 'read', 'publish:read-only-source');
  require(!JSON.stringify(publishing).includes('needs.build.outputs'), 'publish:event-not-build-output');
  const checkouts = action(publishing, 'actions/checkout');
  const downloads = action(publishing, 'actions/download-artifact');
  const uploads = action(build, 'actions/upload-artifact');
  require(checkouts.length === 1 && checkouts[0].uses === CHECKOUT, 'checkout:reviewed-sha');
  require(downloads.length === 1 && downloads[0].uses === DOWNLOAD, 'download:reviewed-sha');
  const checkout = checkouts[0];
  require(checkout?.with?.ref === '${{ github.sha }}', 'checkout:event-sha');
  require(checkout?.with?.['persist-credentials'] === false, 'checkout:no-credentials');
  require(checkout?.with?.path === 'trusted-source', 'checkout:trusted-source');
  const sparse = String(checkout?.with?.['sparse-checkout'] ?? '')
    .trim()
    .split(/\s+/)
    .sort();
  require(JSON.stringify(sparse) ===
    JSON.stringify(['package.json', 'scripts/publish-release']), 'checkout:only-helper-and-manifest');
  require(checkout?.with?.['sparse-checkout-cone-mode'] === false, 'checkout:no-cone');
  const admission = publishing.steps.find((s) => s.run?.trim() === `${HELPER} admit`);
  const publication = publishing.steps.find((s) => s.run?.trim() === `${HELPER} publish`);
  require(admission !== undefined, 'source:absolute-admit');
  require(publication !== undefined, 'publish:absolute-helper');
  for (const step of [admission, publication]) {
    if (!step) continue;
    const env = envFor(release, publishing, step);
    for (const [key, path] of Object.entries(PATHS)) require(env[key] === path, `paths:${key}`);
    require(env.RELEASE_TAG === '${{ github.event.release.tag_name }}', 'source:event-tag');
    require(env.RELEASE_PRERELEASE === '${{ github.event.release.prerelease }}', 'source:event-prerelease');
    require(env.GITHUB_SHA === undefined || env.GITHUB_SHA === '${{ github.sha }}', 'source:event-sha');
  }
  const download = downloads[0];
  require(download?.with?.name === 'package-tarball' &&
    Object.keys(download?.with ?? {}).every((key) => ['name', 'path'].includes(key)), 'download:one-named-artifact');
  require(pathOf(download?.with?.path, envFor(release, publishing, download)) ===
    PATHS.ARTIFACT_DIRECTORY, 'download:isolated-absolute-intake');
  require(checkout &&
    admission &&
    download &&
    publication &&
    publishing.steps.indexOf(checkout) < publishing.steps.indexOf(admission) &&
    publishing.steps.indexOf(admission) < publishing.steps.indexOf(download) &&
    publishing.steps.indexOf(download) < publishing.steps.indexOf(publication), 'order:source-before-download');
  require(uploads.length === 1 &&
    uploads[0].with?.name === 'package-tarball' &&
    uploads[0].with?.path === 'package.tgz', 'upload:exact-tarball');
  const buildCommands = instructions(build);
  const stage = buildCommands.findIndex((line) =>
    /(?:^|\s|\/)scripts\/publish-release\/run\.sh["']?\s+stage$/.test(line),
  );
  for (const gate of [
    'npm ci',
    'npm run build',
    'npm test',
    'npm run test:examples',
    'npx publint',
    'npx @arethetypeswrong/cli --pack',
  ])
    require(stage >= 0 &&
      buildCommands.indexOf(gate) >= 0 &&
      buildCommands.indexOf(gate) < stage, `gates:before-stage:${gate}`);
  require(buildCommands.indexOf('npm pack') > stage && stage >= 0, 'pack:after-stage');
  for (const line of instructions(publishing)) {
    if (/^(?:command\s+)?(?:npm|npx)\s/.test(line))
      require(/^npm install -g npm@11\.19\.0$/.test(line), 'publish:no-dependency-or-floating-tool');
  }
  require(!instructions(build).some((line) => /^npm version\b/.test(line)), 'build:no-version-lifecycle');
  require(permission(docs.permissions, 'pages') !== 'write' &&
    permission(docs.permissions, 'id-token') !== 'write', 'docs:no-top-level-write');
  for (const [name, job] of Object.entries(docs.jobs))
    require(name === 'deploy' ||
      (permission(job.permissions, 'pages') !== 'write' &&
        permission(job.permissions, 'id-token') !== 'write'), 'docs:write-only-deploy');
  const docsBuild = docs.jobs.build;
  const deploy = docs.jobs.deploy;
  require(permission(deploy?.permissions, 'pages') === 'write' &&
    permission(deploy?.permissions, 'id-token') === 'write', 'docs:deploy-permissions');
  require(deploy?.needs === 'build' ||
    (Array.isArray(deploy?.needs) && deploy.needs.includes('build')), 'docs:deploy-needs-build');
  for (const [event, prerelease, expected] of [
    ['push', false, true],
    ['release', false, true],
    ['release', true, false],
  ] as const) {
    const a = condition(docsBuild?.if, event, prerelease);
    const b = condition(deploy?.if, event, prerelease);
    require(a !== undefined && b !== undefined && (a && b) === expected, `docs:release-guard:${event}:${prerelease}`);
  }
  return [...new Set(problems)];
}
