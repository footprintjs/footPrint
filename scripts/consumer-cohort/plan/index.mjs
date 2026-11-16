/** Closed, nonpublishing CI inputs. Missing source/versions are refusals, never defaults. */
import { createHash } from 'node:crypto';
import semver from 'semver';

export const recipes = Object.freeze({
  agentfootprint: { repo: 'footprintjs/agentfootprint', dir: 'agentfootprint', build: 'npm run build' },
  'agentfootprint-lens': {
    repo: 'footprintjs/agentfootprint-lens',
    dir: 'agentfootprint-lens',
    build: 'npm run build',
  },
  'footprint-explainable-ui': { repo: 'footprintjs/explainable-ui', dir: 'explainable-ui', build: 'npm run build' },
});
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('unknown plan field');
}
function unique(rows, label) {
  if (!Array.isArray(rows) || rows.length > 20 || rows.some((r) => !record(r) || typeof r.package !== 'string'))
    throw new Error(`invalid ${label}`);
  if (new Set(rows.map((r) => r.package)).size !== rows.length) throw new Error(`duplicate ${label}`);
}
function source(row) {
  if (!Number.isSafeInteger(row.pr) || row.pr < 1 || !sha(row.head)) throw new Error('source needs a PR and full SHA');
}
function version(value) {
  if (typeof value !== 'string' || value.length > 64 || semver.valid(value) !== value)
    throw new Error('invalid exact version');
}

/** No own commit in this file: its source identity is observed before build from the CI event. */
export function admitPlan(bytes, family, sourceVersion) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) throw new Error('plan exceeds bound');
  const plan = JSON.parse(bytes.toString('utf8'));
  keys(plan, ['schema', 'engineVersion', 'consumers', 'packages', 'registry']);
  if (plan.schema !== 1) throw new Error('unsupported plan schema');
  version(plan.engineVersion);
  const next = semver.parse(plan.engineVersion);
  const base = semver.parse(sourceVersion);
  if (
    !base ||
    !next.prerelease.length ||
    next.prerelease[0] !== 'rc' ||
    next.prerelease.length !== 2 ||
    !Number.isSafeInteger(next.prerelease[1]) ||
    !['patch', 'minor', 'major'].some((kind) => semver.inc(base, kind) === `${next.major}.${next.minor}.${next.patch}`)
  )
    throw new Error('engine audit label must be a one-bump rc');
  for (const key of ['consumers', 'packages', 'registry']) unique(plan[key], key);
  const expected = family.filter((row) => row.checks);
  if (
    plan.consumers.length !== expected.length ||
    expected.some((row) => !plan.consumers.some((r) => r.package === row.package))
  )
    throw new Error('plan must name every configured consumer exactly once');
  const heads = new Map();
  const bind = (repo, row) => {
    source(row);
    if (heads.has(repo) && (heads.get(repo).head !== row.head || heads.get(repo).pr !== row.pr))
      throw new Error(`conflicting source heads for ${repo}`);
    heads.set(repo, { head: row.head, pr: row.pr });
  };
  for (const row of plan.consumers) {
    keys(row, ['package', 'pr', 'head', 'siblings']);
    const spec = expected.find((entry) => entry.package === row.package);
    bind(spec.repo, row);
    unique(row.siblings, 'siblings');
    if (row.siblings.length !== (spec.siblings ?? []).length) throw new Error('source sibling omitted');
    for (const sibling of row.siblings) {
      keys(sibling, ['package', 'pr', 'head']);
      const configured = (spec.siblings ?? []).find((s) => s.dir === sibling.package);
      if (!configured || !configured.sourceOnly) throw new Error('unsupported runtime sibling');
      bind(configured.repo, sibling);
    }
  }
  for (const row of plan.packages) {
    keys(row, ['package', 'pr', 'head', 'version']);
    if (!Object.hasOwn(recipes, row.package)) throw new Error('no reviewed source package recipe');
    version(row.version);
    bind(recipes[row.package].repo, row);
  }
  const allowed = new Set(family.filter((row) => row.published).map((row) => row.package));
  for (const row of plan.registry) {
    keys(row, ['package', 'version', 'integrity']);
    version(row.version);
    if (
      !allowed.has(row.package) ||
      row.package === 'footprintjs' ||
      plan.packages.some((r) => r.package === row.package) ||
      typeof row.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity)
    )
      throw new Error('invalid or conflicting registry selection');
  }
  if (!plan.registry.some((row) => row.package === 'foottrace')) throw new Error('expected Foottrace missing');
  return { ...plan, hash: hash(bytes) };
}

/** Every family range in an authored root must accept its selected version, including prereleases. */
export function requireRanges(manifest, selections, familyNames, includeDev = true) {
  for (const field of [
    'dependencies',
    ...(includeDev ? ['devDependencies'] : []),
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const alias =
        typeof range === 'string' &&
        [...familyNames].some((target) => range === `npm:${target}` || range.startsWith(`npm:${target}@`));
      if (alias) throw new Error(`${manifest.name}: unsupported family alias ${name}`);
      if (!familyNames.has(name)) continue;
      const selected = selections.get(name);
      if (
        !selected ||
        typeof range !== 'string' ||
        range.length > 1024 ||
        !semver.validRange(range) ||
        (!(field === 'devDependencies' && ['footprintjs', 'agentfootprint'].includes(name)) &&
          !semver.satisfies(selected.version, range))
      )
        throw new Error(`${manifest.name}: ${field}.${name} refuses the selected cohort`);
    }
  }
}

/** Source graph from manifests, never plan-provided edges. A missing producer or cycle refuses. */
export function buildOrder(rows, manifests) {
  const pending = new Map(rows.map((row) => [row.package, row]));
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((row) => {
      const manifest = manifests.get(row.package);
      if (!manifest) throw new Error(`source manifest missing: ${row.package}`);
      return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].every((field) =>
        Object.keys(manifest[field] ?? {}).every((name) => !pending.has(name)),
      );
    });
    if (!ready.length) throw new Error('source package dependency cycle');
    for (const row of ready) {
      ordered.push(row);
      pending.delete(row.package);
    }
  }
  return ordered;
}

/** Resolve only fixed public GitHub PR endpoints. A changed head cannot be silently substituted. */
export async function verifyHead(repo, row, get = fetch) {
  const response = await get(`https://api.github.com/repos/${repo}/pulls/${row.pr}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`cannot read ${repo} PR${row.pr}: HTTP ${response.status}`);
  const pr = await response.json();
  if (
    pr.state !== 'open' ||
    pr.head?.sha !== row.head ||
    pr.head?.repo?.full_name !== repo ||
    pr.base?.repo?.full_name !== repo
  )
    throw new Error(`${repo} PR${row.pr}: source head moved or repository differs`);
}
