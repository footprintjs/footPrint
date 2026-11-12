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
 *        red only on the candidate → the failure must repeat (step 4).
 *   4. install the same candidate again, exactly as the first time, and run its checks up to the last
 *      one red only on the candidate (`repeatKeys`, `repeatChecks`); once, never "until green":
 *        a repeated check red again          → BLOCKING;
 *        every repeated check green          → flaky: a warning naming the check, not blocking;
 *        the repeat could not be carried out → no verdict (it fails, like any audit that could not look).
 *      WHY: on 12 Nov 2026 a pull request that changed ten lines of Markdown was BLOCKING on one
 *      vizfootprint test that failed by chance on the candidate leg and passed on the published leg.
 *      A check that fails and then passes on the same code says nothing about the candidate. A run
 *      where nothing is red only on the candidate runs no second candidate leg at all.
 * Two questions per consumer (`consumer-range.mjs`), answered from different facts:
 *   MAY IT BLOCK? only when its statements to users (manifests, registry pins) accept the BASE version,
 *     the version of the branch the change merges into (`--base-version`). Otherwise it reports only:
 *     all green → `opt-in needed`; red only on the candidate's code → `needs migration`; never failing.
 *     A reports-only consumer gets the same second run: green there → `flaky`; otherwise `needs migration`.
 *   UNDER WHICH LABEL? when any declaration in its install graph refuses the candidate's version, the
 *     candidate's code is installed relabelled as the newest published version all of them accept
 *     (`consumer-relabel.mjs`), and the published leg installs that version.
 * It also counts the consumer's imports from `footprintjs/advanced`, as a measurement only.
 * docs/guides/consumer-audit.md says how to read a run and how to add a consumer.
 *
 * Usage: npm run audit:consumers -- [--local] [--only <name,…>] [--candidate <tgz>] [--base-version <v>] [--org <dir>] [--apt] [--keep]
 *   --local      clone the checkouts under the org root, not GitHub. They can be stale; CI is the gate.
 *   --only       audit these consumers only (package or directory names)
 *   --candidate  audit this tarball; default: build and pack this tree
 *   --base-version  the version of the branch the candidate merges into (CI: the PR's base commit);
 *                default: the candidate's own version
 *   --org        the org root for --local; default: this repository's parent directory
 *   --apt        install each consumer's `apt` packages with apt-get (CI); otherwise they must be on PATH
 *   --keep       keep the workspace (it is removed by default)
 * Exit code: 1 when a consumer is BLOCKING or could not be audited (`no verdict`), else 0 (`flaky` too).
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import semver from 'semver';

import { quote, read, run } from './audit-process.mjs';
import { captureAuditManifests, swap } from './consumer-install.mjs';
import {
  acceptedVersion,
  decideRange,
  describeDeclarations,
  manifestDeclarations,
  optInRefusals,
  pinDeclarations,
  pinName,
  rangeLine,
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
  const opts = {
    local: false,
    only: null,
    candidate: null,
    baseVersion: null,
    org: dirname(REPO_ROOT),
    apt: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--local') opts.local = true;
    else if (flag === '--apt') opts.apt = true;
    else if (flag === '--keep') opts.keep = true;
    else if (['--only', '--candidate', '--org', '--base-version'].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      if (flag === '--only') opts.only = value.split(',');
      else if (flag === '--candidate') opts.candidate = resolve(value);
      else if (flag === '--base-version') {
        if (semver.valid(value) !== value) throw new Error(`--base-version is not a version: ${value.slice(0, 80)}`);
        opts.baseVersion = value;
      } else opts.org = resolve(value);
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
 * Every footprintjs declaration of the consumer: `{ declarations }`, each marked `statement` (to its
 * users: authored manifests, captured before any change, of the consumer and its participating
 * siblings, and each registry pin's published peers) or not (each one's installed tree). A pinned
 * package's own lock entry is skipped: the pin replaces it. FAILS CLOSED: anything that cannot be read
 * or parsed returns `{ unread }`, and the consumer is judged exactly as before (may block, real label).
 */
export function declaredRange(dirs, pins, originalManifests, services = {}) {
  const io = { installedTree, publishedPeers, ...services };
  try {
    const own = dirs.flatMap((d, i) => manifestDeclarations(i === 0 ? 'own' : basename(d), originalManifests.get(d)));
    // The local files are read before the registry: a tree that cannot be read stops here, offline.
    const pinned = new Set(pins.map(pinName));
    const tree = dirs.flatMap((d, i) => treeDeclarations(io.installedTree(d), i === 0 ? pinned : new Set()));
    const fromNpm = pins.flatMap((pin) => pinDeclarations(pin, io.publishedPeers(pin)));
    return { declarations: uniqueDeclarations([...own, ...fromNpm, ...tree]) };
  } catch (error) {
    return { unread: `range: not read (${String(error?.message ?? error).slice(0, 200)}); judged inside its range` };
  }
}

/**
 * The first comparison: a step red on the candidate and green on the published footprintjs would
 * block. An entry with `fallback: false` (a migration branch, which cannot build on the published
 * footprintjs at all) has no published leg to compare with: any red step would block.
 */
function compare(candidate, published, fallback) {
  const red = candidate.filter((step) => !step.ok);
  if (red.length === 0) return 'pass';
  if (!fallback) return candidate[0].ok ? 'BLOCKING' : 'no verdict';
  if (!published?.[0].ok) return 'no verdict';
  const greenThere = new Set(published.filter((step) => step.ok).map((step) => step.key));
  return red.some((step) => greenThere.has(step.key)) ? 'BLOCKING' : 'own failure';
}

/**
 * The checks a second candidate run must repeat before a consumer may block: those red on the
 * candidate and green on the published leg (with `fallback: false`, every red check). None when the
 * comparison would not block, and none when the candidate did not install: its checks never ran, so
 * nothing was red "once", and an install refused on the candidate blocks as before.
 *
 * WHY THE RULE. On 12 Nov 2026 a pull request that changed ten lines of one Markdown file was BLOCKING
 * on vizfootprint: one test of its own suite failed by chance on the candidate leg (`Sheet.test.tsx >
 * <Sheet> — find > Shift+Enter walks BACKWARD…`, "expected null to be '19'") and passed on the published
 * leg (Consumers run 43261862232, job 131335570060). The same happened with a StoryReel test a day
 * earlier. A step that fails and then passes on the same code says nothing about the candidate, and a
 * downstream package may hold a core change only with evidence about that change.
 */
export function repeatKeys(candidate, published, fallback = true) {
  if (!candidate[0]?.ok || compare(candidate, published, fallback) !== 'BLOCKING') return [];
  const red = candidate.slice(1).filter((step) => !step.ok);
  if (!fallback) return red.map((step) => step.key);
  const greenThere = new Set(published.filter((step) => step.ok).map((step) => step.key));
  return red.filter((step) => greenThere.has(step.key)).map((step) => step.key);
}

/**
 * What the second candidate run runs after its install: every check of the first candidate run up to
 * and including the last one it repeats, in order. WHY NOT ONLY THE RED ONES: checks depend on the
 * ones before them (vizfootprint's tests read the stylesheet `npm run build:ui` makes), and the
 * published leg ran in between, so the checkout holds what those checks built against the PUBLISHED
 * footprintjs. A test re-run alone could pass on that, and a real break would read as flaky.
 */
export function repeatChecks(candidate, keys) {
  const last = Math.max(...keys.map((key) => candidate.findLastIndex((step) => step.key === key)));
  return candidate.slice(1, last + 1).map((step) => step.key);
}

/**
 * What the second candidate run says about the repeated checks, from its steps (`repeat`, as `leg`
 * returns them; null or absent when it did not run):
 *   'red again'       a repeated check ran and is red;
 *   'green again'     the install and every check ran, every repeated check is green, and every
 *                     other check did what it did the first time (the repeated ones ran on the same
 *                     footing);
 *   'not carried out' anything else: the install red, a check skipped or missing, a step that changed.
 * FAILS CLOSED: only 'green again' can make a consumer `flaky`.
 */
export function repeatOutcome(candidate, keys, repeat) {
  const expected = repeatChecks(candidate, keys);
  if (!Array.isArray(repeat) || repeat[0]?.ok !== true) return 'not carried out';
  const ran = repeat.slice(1);
  const asPlanned = (step, i) => step?.key === expected[i] && !step.skipped && typeof step.ok === 'boolean';
  if (ran.length !== expected.length || !ran.every(asPlanned)) return 'not carried out';
  if (ran.some((step) => keys.includes(step.key) && !step.ok)) return 'red again';
  const same = ran.every((step, i) => keys.includes(step.key) || step.ok === candidate[i + 1].ok);
  return same ? 'green again' : 'not carried out';
}

/**
 * After the repeat, by who the consumer is. One that may block blocks only when a repeated check is
 * red again; a repeat that could not be carried out is an audit that could not look, and fails as
 * every such audit does. One that reports only keeps its first verdict unless the repeat was green:
 * it never blocks, and an audit hiccup must not make it.
 */
const AFTER_REPEAT = {
  mayBlock: { 'red again': 'BLOCKING', 'green again': 'flaky', 'not carried out': 'no verdict' },
  reportsOnly: { 'red again': 'needs migration', 'green again': 'flaky', 'not carried out': 'needs migration' },
};

/**
 * The rule, from the facts of every run: the candidate's steps, the published leg's (null when it did
 * not run), and the second candidate run's (see {@link repeatKeys}). A step red on the candidate and
 * green on the published footprintjs blocks only when it is red again on a second run of the same
 * candidate; green there, the consumer is `flaky`, which never blocks.
 */
export function judge(candidate, published, fallback = true, repeat = null) {
  const keys = repeatKeys(candidate, published, fallback);
  if (!keys.length) return compare(candidate, published, fallback);
  return AFTER_REPEAT.mayBlock[repeatOutcome(candidate, keys, repeat)];
}

/**
 * The same rule for a consumer that reports only (its statements refuse the base version). It can
 * never block: it has not opted in to the line the branch is on. Green → it must only widen its
 * range; red only on the candidate's code, and again on a second run → its own migration.
 */
export function judgeOutOfRange(candidate, published, fallback = true, repeat = null) {
  const keys = repeatKeys(candidate, published, fallback);
  if (keys.length) return AFTER_REPEAT.reportsOnly[repeatOutcome(candidate, keys, repeat)];
  const verdict = compare(candidate, published, fallback);
  return { pass: 'opt-in needed', BLOCKING: 'needs migration' }[verdict] ?? verdict;
}

/** The line a report carries for a repeat that ran: what it repeated and what it found. */
export function repeatNote(candidate, keys, repeat) {
  return {
    'red again': `second candidate run: red again: ${keys.join(', ')}`,
    'green again': `second candidate run: green: ${keys.join(
      ', ',
    )} (red once on the candidate, green on a second run of the same code)`,
    'not carried out':
      'second candidate run: not carried out (the candidate did not install again, or a check did not run as it did the first time), so the red checks were not confirmed',
  }[repeatOutcome(candidate, keys, repeat)];
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

const errorText = (error) => String(error?.message ?? error).slice(0, 200);

/**
 * The two answers for one consumer, turned into what the audit installs and how it judges:
 * `{ tested: { candidate, published, judge }, range }`, or `{ stop, verdict?, range }` when nothing
 * is installed. `range` is what the report and the closing lines read: `mayBlock`, `accepted` (the
 * label the code was tested under), `optIn` (its statements refuse the candidate's version and it was
 * tested), `noAccepted`. Every failure to READ leaves the consumer judged exactly as before.
 */
export function planRange(dirs, pins, originalManifests, home, ctx, io, notes) {
  const strict = { candidate: ctx.candidate, published: `footprintjs@${ctx.published}`, judge };
  const base = ctx.baseVersion ?? ctx.candidateVersion;
  const found = io.declaredRange(dirs, pins, originalManifests);
  let decision;
  try {
    if (found.unread) throw new Error(found.unread);
    decision = decideRange(found.declarations, base, ctx.candidateVersion);
  } catch (error) {
    notes.add(`range: not read (${errorText(error)}); judged as before: it can block, the candidate as is`);
    return { tested: strict, range: undefined };
  }
  const range = { mayBlock: decision.mayBlock };
  const line = (more = {}) => rangeLine({ base, candidate: ctx.candidateVersion, decision, ...more });
  const tested = { ...strict, judge: decision.mayBlock ? judge : judgeOutOfRange };
  if (!decision.candidateRefusing.length) {
    notes.add(line());
    return { tested, range };
  }

  let accepted;
  try {
    accepted = acceptedVersion(found.declarations, io.publishedVersions());
  } catch (error) {
    // Without the version list nothing can be relabelled: the real candidate is installed. Whether it
    // may block was already decided from statements that WERE read, so that answer stands: one that may
    // block is judged as before, and a registry outage never turns one that reports only into BLOCKING.
    notes.add(
      line({
        untested: `Published versions not read (${errorText(error)}): the real candidate is installed as is.`,
      }),
    );
    return { tested, range: { ...range, versionsUnread: true } };
  }
  if (accepted === null) {
    const none = `no published footprintjs satisfies every range it declares: ${describeDeclarations(
      found.declarations,
    )}`;
    if (decision.mayBlock) {
      // It may block, so a missing label must not excuse it: the real candidate, judged as before.
      notes.add(line({ untested: 'No published version satisfies every declaration: the candidate as is.' }));
      notes.add(none);
      return { tested: strict, range };
    }
    notes.add(line({ untested: 'No published version satisfies every declaration.' }));
    return { stop: none, verdict: 'own failure', range: { ...range, noAccepted: true } };
  }
  let relabelled;
  try {
    relabelled = io.relabelCandidate(ctx.candidate, accepted, join(home, 'relabelled'));
  } catch (error) {
    notes.add(line({ untested: `Could not be relabelled as ${accepted}.` }));
    return { stop: `could not relabel the candidate as ${accepted}: ${errorText(error)}`, range };
  }
  notes.add(line({ testedAs: accepted }));
  return {
    tested: { candidate: relabelled, published: `footprintjs@${accepted}`, judge: tested.judge },
    range: { ...range, accepted, optIn: optInRefusals(decision, ctx.candidateVersion).length > 0 },
  };
}

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

  const plan = planRange(dirs, pins, originalManifests, home, ctx, io, result.notes);
  if (plan.stop) {
    result.range = plan.range;
    if (plan.verdict) result.verdict = plan.verdict;
    return stop(plan.stop);
  }
  const tested = plan.tested;
  result.range = plan.range;

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
  // The second look, before a consumer may block (`repeatKeys`): the same candidate, installed again
  // exactly as the first time, then its checks up to the last red one. Exactly once, the same commands
  // and environment: no retry option, no changed timeout. A run with no such red check skips this.
  const keys = repeatKeys(result.candidate, result.published, fallback);
  if (keys.length) {
    result.repeated = keys;
    result.repeat = io.leg(
      tested.candidate,
      dirs,
      pins,
      repeatChecks(result.candidate, keys),
      result.notes,
      installedDirs,
      originalManifests,
      installOptions,
    );
    result.notes.add(repeatNote(result.candidate, keys, result.repeat));
  }
  result.verdict = tested.judge(result.candidate, result.published, fallback, result.repeat ?? null);
  return done();
}

// ── the report ───────────────────────────────────────────────────────────────

const cell = (step) => (!step ? '—' : step.skipped ? 'not run' : `${step.ok ? 'green' : 'RED'} ${step.seconds} s`);

export function report(r, ctx) {
  const where = `${r.entry.repo}@${r.sha}`;
  const head = `${r.entry.package}: ${r.verdict} (${where}, ${r.seconds} s)`;
  // A third column only when a second candidate run happened: a green audit's report keeps two legs.
  const again = Array.isArray(r.repeat);
  const rows = r.candidate.map((step, i) => [
    step.key,
    cell(step),
    cell(r.published?.[i]),
    ...(again ? [cell(r.repeat[i])] : []),
  ]);
  const adv = r.advanced
    ? `/advanced: ${r.advanced.lines} import line(s); record symbols ${r.advanced.record.length}` +
      `${r.advanced.record.length ? ` (${r.advanced.record.join(', ')})` : ''}; others ${r.advanced.other.length}` +
      `${r.advanced.other.length ? ` (${r.advanced.other.join(', ')})` : ''}` +
      (r.advanced.unresolved ? '; namespace/dynamic/mock access needs review (not a measured zero)' : '')
    : null;
  // A relabelled consumer was tested on the candidate's code under the accepted version.
  const accepted = r.range?.accepted;
  // The only red step was installing the relabelled archive: no check of the code ran at all.
  const relabelNotInstalled = accepted && r.candidate[0] && !r.candidate[0].ok;
  // The label could not be chosen, so a reports-only consumer's code was NOT tested under one it accepts.
  const untestedHint =
    r.range?.versionsUnread && r.range.mayBlock === false
      ? ' (the published version list could not be read, so its code was NOT tested under a version its ranges accept: the real candidate was installed as is)'
      : '';
  const installHint = relabelNotInstalled
    ? ` (the relabelled archive as ${accepted} did not install, so no check ran: this may be the audit, not the code; see the log)`
    : '';
  const asTested = accepted ? `candidate code as ${accepted}` : 'candidate';
  const publishedVersion = accepted ?? ctx.published;
  console.log(`\n${head}`);
  for (const [key, cand, pub, rep] of rows)
    console.log(
      `  ${key.padEnd(28)} ${asTested} ${cand.padEnd(12)} published ${again ? pub.padEnd(12) : pub}` +
        (again ? ` ${asTested} again ${rep}` : ''),
    );
  for (const line of [...r.notes, adv].filter(Boolean)) console.log(`  ${line}`);

  const redOnly = r.candidate.filter((s, i) => !s.ok && r.published?.[i]?.ok).map((s) => s.key);
  const redBoth = r.candidate.filter((s, i) => !s.ok && r.published?.[i] && !r.published[i].ok).map((s) => s.key);
  const redHere = r.candidate.filter((s) => !s.ok).map((s) => s.key);
  // The second run, named beside the first wherever a verdict rests on both.
  const redAgain = again ? `; red again on a second run of the same candidate: ${r.repeated.join(', ')}` : '';
  const why = {
    BLOCKING:
      (r.published
        ? `red only on the candidate${accepted ? `'s code as ${accepted}` : ''}: ${redOnly.join(', ')}`
        : `red on the candidate (fallback: false — no published leg): ${redHere.join(', ')}`) +
      redAgain +
      installHint,
    flaky:
      `red once on the candidate${accepted ? `'s code as ${accepted}` : ''}, green on a second run of the same code: ` +
      `${(r.repeated ?? []).join(', ')}. Not blocking; a check that fails by chance hides real failures, so fix it in ${
        r.entry.repo
      }`,
    'own failure': r.range?.noAccepted
      ? `reports only, and no published footprintjs satisfies its declarations: ${r.notes.at(-1)}`
      : `red on the published footprintjs ${publishedVersion} too, so not blocking: ${redBoth.join(', ')}`,
    'no verdict': `could not be audited: ${r.notes.join('; ')}`,
    'opt-in needed': `its range refuses the base, so not blocking; green on the candidate's code${
      accepted ? ` as ${accepted}` : ''
    }: widen the range to take ${ctx.candidateVersion}`,
    'needs migration':
      `its range refuses the base, so not blocking; red on the candidate's code${accepted ? ` as ${accepted}` : ''}` +
      ` (install or checks) and green on the published ${publishedVersion}: ${
        redOnly.length ? redOnly.join(', ') : redHere.join(', ')
      }${redAgain}${installHint}`,
  }[r.verdict];
  const level = {
    'opt-in needed': 'notice',
    'needs migration': 'warning',
    'own failure': 'warning',
    flaky: 'warning',
  }[r.verdict];
  if (why) annotate(level ?? 'error', r, why + untestedHint);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### ${r.entry.package}: ${r.verdict}`,
      '',
      accepted
        ? `\`${where}\` · candidate ${ctx.candidateVersion} tested as ${accepted} · published ${accepted} · ${r.seconds} s`
        : `\`${where}\` · candidate ${ctx.candidateVersion} · published ${ctx.published} · ${r.seconds} s`,
      '',
      (accepted
        ? `| Step | Candidate code as ${accepted} | Published ${accepted} |`
        : '| Step | Candidate | Published |') + (again ? ' Candidate again |' : ''),
      again ? '|---|---|---|---|' : '|---|---|---|',
      ...rows.map(([key, ...cells]) => `| \`${key}\` | ${cells.join(' | ')} |`),
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
    ctx.baseVersion = opts.baseVersion ?? ctx.candidateVersion;
    console.log(
      `candidate ${ctx.candidateVersion} (${candidate}); base ${ctx.baseVersion}; published footprintjs ${ctx.published}; workspace ${ws}`,
    );

    const results = [];
    for (const entry of consumers) {
      const r = io.audit(entry, ws, ctx, opts);
      results.push(r);
      io.report(r, ctx);
      if (!opts.keep) rmSync(join(ws, entry.package), { recursive: true, force: true });
    }

    console.log('\nconsumer audit:');
    for (const r of results) console.log(`  ${r.entry.package.padEnd(24)} ${r.verdict.padEnd(15)} ${r.seconds} s`);
    const failed = results.filter((r) => r.verdict === 'BLOCKING' || r.verdict === 'no verdict');
    console.log(
      failed.length ? `\n${failed.length} consumer(s) block this candidate.` : '\nno consumer blocks this candidate.',
    );
    // Said every time, so a check that fails by chance is seen and fixed where it lives. A run with no
    // flaky consumer prints what it printed before.
    const flaky = results.filter((r) => r.verdict === 'flaky').map((r) => r.entry.package);
    if (flaky.length)
      console.log(
        `${
          flaky.length
        } consumer(s) flaky (red once on the candidate, green on a second run of the same code): ${flaky.join(', ')}.`,
      );
    // Opt-in is a fact about statements to users: a tree-only refusal, a missing label or a failed
    // relabel is not listed here.
    const optIn = results.filter((r) => r.range?.optIn).map((r) => r.entry.package);
    console.log(
      optIn.length
        ? `${optIn.length} consumer(s) must opt in to ${ctx.candidateVersion}: ${optIn.join(', ')}.`
        : `no consumer must opt in to ${ctx.candidateVersion}.`,
    );
    const reportOnly = results.filter((r) => r.range?.mayBlock === false).map((r) => r.entry.package);
    console.log(
      reportOnly.length
        ? `${reportOnly.length} consumer(s) report only (their ranges refuse base ${
            ctx.baseVersion
          }): ${reportOnly.join(', ')}.`
        : `every consumer can block this candidate (none refuses base ${ctx.baseVersion}).`,
    );
    return { exitCode: failed.length ? 1 : 0, results, workspace: ws };
  } finally {
    if (!opts.keep) rmSync(ws, { recursive: true, force: true });
  }
}

/**
 * On a pull request the base version must be given (CI reads it from the base commit). Without it the
 * default, the candidate's own version, is the label the pull request itself writes, and that label
 * would decide who may block it. A local run and a manual (`workflow_dispatch`) run keep the default.
 */
export function requireBaseVersion(opts, env = process.env) {
  if (env.GITHUB_EVENT_NAME === 'pull_request' && !opts.baseVersion)
    throw new Error(
      "On a pull request the consumer audit needs --base-version (the version of the branch it merges into): without it the pull request's own version label would decide which consumers may block it.",
    );
}

/** The command line: refuse a pull-request run without its base, then audit. */
export function cli(argv = process.argv.slice(2), env = process.env, services = {}) {
  requireBaseVersion(parseArgs(argv), env);
  return main(argv, services);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = cli().exitCode;
