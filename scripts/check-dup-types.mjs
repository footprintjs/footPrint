#!/usr/bin/env node
/**
 * check-dup-types.mjs — Detects duplicate exported type/interface names across src/.
 *
 * A type defined in two files with different shapes caused a structural mismatch
 * that broke addSubFlowChartBranch in v3.0.9 (TraversalExtractor).
 * This script runs in the release pipeline to catch it before it ships.
 *
 * Usage: node scripts/check-dup-types.mjs
 *
 * Allowlist: types that intentionally appear in multiple files (e.g. re-exports,
 * or cases where circular dep forces a local forward-declaration).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// Types allowed to appear in more than one file.
// Each entry explains WHY it's exempt.
const ALLOWLIST = new Set([
  // ── Intentionally different types, different layers ───────────────────────

  'ScopeFactory',
  // memory/types.ts (3-param internal forward-decl) + engine/types.ts (4-param public).
  // Cannot consolidate: StageContext imports memory/types → adding engine import creates a cycle.
  // Public API exports the richer engine version.

  'StageSnapshot',
  // memory/types.ts = serializable output tree (id, stageWrites, children[]).
  // engine/types.ts = internal runtime snapshot (node, context, stageOutput).
  // Same name, completely different shapes. Advanced.ts already exports engine's as EngineStageSnapshot.
  // Rename requires a breaking change; tracked as tech debt.

  'FlowChart',
  // builder/types.ts = compiled output with required description/stageDescriptions (builder contract).
  // engine/types.ts  = minimal execution interface (traverser contract).
  // RunnableFlowChart bridges both. Intentionally separate; compatibility fixed in v3.0.10.

  'SerializedPipelineStructure',
  // builder/types.ts = builder-specific node tree (type required, icon, isLazy, subflowStructure).
  // engine/types.ts  = SerializedPipelineNode & { branchIds, subflowStructure, iterationCount }.
  // Different field sets; consolidation requires schema alignment across builder+engine.
  // Tracked as tech debt.
]);

const ROOT = new URL('../src', import.meta.url).pathname;

/** Collect all .ts files under a directory recursively (excluding test files). */
function collectFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract locally-defined (not re-exported) type names from a file.
 * We match:
 *   export type Foo = ...
 *   export interface Foo { ...
 * but NOT:
 *   export type { Foo } from ...   ← re-export, not a definition
 *   export type { Foo as Bar }     ← rename re-export
 */
function extractDefinedTypes(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const names = [];

  // export type Foo = ... or export type Foo<T> = ...
  for (const m of src.matchAll(/^export\s+type\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*=/gm)) {
    names.push(m[1]);
  }
  // export interface Foo { ...
  for (const m of src.matchAll(/^export\s+interface\s+([A-Z][A-Za-z0-9_]*)\b/gm)) {
    names.push(m[1]);
  }

  return names;
}

const files = collectFiles(ROOT);

/** Map: typeName → list of file paths that define it */
const index = new Map();

for (const file of files) {
  for (const name of extractDefinedTypes(file)) {
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(relative(ROOT, file));
  }
}

let found = 0;
for (const [name, paths] of index) {
  if (paths.length > 1 && !ALLOWLIST.has(name)) {
    console.error(`\nDuplicate type: ${name}`);
    for (const p of paths) console.error(`  src/${p}`);
    found++;
  }
}

if (found > 0) {
  console.error(`\n${found} duplicate type(s) found. Fix by consolidating to a single definition.`);
  console.error('If the duplicate is unavoidable (e.g. circular dep), add it to ALLOWLIST in scripts/check-dup-types.mjs with an explanation.');
  process.exit(1);
} else {
  console.log(`check-dup-types: OK (${index.size} exported types, no duplicates)`);
}
