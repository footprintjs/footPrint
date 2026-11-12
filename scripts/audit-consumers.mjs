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
 * A consumer blocks only inside the version range it declares (`consumer-range.mjs`). When one of its
 * declarations refuses the candidate's version, its checks run on the candidate's code relabelled as the
 * newest published version it accepts (`consumer-relabel.mjs`), and the result never fails the job:
 * all green → `opt-in needed`; red only on the candidate's code → `needs migration`.
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

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { quote, read, run } from './audit-process.mjs';
import { captureAuditManifests, swap } from './consumer-install.mjs';
import {
  acceptedVersion,
  describeDeclarations,
  manifestDeclarations,
  pinDeclarations,
  rangeLine,
  refusals,
  treeDeclarations,
  uniqueDeclarations,
} from './consumer-range.mjs';
import { relabelCandidate } from './consumer-relabel.mjs';
import { importsIn, recordSymbolsAt } from './doors.mjs';
export {
  auditInstallManifest,
  auditManifestProblem,
  auditPeerProblem,
  captureAuditManifests,
  checkFoottraceInstalls,
  planAuditInstall,
  swap,
} from './consumer-install.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = process.env.GITHUB_ACTIONS === 'true';
const SOURCE_FILES = /\.(m|c)?(t|j)sx?$/;

export function parseArgs(argv) {
  const opts = { local: false, only: null, candidate: null, org: dirname(REPO_ROOT), apt: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--local') opts.local = true;
    else if (flag === '--apt') opts.apt = true;
    else if (flag === '--keep') opts.keep = true;
    else if (['--only', '--candidate', '--org'].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      if (flag === '--only') opts.only = value.split(',');
      else if (flag === '--candidate') opts.candidate = resolve(value);
      else opts.org = resolve(value);
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return opts;
}

// ── running things ────────────────────────────────────────────────────────────

const latestVersions = new Map();
export const latest = (pkg, readCommand = read) => {
  if (!latestVersions.has(pkg)) latestVersions.set(pkg, readCommand('npm', ['view', `${pkg}@latest`, 'version']));
  return latestVersions.get(pkg);
};

let publishedList = null;
/** Every published footprintjs version, read once per run (`npm view footprintjs versions --json`). */
export const publishedVersions = (readCommand = read) => {
  publishedList ??= JSON.parse(readCommand('npm', ['view', 'footprintjs', 'versions', '--json']));
  return publishedList;
};

/** A registry pin's published `peerDependencies` (`npm view <name>@<version> peerDependencies --json`). */
export const publishedPeers = (pin, readCommand = read) => {
  const text = readCommand('npm', ['view', pin, 'peerDependencies', '--json']);
  return text === '' ? {} : { peerDependencies: JSON.parse(text) };
};

/** The installed tree npm left in `dir`; a packaged app has not installed yet, so its committed lock. */
export function installedTree(dir) {
  for (const file of ['node_modules/.package-lock.json', 'package-lock.json']) {
    if (existsSync(join(dir, file))) return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  throw new Error(`no npm lock in ${basename(dir)}`);
}

/** Clone `repo` (from GitHub, or with --local from its checkout) into `dest`; a note when it cannot. */
export function clone({ repo, branch, dir }, dest, opts, services = {}) {
  const io = { run, read, ...services };
  if (!opts.local) {
    const cloned = io.run(
      `git clone --quiet --depth 1 --branch ${branch} https://github.com/${repo}.git ${quote(dest)}`,
      REPO_ROOT,
    );
    return cloned.ok ? null : `could not clone ${repo}`;
  }
  const src = join(opts.org, dir);
  if (!existsSync(join(src, '.git'))) return `no checkout at ${src}`;
  if (!io.run(`git clone --quiet ${quote(src)} ${quote(dest)}`, REPO_ROOT).ok) return `could not clone ${src}`;
  let behind = '?';
  try {
    behind = io.read('git', ['rev-list', '--count', `HEAD..origin/${branch}`], src);
  } catch {
    // no origin/<branch> in this checkout: distance unknown
  }
  const head = io.read('git', ['rev-parse', '--abbrev-ref', 'HEAD'], src);
  const sha = io.read('git', ['rev-parse', '--short', 'HEAD'], src);
  console.warn(`  local ${dir}: ${head} @ ${sha}, ${behind} commit(s) behind origin/${branch} as last fetched`);
  return null;
}

// ── one leg: footprintjs swapped in, then the consumer's checks ──────────────

export function leg(spec, dirs, pins, checks, notes, installedDirs, originalManifests, options = {}) {
  const runCommand = options.runCommand ?? run;
  const steps = [
    { key: 'install footprintjs', ...swap(dirs, spec, pins, notes, installedDirs, originalManifests, options) },
  ];
  for (const check of checks) {
    steps.push(steps[0].ok ? { key: check, ...runCommand(check, dirs[0]) } : { key: check, ok: false, skipped: true });
  }
  return steps;
}

/**
 * What the consumer's declarations say about `version`: `{ declarations, refusing, line }`. FAILS
 * CLOSED: anything that cannot be read or parsed returns `{ unread }`, and the consumer is judged as
 * before, inside its range. Only a range that was parsed and refuses the version takes it out.
 * Read: the authored manifests (captured before any change) of the consumer and its participating
 * siblings, each one's installed tree, and each registry pin's published peers. A pinned package's
 * own lock entry is skipped: the pin replaces it.
 */
export function declaredRange(dirs, pins, originalManifests, version, services = {}) {
  const io = { installedTree, publishedPeers, ...services };
  try {
    const own = dirs.flatMap((d, i) => manifestDeclarations(i === 0 ? 'own' : basename(d), originalManifests.get(d)));
    // The local files are read before the registry: a tree that cannot be read stops here, offline.
    const pinned = new Set(pins.map((pin) => pin.slice(0, pin.indexOf('@', 1))));
    const tree = dirs.flatMap((d, i) => treeDeclarations(io.installedTree(d), i === 0 ? pinned : new Set()));
    const fromNpm = pins.flatMap((pin) => pinDeclarations(pin, io.publishedPeers(pin)));
    const declarations = uniqueDeclarations([...own, ...fromNpm, ...tree]);
    const refusing = refusals(declarations, version);
    return { declarations, refusing, line: rangeLine(version, refusing) };
  } catch (error) {
    return { unread: `range: not read (${String(error?.message ?? error).slice(0, 200)}); judged inside its range` };
  }
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

/**
 * The same comparison for a consumer outside its range (`candidate` = the candidate's code relabelled,
 * `published` = the accepted version). It can never block: its range keeps every install away from
 * the candidate. Green → it must only widen its range; red only on the new code → its own migration.
 */
export function judgeOutOfRange(candidate, published, fallback = true) {
  const verdict = judge(candidate, published, fallback);
  return { pass: 'opt-in needed', BLOCKING: 'needs migration' }[verdict] ?? verdict;
}

// ── the measurement: imports from footprintjs/advanced ────────────────────────

/** Every name the consumer's tracked source imports from `footprintjs/advanced` (`*` = the whole namespace). */
export function advancedImports(dir, record = recordSymbolsAt(REPO_ROOT, 'src/advanced.ts')) {
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

// ── a system tool a consumer's checks need ────────────────────────────────────

/**
 * The shell command that installs one system tool with apt-get (CI, `--apt`). A tool that is already
 * on PATH is not installed again. Each apt-get call is BOUNDED: a few tries per download, a time limit
 * per connection, and `timeout` around the whole call.
 *
 * WHY: on 2026-11-11 the runners could not resolve Ubuntu's archive for some hours. `apt-get update`
 * gave up after three and a half minutes with warnings, then `apt-get install ffmpeg` kept trying with
 * no limit, and three audits ran into the job's 60 minute timeout: no verdict, and no reason in the
 * summary. Bounded, the same failure ends this consumer's audit in about ten minutes with a note that
 * says what could not be installed.
 *
 * WHY `;` AND NOT `&&` after the update: a refresh that failed decides nothing. The install is tried
 * against whatever index is there, inside its own limit, and whether IT succeeds is the answer.
 */
export function aptInstall(tool) {
  const apt = (minutes) =>
    `sudo timeout --kill-after=15s ${minutes}m apt-get ` +
    '-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60';
  return `command -v ${tool} >/dev/null || { ${apt(4)} update -qq; ${apt(6)} install -y -qq ${tool}; }`;
}

/**
 * What the audit says when {@link aptInstall} failed. `timeout` ends a call that ran past its limit
 * with status 124, or 137 when it had to kill it; any other status is apt-get's own (a package it
 * could not find, a lock, a broken download). The two are told apart, because "the archive did not
 * answer" and "the package is not there" are fixed by different people.
 */
export function aptFailure(tool, status) {
  const why =
    status === 124 || status === 137
      ? 'it did not finish within its time limit (a mirror or a name server may be down)'
      : `apt-get failed${typeof status === 'number' ? ` with status ${status}` : ''}`;
  return `could not install ${tool}: ${why}; see the log. Not checked`;
}

// ── one consumer ─────────────────────────────────────────────────────────────

export function audit(entry, ws, ctx, opts, services = {}) {
  const io = {
    clone,
    run,
    read,
    latest,
    advancedImports,
    leg,
    declaredRange,
    publishedVersions,
    relabelCandidate,
    ...services,
  };
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
    if (opts.apt) {
      const installed = io.run(aptInstall(tool), home);
      if (!installed.ok) return stop(aptFailure(tool, installed.status));
    } else if (io.read('bash', ['-c', `command -v ${tool} || true`]) === '') {
      return stop(`needs ${tool} on PATH (CI installs it: --apt)`);
    }
  }
  const dir = join(home, entry.dir);
  const cloneProblem = io.clone(entry, dir, opts);
  if (cloneProblem) return stop(cloneProblem);
  result.sha = io.read('git', ['rev-parse', '--short', 'HEAD'], dir);
  const originalManifests = captureAuditManifests([dir]);
  const siblings = [];
  const sourceOnly = [];
  const strategy = entry.installStrategy ?? 'linked';
  if (!['linked', 'packaged'].includes(strategy)) return stop(`unknown audit install strategy: ${strategy}`);
  if (strategy === 'packaged' && entry.install)
    return stop('packaged installation cannot override the strict install commands');
  for (const sibling of entry.siblings ?? []) {
    const sibDir = join(home, sibling.dir);
    const problem = io.clone(sibling, sibDir, opts);
    if (problem) return stop(problem);
    if (sibling.sourceOnly) {
      if (sibling.setup || strategy !== 'packaged')
        return stop('source-only siblings require packaged installation and no sibling setup');
      sourceOnly.push(sibDir);
      result.notes.add(
        `${sibling.dir}: source-only checkout; runtime dependencies come from the consumer's complete installed tree`,
      );
      continue;
    }
    if (strategy === 'packaged') return stop('packaged installation cannot include runtime-linked siblings');
    originalManifests.set(sibDir, captureAuditManifests([sibDir]).get(sibDir));
    if (!io.run(sibling.setup, sibDir).ok) return stop(`sibling ${sibling.dir}: \`${sibling.setup}\` failed`);
    siblings.push(sibDir);
  }
  if (strategy === 'linked') {
    const install =
      entry.install ?? `${existsSync(join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install'} --no-audit --no-fund`;
    if (!io.run(install, dir).ok) return stop(`\`${install}\` failed on the consumer's own tree`);
  }
  result.advanced = io.advancedImports(dir, ctx.record);

  // Install the candidate in the consumer and every participating runtime sibling that installed footprintjs.
  const installedDirs = [dir, ...siblings];
  const dirs = installedDirs.filter((d) => d === dir || existsSync(join(d, 'node_modules/footprintjs')));
  const pins = (entry.registry ?? []).map((pkg) => `${pkg}@${io.latest(pkg)}`);
  const checks = [...(entry.setup ? [entry.setup] : []), ...entry.checks];
  const installOptions = { strategy, sourceOnly, runCommand: io.run };
  if (pins.length) result.notes.add(`from npm: ${pins.join(', ')}`);
  const fallback = entry.fallback !== false;

  const range = io.declaredRange(dirs, pins, originalManifests, ctx.candidateVersion);
  result.notes.add(range.unread ?? range.line);
  let tested = { candidate: ctx.candidate, published: `footprintjs@${ctx.published}`, judge };
  if (range.refusing?.length) {
    let accepted;
    try {
      accepted = acceptedVersion(range.declarations, io.publishedVersions());
    } catch (error) {
      // Fail closed: without the version list the consumer is judged as before.
      result.notes.add(`range: published versions not read (${String(error?.message ?? error).slice(0, 200)})`);
    }
    if (accepted === null) {
      result.range = { refusing: range.refusing, accepted: null };
      result.verdict = 'own failure';
      return stop(
        `no published footprintjs satisfies every range it declares: ${describeDeclarations(range.declarations)}`,
      );
    }
    if (accepted) {
      // The report says "tested as" only once the relabelled archive exists and passed its check.
      result.range = { refusing: range.refusing };
      try {
        const relabelled = io.relabelCandidate(ctx.candidate, accepted, join(home, 'relabelled'));
        result.range.accepted = accepted;
        result.notes.add(`outside its range: the candidate's code is tested as ${accepted} (${basename(relabelled)})`);
        tested = { candidate: relabelled, published: `footprintjs@${accepted}`, judge: judgeOutOfRange };
      } catch (error) {
        return stop(`could not relabel the candidate as ${accepted}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
  }

  result.candidate = io.leg(
    tested.candidate,
    dirs,
    pins,
    checks,
    result.notes,
    installedDirs,
    originalManifests,
    installOptions,
  );
  if (fallback && result.candidate.some((step) => !step.ok)) {
    result.published = io.leg(
      tested.published,
      dirs,
      pins,
      checks,
      result.notes,
      installedDirs,
      originalManifests,
      installOptions,
    );
  }
  result.verdict = tested.judge(result.candidate, result.published, fallback);
  return done();
}

// ── the report ───────────────────────────────────────────────────────────────

const cell = (step) => (!step ? '—' : step.skipped ? 'not run' : `${step.ok ? 'green' : 'RED'} ${step.seconds} s`);

export function report(r, ctx) {
  const where = `${r.entry.repo}@${r.sha}`;
  const head = `${r.entry.package}: ${r.verdict} (${where}, ${r.seconds} s)`;
  const rows = r.candidate.map((step, i) => [step.key, cell(step), cell(r.published?.[i])]);
  const adv = r.advanced
    ? `/advanced: ${r.advanced.lines} import line(s); record symbols ${r.advanced.record.length}` +
      `${r.advanced.record.length ? ` (${r.advanced.record.join(', ')})` : ''}; others ${r.advanced.other.length}` +
      `${r.advanced.other.length ? ` (${r.advanced.other.join(', ')})` : ''}` +
      (r.advanced.unresolved ? '; namespace/dynamic/mock access needs review (not a measured zero)' : '')
    : null;
  // Outside its range the consumer was tested on the candidate's code under the accepted version.
  const accepted = r.range?.accepted;
  const asTested = accepted ? `candidate code as ${accepted}` : 'candidate';
  const publishedVersion = accepted ?? ctx.published;
  console.log(`\n${head}`);
  for (const [key, cand, pub] of rows)
    console.log(`  ${key.padEnd(28)} ${asTested} ${cand.padEnd(12)} published ${pub}`);
  for (const line of [...r.notes, adv].filter(Boolean)) console.log(`  ${line}`);

  const redOnly = r.candidate.filter((s, i) => !s.ok && r.published?.[i]?.ok).map((s) => s.key);
  const redBoth = r.candidate.filter((s, i) => !s.ok && r.published?.[i] && !r.published[i].ok).map((s) => s.key);
  const redHere = r.candidate.filter((s) => !s.ok).map((s) => s.key);
  const why = {
    BLOCKING: r.published
      ? `red only on the candidate: ${redOnly.join(', ')}`
      : `red on the candidate (fallback: false — no published leg): ${redHere.join(', ')}`,
    'own failure':
      r.range && !accepted
        ? `outside its range, and no published footprintjs satisfies it: ${r.notes.at(-1)}`
        : `red on the published footprintjs ${publishedVersion} too, so not blocking: ${redBoth.join(', ')}`,
    'no verdict': `could not be audited: ${r.notes.join('; ')}`,
    'opt-in needed': `outside its range, so not blocking; green on the candidate's code as ${accepted}: widen the range to take ${ctx.candidateVersion}`,
    'needs migration': `outside its range, so not blocking; red on the candidate's code as ${accepted} and green on the published ${accepted}: ${
      redOnly.length ? redOnly.join(', ') : redHere.join(', ')
    }`,
  }[r.verdict];
  const level = { 'opt-in needed': 'notice', 'needs migration': 'warning', 'own failure': 'warning' }[r.verdict];
  if (why) annotate(level ?? 'error', r, why);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### ${r.entry.package}: ${r.verdict}`,
      '',
      accepted
        ? `\`${where}\` · candidate ${ctx.candidateVersion} tested as ${accepted} · published ${accepted} · ${r.seconds} s`
        : `\`${where}\` · candidate ${ctx.candidateVersion} · published ${ctx.published} · ${r.seconds} s`,
      '',
      accepted
        ? `| Step | Candidate code as ${accepted} | Published ${accepted} |`
        : '| Step | Candidate | Published |',
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

export function main(argv = process.argv.slice(2), services = {}) {
  const io = { run, read, latest, audit, report, recordSymbolsAt, ...services };
  const opts = parseArgs(argv);
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
  try {
    let candidate = opts.candidate;
    if (!candidate) {
      if (!io.run('npm run build', REPO_ROOT).ok) {
        throw new Error('the candidate does not build');
      }
      candidate = join(ws, io.read('npm', ['pack', '--pack-destination', ws], REPO_ROOT).split('\n').pop());
    }
    const ctx = {
      candidate,
      candidateVersion: JSON.parse(io.read('tar', ['-xOzf', candidate, 'package/package.json'])).version,
      published: io.latest('footprintjs'),
      record: io.recordSymbolsAt(REPO_ROOT, 'src/advanced.ts'),
    };
    console.log(
      `candidate ${ctx.candidateVersion} (${candidate}); published footprintjs ${ctx.published}; workspace ${ws}`,
    );

    const results = [];
    for (const entry of consumers) {
      const r = io.audit(entry, ws, ctx, opts);
      results.push(r);
      io.report(r, ctx);
      if (!opts.keep) rmSync(join(ws, entry.package), { recursive: true, force: true });
    }

    console.log('\nconsumer audit:');
    for (const r of results) console.log(`  ${r.entry.package.padEnd(24)} ${r.verdict.padEnd(12)} ${r.seconds} s`);
    const failed = results.filter((r) => r.verdict === 'BLOCKING' || r.verdict === 'no verdict');
    console.log(
      failed.length ? `\n${failed.length} consumer(s) block this candidate.` : '\nno consumer blocks this candidate.',
    );
    const outside = results.filter((r) => r.range?.refusing?.length).map((r) => r.entry.package);
    console.log(
      outside.length
        ? `${outside.length} consumer(s) are outside their declared range for ${
            ctx.candidateVersion
          } and must opt in: ${outside.join(', ')}.`
        : `no consumer is outside its declared range for ${ctx.candidateVersion}.`,
    );
    return { exitCode: failed.length ? 1 : 0, results, workspace: ws };
  } finally {
    if (!opts.keep) rmSync(ws, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main().exitCode;
