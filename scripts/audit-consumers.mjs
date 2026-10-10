#!/usr/bin/env node
/**
 * audit-consumers.mjs — run every family consumer's own checks against a footprintjs candidate.
 *
 * WHY: hcifootprint 2.6.0 broke on every fresh install after footprintjs 9.36 removed internals it
 * imported from `footprintjs/advanced`, and nobody noticed for weeks. Now no footprintjs release
 * tags until every consumer in `scripts/family.json` passes its own checks on the candidate:
 * `.github/workflows/consumers.yml` runs this script once per consumer, and `scripts/release.sh`
 * refuses to tag unless that workflow is green for HEAD.
 *
 * Per consumer, in a fresh workspace where `footPrint` links to this tree:
 *   1. clone its default branch (and any sibling checkout it needs), install it, run its `setup`;
 *   2. save exact candidate/registry replacements in the disposable manifest, then run its checks;
 *   3. if a step is red, run the same steps again on the PUBLISHED footprintjs:
 *        red on both               → the consumer's own failure: reported, not blocking;
 *        red only on the candidate → BLOCKING.
 * It also counts the consumer's imports from `footprintjs/advanced`, as a measurement only.
 * docs/guides/consumer-audit.md says how to read a run and how to add a consumer.
 *
 * Usage: npm run audit:consumers -- [--local] [--only <name,…>] [--candidate <tgz>] [--org <dir>] [--apt] [--keep]
 *   --local      clone the checkouts under the org root, not GitHub. They can be stale; CI is the gate.
 *   --only       audit these consumers only (package or directory names)
 *   --candidate  audit this tarball; default: build and pack this tree
 *   --org        the org root for --local; default: this repository's parent directory
 *   --apt        install each consumer's `apt` packages with apt-get (CI); otherwise they must be on PATH
 *   --keep       keep the workspace (it is removed by default)
 * Exit code: 1 when a consumer is BLOCKING or could not be audited, else 0.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import semver from 'semver';

import { importsIn, recordSymbols } from './doors.mjs';
import { inspectFoottraceWorkspace } from './foottrace-install.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = process.env.GITHUB_ACTIONS === 'true';
const SOURCE_FILES = /\.(m|c)?(t|j)sx?$/;
const CONCRETE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const DEPENDENCY_FIELDS = [...CONCRETE_FIELDS, 'peerDependencies'];

function parseArgs(argv) {
  const opts = { local: false, only: null, candidate: null, org: dirname(REPO_ROOT), apt: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--local') opts.local = true;
    else if (flag === '--apt') opts.apt = true;
    else if (flag === '--keep') opts.keep = true;
    else if (flag === '--only') opts.only = argv[++i].split(',');
    else if (flag === '--candidate') opts.candidate = resolve(argv[++i]);
    else if (flag === '--org') opts.org = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  return opts;
}

// ── running things ────────────────────────────────────────────────────────────

/**
 * Run one shell command in `cwd` with its output streamed; `{ ok, seconds }`. In CI the output is
 * data: between `stop-commands` and its random token, nothing a consumer prints (a test reporter's
 * `::error`) becomes a workflow command, so the run's annotations are this audit's verdicts.
 */
function run(command, cwd) {
  const started = Date.now();
  const token = randomUUID();
  console.log(CI ? `::group::${command}\n::stop-commands::${token}` : `\n$ ${command}    # in ${cwd}`);
  const { status } = spawnSync('bash', ['-c', command], { cwd, stdio: 'inherit' });
  if (CI) console.log(`::${token}::\n::endgroup::`);
  return { ok: status === 0, seconds: Math.round((Date.now() - started) / 1000) };
}

const read = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const latestVersions = new Map();
const latest = (pkg) => {
  if (!latestVersions.has(pkg)) latestVersions.set(pkg, read('npm', ['view', `${pkg}@latest`, 'version']));
  return latestVersions.get(pkg);
};

/** Clone `repo` (from GitHub, or with --local from its checkout) into `dest`; a note when it cannot. */
function clone({ repo, branch, dir }, dest, opts) {
  if (!opts.local) {
    const cloned = run(
      `git clone --quiet --depth 1 --branch ${branch} https://github.com/${repo}.git ${quote(dest)}`,
      REPO_ROOT,
    );
    return cloned.ok ? null : `could not clone ${repo}`;
  }
  const src = join(opts.org, dir);
  if (!existsSync(join(src, '.git'))) return `no checkout at ${src}`;
  if (!run(`git clone --quiet ${quote(src)} ${quote(dest)}`, REPO_ROOT).ok) return `could not clone ${src}`;
  let behind = '?';
  try {
    behind = read('git', ['rev-list', '--count', `HEAD..origin/${branch}`], src);
  } catch {
    // no origin/<branch> in this checkout: distance unknown
  }
  const head = read('git', ['rev-parse', '--abbrev-ref', 'HEAD'], src);
  const sha = read('git', ['rev-parse', '--short', 'HEAD'], src);
  console.warn(`  local ${dir}: ${head} @ ${sha}, ${behind} commit(s) behind origin/${branch} as last fetched`);
  return null;
}

// ── one leg: footprintjs swapped in, then the consumer's checks ──────────────

/** Only the named audit packages may change; all other declarations and metadata stay original. */
export function auditManifestProblem(before, after, packages) {
  const withoutOverrides = (manifest) => {
    const rest = structuredClone(manifest);
    for (const field of CONCRETE_FIELDS) {
      if (!rest[field] || typeof rest[field] !== 'object') continue;
      for (const name of packages) delete rest[field][name];
      if (!Object.keys(rest[field]).length) delete rest[field];
    }
    return rest;
  };
  return isDeepStrictEqual(withoutOverrides(before), withoutOverrides(after))
    ? null
    : 'audit installation changed unrelated manifest declarations or metadata';
}

/** Change only concrete installation requests; peer requirements remain the consumer's own. */
export function auditInstallManifest(original, replacements) {
  const planned = structuredClone(original);
  for (const [name, spec] of replacements) {
    const fields = CONCRETE_FIELDS.filter((field) => Object.hasOwn(planned[field] ?? {}, name));
    if (!fields.length) fields.push('devDependencies');
    for (const field of fields) {
      planned[field] ??= {};
      planned[field][name] = spec;
    }
  }
  return planned;
}

/** npm can shadow a peer with the same package's dev dependency, even in a linked graph. */
export function auditPeerProblem(original, replacements) {
  for (const [name, version] of replacements) {
    if (!semver.valid(version)) return `${name}: invalid exact audit version ${JSON.stringify(version)}`;
    if (!Object.hasOwn(original.peerDependencies ?? {}, name)) continue;
    const range = original.peerDependencies[name];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      return `${name}: invalid original peer requirement ${JSON.stringify(range)}`;
    }
    if (!semver.satisfies(version, range)) {
      return `${name}@${version}: incompatible with original peer requirement ${JSON.stringify(range)}`;
    }
  }
  return null;
}

function auditPackageVersion(name, spec) {
  if (!spec.endsWith('.tgz')) return spec;
  const archive = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  const packed = JSON.parse(read('tar', ['-xOzf', archive, 'package/package.json']));
  if (packed.name !== name || typeof packed.version !== 'string') {
    throw new Error(`audit archive does not identify ${name}: ${archive}`);
  }
  return packed.version;
}

/** Save exact replacements only in disposable clones so npm's declared and installed trees agree. */
export function swap(dirs, spec, pins, notes, installedDirs = dirs, originalManifests = new Map()) {
  const tarball = spec.endsWith('.tgz');
  let seconds = 0;
  // Siblings are already in producer order in family.json. Refresh their manifests and locks
  // before a dependent reads them; registry pins belong only to the consumer, not the first install.
  const consumer = dirs[0];
  const plans = [];
  for (const dir of [...dirs.slice(1), consumer]) {
    const sources = new Map([
      ['footprintjs', tarball ? spec : spec.slice('footprintjs@'.length)],
      ...(dir === consumer
        ? pins.map((pin) => {
            const separator = pin.indexOf('@', 1);
            if (separator < 1) throw new Error(`invalid named audit pin: ${pin}`);
            const name = pin.slice(0, separator);
            return [name, pin.slice(separator + 1)];
          })
        : []),
    ]);
    const replacements = new Map([...sources].map(([name, source]) => [name, auditPackageVersion(name, source)]));
    const names = [...replacements.keys()];
    const packageFile = join(dir, 'package.json');
    if (!originalManifests.has(dir)) {
      const original = JSON.parse(readFileSync(packageFile, 'utf8'));
      originalManifests.set(dir, original);
      for (const name of names) {
        const declarations = DEPENDENCY_FIELDS.filter((field) => Object.hasOwn(original[field] ?? {}, name));
        notes.add(
          `${basename(dir)}: audit-only override of ${name}; original ` +
            (declarations.length
              ? declarations.map((field) => `${field}.${name}=${JSON.stringify(original[field][name])}`).join(', ')
              : 'not directly declared'),
        );
      }
    }
    const original = originalManifests.get(dir);
    const peerProblem = auditPeerProblem(original, replacements);
    if (peerProblem) {
      notes.add(`${basename(dir)}: ${peerProblem}`);
      return { ok: false, seconds };
    }
    const beforeProblem = auditManifestProblem(original, JSON.parse(readFileSync(packageFile, 'utf8')), names);
    if (beforeProblem) {
      notes.add(`${basename(dir)}: ${beforeProblem}`);
      return { ok: false, seconds };
    }
    plans.push({ dir, packageFile, original, names, sources, replacements });
  }
  // Preflight every peer before changing any target, including the consumer installed last.
  for (const { dir, packageFile, original, names, replacements } of plans) {
    const planned = auditInstallManifest(original, replacements);
    writeFileSync(packageFile, `${JSON.stringify(planned, null, 2)}\n`);
    // npm keeps an installed footprintjs of the asked version, even one a tarball put there.
    if (!tarball) rmSync(join(dir, 'node_modules/footprintjs'), { recursive: true, force: true });
    // Declare the exact version, then select its artifact without rewriting peer requirements.
    // npm's external-link graph lacks child tarball provenance, so file: requirements there
    // cannot validate; the installed version and the archive's landed source are checked separately.
    const specs = dir === consumer ? [...pins, spec] : [spec];
    const step = run(`npm install --no-save --no-audit --no-fund ${specs.map(quote).join(' ')}`, dir);
    seconds += step.seconds;
    const manifestProblem = auditManifestProblem(original, JSON.parse(readFileSync(packageFile, 'utf8')), names);
    if (manifestProblem) {
      notes.add(`${basename(dir)}: ${manifestProblem}`);
      return { ok: false, seconds };
    }
    if (!step.ok) return { ok: false, seconds };
  }
  // A dependent installation must not replace an already-swapped sibling behind the audit.
  // Verify every source only after all installations, then inspect the complete dependency graph.
  for (const { dir, sources, replacements } of plans) {
    const { packages } = JSON.parse(readFileSync(join(dir, 'node_modules/.package-lock.json'), 'utf8'));
    for (const [name, source] of sources) {
      const got = packages[`node_modules/${name}`];
      const fromFile = got?.resolved?.startsWith('file:');
      const archive = source.startsWith('file:') ? source.slice('file:'.length) : source;
      const landed = source.endsWith('.tgz')
        ? fromFile && realpathSync(resolve(dir, got.resolved.slice('file:'.length))) === realpathSync(archive)
        : /^https?:\/\//.test(got?.resolved ?? '') && got?.version === replacements.get(name);
      if (!landed) {
        notes.add(`${basename(dir)}: ${name} did not resolve to ${source}`);
        return { ok: false, seconds };
      }
    }
    for (const [path, { version }] of Object.entries(packages)) {
      const nested = path.startsWith('node_modules/') && path.endsWith('/node_modules/footprintjs');
      if (nested) notes.add(`${basename(dir)}: ${path} ${version} is not swapped`);
    }
  }
  // This is installation evidence, not a consumer test: failure on both legs must still block.
  return { ok: checkFoottraceInstalls(installedDirs, notes), seconds };
}

export function checkFoottraceInstalls(dirs, notes) {
  const checked = inspectFoottraceWorkspace(dirs);
  for (const report of checked.reports) notes.add(`${basename(report.root)}: ${report.message}`);
  if (!checked.ok) notes.add(checked.message);
  return checked.ok;
}

function leg(spec, dirs, pins, checks, notes, installedDirs, originalManifests) {
  const steps = [{ key: 'install footprintjs', ...swap(dirs, spec, pins, notes, installedDirs, originalManifests) }];
  for (const check of checks) {
    steps.push(steps[0].ok ? { key: check, ...run(check, dirs[0]) } : { key: check, ok: false, skipped: true });
  }
  return steps;
}

/**
 * The rule: a step red on the candidate and green on the published footprintjs blocks. An entry with
 * `fallback: false` (a migration branch, which cannot build on the published footprintjs at all) has
 * no published leg to compare with: any red step blocks.
 */
export function judge(candidate, published, fallback = true) {
  const red = candidate.filter((step) => !step.ok);
  if (red.length === 0) return 'pass';
  if (!fallback) return candidate[0].ok ? 'BLOCKING' : 'no verdict';
  if (!published?.[0].ok) return 'no verdict';
  const greenThere = new Set(published.filter((step) => step.ok).map((step) => step.key));
  return red.some((step) => greenThere.has(step.key)) ? 'BLOCKING' : 'own failure';
}

// ── the measurement: imports from footprintjs/advanced ────────────────────────

/** Every name the consumer's tracked source imports from `footprintjs/advanced` (`*` = the whole namespace). */
export function advancedImports(dir, record = recordSymbols(undefined, 'src/advanced.ts')) {
  const names = new Set();
  let lines = 0;
  const files = read('git', ['ls-files'], dir).split('\n');
  for (const file of files.filter((f) => SOURCE_FILES.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const imported of importsIn(text, file).filter((row) => row.spec === 'footprintjs/advanced')) {
      lines++;
      imported.names.forEach((name) => names.add(name));
    }
  }
  const sorted = [...names].sort();
  return {
    lines,
    record: sorted.filter((n) => record.has(n)),
    other: sorted.filter((n) => !record.has(n)),
    unresolved: names.has('*'),
  };
}

// ── one consumer ─────────────────────────────────────────────────────────────

function audit(entry, ws, ctx, opts) {
  const started = Date.now();
  const result = { entry, verdict: 'no verdict', notes: new Set(), candidate: [], published: null, sha: '?' };
  const done = () => ({ ...result, notes: [...result.notes], seconds: Math.round((Date.now() - started) / 1000) });
  const stop = (note) => {
    result.notes.add(note);
    return done();
  };
  const home = join(ws, entry.package);
  mkdirSync(home);
  symlinkSync(REPO_ROOT, join(home, 'footPrint'));

  for (const tool of entry.apt ?? []) {
    const ready = opts.apt
      ? run(`sudo apt-get update -qq && sudo apt-get install -y -qq ${tool}`, home).ok
      : read('bash', ['-c', `command -v ${tool} || true`]) !== '';
    if (!ready) return stop(`needs ${tool} on PATH (CI installs it: --apt)`);
  }
  const dir = join(home, entry.dir);
  const cloneProblem = clone(entry, dir, opts);
  if (cloneProblem) return stop(cloneProblem);
  result.sha = read('git', ['rev-parse', '--short', 'HEAD'], dir);
  const siblings = [];
  for (const sibling of entry.siblings ?? []) {
    const sibDir = join(home, sibling.dir);
    const problem = clone(sibling, sibDir, opts);
    if (problem) return stop(problem);
    if (!run(sibling.setup, sibDir).ok) return stop(`sibling ${sibling.dir}: \`${sibling.setup}\` failed`);
    siblings.push(sibDir);
  }
  const install =
    entry.install ?? `${existsSync(join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install'} --no-audit --no-fund`;
  if (!run(install, dir).ok) return stop(`\`${install}\` failed on the consumer's own tree`);
  if (entry.setup && !run(entry.setup, dir).ok) return stop(`setup \`${entry.setup}\` failed`);
  result.advanced = advancedImports(dir, ctx.record);

  // Swapped in the consumer and in every sibling that installed footprintjs: one footprintjs in the workspace.
  const installedDirs = [dir, ...siblings];
  const dirs = installedDirs.filter((d) => d === dir || existsSync(join(d, 'node_modules/footprintjs')));
  const pins = (entry.registry ?? []).map((pkg) => `${pkg}@${latest(pkg)}`);
  const originalManifests = new Map();
  if (pins.length) result.notes.add(`from npm: ${pins.join(', ')}`);
  result.candidate = leg(ctx.candidate, dirs, pins, entry.checks, result.notes, installedDirs, originalManifests);
  const fallback = entry.fallback !== false;
  if (fallback && result.candidate.some((step) => !step.ok)) {
    result.published = leg(
      `footprintjs@${ctx.published}`,
      dirs,
      pins,
      entry.checks,
      result.notes,
      installedDirs,
      originalManifests,
    );
  }
  result.verdict = judge(result.candidate, result.published, fallback);
  return done();
}

// ── the report ───────────────────────────────────────────────────────────────

const cell = (step) => (!step ? '—' : step.skipped ? 'not run' : `${step.ok ? 'green' : 'RED'} ${step.seconds} s`);

function report(r, ctx) {
  const where = `${r.entry.repo}@${r.sha}`;
  const head = `${r.entry.package}: ${r.verdict} (${where}, ${r.seconds} s)`;
  const rows = r.candidate.map((step, i) => [step.key, cell(step), cell(r.published?.[i])]);
  const adv = r.advanced
    ? `/advanced: ${r.advanced.lines} import line(s); record symbols ${r.advanced.record.length}` +
      `${r.advanced.record.length ? ` (${r.advanced.record.join(', ')})` : ''}; others ${r.advanced.other.length}` +
      `${r.advanced.other.length ? ` (${r.advanced.other.join(', ')})` : ''}` +
      (r.advanced.unresolved ? '; namespace/dynamic/mock access needs review (not a measured zero)' : '')
    : null;
  console.log(`\n${head}`);
  for (const [key, cand, pub] of rows) console.log(`  ${key.padEnd(28)} candidate ${cand.padEnd(12)} published ${pub}`);
  for (const line of [...r.notes, adv].filter(Boolean)) console.log(`  ${line}`);

  const redOnly = r.candidate.filter((s, i) => !s.ok && r.published?.[i]?.ok).map((s) => s.key);
  const redBoth = r.candidate.filter((s, i) => !s.ok && r.published?.[i] && !r.published[i].ok).map((s) => s.key);
  const redHere = r.candidate.filter((s) => !s.ok).map((s) => s.key);
  const why = {
    BLOCKING: r.published
      ? `red only on the candidate: ${redOnly.join(', ')}`
      : `red on the candidate (fallback: false — no published leg): ${redHere.join(', ')}`,
    'own failure': `red on the published footprintjs ${ctx.published} too, so not blocking: ${redBoth.join(', ')}`,
    'no verdict': `could not be audited: ${r.notes.join('; ')}`,
  }[r.verdict];
  if (why) annotate(r.verdict === 'own failure' ? 'warning' : 'error', r, why);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### ${r.entry.package}: ${r.verdict}`,
      '',
      `\`${where}\` · candidate ${ctx.candidateVersion} · published ${ctx.published} · ${r.seconds} s`,
      '',
      '| Step | Candidate | Published |',
      '|---|---|---|',
      ...rows.map((row) => `| \`${row[0]}\` | ${row[1]} | ${row[2]} |`),
      '',
      ...[...r.notes, adv].filter(Boolean).map((line) => `- ${line}`),
      '',
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  }
}

function annotate(level, r, message) {
  if (CI) console.log(`::${level} title=${r.entry.package}: ${r.verdict}::${message}`);
  else console.log(`  ${level.toUpperCase()}: ${message}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { family } = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/family.json'), 'utf8'));
  const audited = family.filter((entry) => entry.checks);
  const consumers = opts.only
    ? audited.filter((c) => opts.only.includes(c.package) || opts.only.includes(c.dir))
    : audited;
  if (opts.only && consumers.length !== opts.only.length) {
    throw new Error(`--only names a consumer scripts/family.json does not audit: ${opts.only.join(', ')}`);
  }
  if (opts.local) {
    console.warn(
      `--local: auditing the checkouts under ${opts.org}. A local checkout can be stale (each one's distance from` +
        ' its last-fetched origin is printed below). The gate is the CI run, .github/workflows/consumers.yml.',
    );
  }

  const ws = mkdtempSync(join(tmpdir(), 'fp-consumers-'));
  let candidate = opts.candidate;
  if (!candidate) {
    if (!run('npm run build', REPO_ROOT).ok) throw new Error('the candidate does not build');
    candidate = join(ws, read('npm', ['pack', '--pack-destination', ws], REPO_ROOT).split('\n').pop());
  }
  const ctx = {
    candidate,
    candidateVersion: JSON.parse(read('tar', ['-xOzf', candidate, 'package/package.json'])).version,
    published: latest('footprintjs'),
    record: recordSymbols(undefined, 'src/advanced.ts'),
  };
  console.log(
    `candidate ${ctx.candidateVersion} (${candidate}); published footprintjs ${ctx.published}; workspace ${ws}`,
  );

  const results = [];
  for (const entry of consumers) {
    const r = audit(entry, ws, ctx, opts);
    results.push(r);
    report(r, ctx);
    if (!opts.keep) rmSync(join(ws, entry.package), { recursive: true, force: true });
  }
  if (!opts.keep) rmSync(ws, { recursive: true, force: true });

  console.log('\nconsumer audit:');
  for (const r of results) console.log(`  ${r.entry.package.padEnd(24)} ${r.verdict.padEnd(12)} ${r.seconds} s`);
  const failed = results.filter((r) => r.verdict === 'BLOCKING' || r.verdict === 'no verdict');
  console.log(
    failed.length ? `\n${failed.length} consumer(s) block this candidate.` : '\nno consumer blocks this candidate.',
  );
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
