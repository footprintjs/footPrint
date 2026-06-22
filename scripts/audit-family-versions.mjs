#!/usr/bin/env node
/**
 * audit-family-versions — fleet health check for the footprintjs package family.
 *
 * WHY: in a polyrepo, no single repo's CI can see cross-repo version drift. This scans
 * every family repo's package.json (+ known consumer apps) and flags the two failure
 * classes that have actually bitten this fleet:
 *   1. EXACT pin of a family dep  → stale-build risk (e.g. eui once pinned footprintjs 9.5.0
 *      while consumers ran 9.9.0). [error]
 *   2. bare ^0.x on a PEER dep    → 0.x carets don't cross minors, so the range silently
 *      EXCLUDES a newer published minor → consumer ERESOLVE (the lens ^0.22.0-excludes-eui-0.25
 *      incident). [error when it actually excludes the current latest]
 *   3. a non-exact range that excludes the current published latest → ERESOLVE risk. [error]
 *
 * This is the polyrepo stand-in for syncpack's single-version-policy — syncpack can't see
 * across repos. Run locally (or as a cron) from any checkout:
 *   node scripts/audit-family-versions.mjs [orgRootDir] [--deep]
 * orgRootDir defaults to the parent of this repo (the dir holding all the family checkouts).
 * --deep adds a FLEET CANARY: installs every PUBLISHED family lib together in a throwaway
 * consumer and asserts the singletons (footprintjs/react/react-dom) each resolve to ONE copy
 * (catches an emergent diamond that the declared-range audit can't see). Exits non-zero on
 * any error-class finding.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// pkg name → checkout dir name (under the org root)
const FAMILY = {
  footprintjs: 'footPrint',
  agentfootprint: 'agentfootprint',
  'agentfootprint-lens': 'agentfootprint-lens',
  'footprint-explainable-ui': 'explainable-ui',
  agentthinkingui: 'agentThinkingUI',
};
// consumer apps that depend on the family (not published; checked for drift only)
const CONSUMERS = { 'neo-agentfootprint': 'neo-agentfootprint' };

const FAMILY_NAMES = new Set(Object.keys(FAMILY));
// first NON-flag arg is the org root (so `--deep` isn't mistaken for a path)
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const orgRoot = resolve(rootArg || resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

function npmLatest(pkg) {
  try {
    // execFile (no shell) with an argument array — pkg names are controlled constants, but
    // this avoids shell interpolation entirely.
    return execFileSync('npm', ['view', pkg, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ^0.A.B → the upper-exclusive minor is 0.(A+1); returns {minor:A} or null.
function caretZeroMinor(range) {
  const m = /^\^0\.(\d+)\./.exec(range);
  return m ? Number(m[1]) : null;
}
const isExactPin = (range) => /^\d+\.\d+\.\d+$/.test(range);
const latestMinorOfZero = (v) => {
  const m = /^0\.(\d+)\./.exec(v || '');
  return m ? Number(m[1]) : null;
};

console.log(`\nfootprintjs family version audit  (org root: ${orgRoot})\n`);

const latest = {};
for (const pkg of FAMILY_NAMES) latest[pkg] = npmLatest(pkg);
console.log('published latest:');
for (const pkg of FAMILY_NAMES) console.log(`  ${pkg.padEnd(26)} ${latest[pkg] ?? '(unpublished?)'}`);
console.log('');

const errors = [];
const warnings = [];

for (const [, dir] of Object.entries({ ...FAMILY, ...CONSUMERS })) {
  const pjPath = resolve(orgRoot, dir, 'package.json');
  if (!existsSync(pjPath)) {
    console.log(`• ${dir.padEnd(24)} (not checked out — skipped)`);
    continue;
  }
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  const self = pj.name;
  const rows = [];
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [dep, range] of Object.entries(pj[field] || {})) {
      if (!FAMILY_NAMES.has(dep) || dep === self) continue;
      const isPeer = field === 'peerDependencies';
      const flags = [];
      if (isExactPin(range)) {
        const f = `EXACT pin ${range}${latest[dep] && range !== latest[dep] ? ` (latest ${latest[dep]})` : ''}`;
        flags.push(f);
        errors.push(`${self}: ${dep} is an EXACT pin (${range}) — stale-build risk`);
      }
      const cz = caretZeroMinor(range);
      const lz = latestMinorOfZero(latest[dep]);
      if (cz != null && lz != null && lz > cz) {
        // ^0.cz excludes 0.lz → the incident-b class
        flags.push(`EXCLUDES ${latest[dep]} (bare ^0.x range ${range})`);
        errors.push(`${self}: ${field}.${dep} ${range} EXCLUDES current latest ${latest[dep]} (ERESOLVE)`);
      } else if (isPeer && cz != null) {
        flags.push(`bare ^0.x peer ${range} — prefer >=0.${cz}.0 <1.0.0`);
        warnings.push(`${self}: peer ${dep} uses bare ^0.x (${range}) — a future minor will be excluded`);
      }
      rows.push(`    ${(field === 'peerDependencies' ? 'peer' : field === 'devDependencies' ? 'dev ' : 'dep ')} ${dep.padEnd(26)} ${range}${flags.length ? '   ⚠ ' + flags.join('; ') : ''}`);
    }
  }
  console.log(`• ${self} [${dir}]`);
  rows.forEach((r) => console.log(r));
}

// --deep: the FLEET CANARY. The range audit above checks DECLARED ranges; this resolves
// REALITY — installs every PUBLISHED family lib together in a throwaway consumer and asserts
// the singletons (footprintjs/react/react-dom) each collapse to ONE physical copy. Catches an
// emergent diamond: two individually-valid ranges that are jointly unsatisfiable-as-single,
// which silently breaks instanceof/Context. Opt-in (it does a real npm install).
if (process.argv.includes('--deep')) {
  console.log('\n--deep fleet canary: resolving all published family libs in a throwaway consumer…');
  const tmp = mkdtempSync(resolve(tmpdir(), 'fp-canary-'));
  try {
    const deps = { react: '^18.3.1', 'react-dom': '^18.3.1' };
    for (const pkg of FAMILY_NAMES) if (latest[pkg]) deps[pkg] = `^${latest[pkg]}`;
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ name: 'fp-fleet-canary', private: true, dependencies: deps }, null, 2),
    );
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: tmp, stdio: 'ignore' });
    let lsJson = '{}';
    try {
      lsJson = execFileSync('npm', ['ls', '--all', '--json'], {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      lsJson = e.stdout || '{}'; // npm ls exits non-zero on optional-peer warnings; JSON is still emitted
    }
    const singletons = new Set(['footprintjs', 'react', 'react-dom']);
    const versions = {};
    (function walk(node) {
      for (const [name, info] of Object.entries(node?.dependencies || {})) {
        if (singletons.has(name) && info.version) (versions[name] ||= new Set()).add(info.version);
        walk(info);
      }
    })(JSON.parse(lsJson));
    for (const name of singletons) {
      const vs = [...(versions[name] || [])];
      const dup = vs.length > 1;
      if (dup)
        errors.push(
          `--deep: ${name} resolves to MULTIPLE versions [${vs.join(', ')}] — emergent diamond (silent dual-instance)`,
        );
      console.log(`    ${name.padEnd(14)} → ${vs.length ? vs.join(', ') : '(unresolved)'}  ${dup ? '✗ DUPLICATE' : '✓'}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('');
if (errors.length) {
  console.log(`✗ ${errors.length} error(s):`);
  errors.forEach((e) => console.log(`    ${e}`));
}
if (warnings.length) {
  console.log(`⚠ ${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log(`    ${w}`));
}
if (!errors.length && !warnings.length) console.log('✓ family versions are consistent — no drift.');
console.log('');
process.exit(errors.length ? 1 : 0);
