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
 *   node scripts/audit-family-versions.mjs [orgRootDir]
 * orgRootDir defaults to the parent of this repo (the dir holding all the family checkouts).
 * Exits non-zero if any error-class issue is found.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
const orgRoot = resolve(
  process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
);

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
