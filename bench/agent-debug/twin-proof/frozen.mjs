/**
 * Checks the twin in this benchmark against the hash list frozen when its
 * writer last finished (`twin-manifest-as-built-2.txt`, `shasum -a 256` lines
 * over the writer's folder): the twin's files must be the writer's, byte for
 * byte. The first list (`twin-manifest-as-built.txt`) is kept as history:
 * the writer made one more pass between the two, on comments and one README
 * line only (README.md in this folder says how to confirm that).
 *
 * Why: the twin was written blind (RULE-2.md). Whoever placed it here has
 * seen the flowchart program, so the only proof that nobody touched it is
 * that every file still hashes as it did when the writer stopped.
 *
 * Where each listed file lives here:
 * - `src/**`, `fixtures/**`, `README.md`, `test/visible.test.mjs`, `SPEC.md`, `package.json` → `twin/` (the
 *   first four are what an agent's working folder holds; `SPEC.md` is the prose the writer was given;
 *   `package.json` is the writer's, outside the manifest like `SPEC.md`, never copied to a working folder);
 * - `expected/**` and the writer's own tests `test/rules.test.mjs`, `test/desk.test.mjs`,
 *   `test/kit.test.mjs` → `twin-proof/` (never in a working folder);
 * The writer's three tests were moved one folder away from the twin, so their paths to it changed.
 * Those edits are `TEST_EDITS` (import paths, the fixtures folder, the kit's root and expected
 * folders, nothing else); a test file is checked by undoing them and hashing the result.
 * Run: `node twin-proof/frozen.mjs` (exit 1 on any difference).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
export const LIST_FILE = join(HERE, 'twin-manifest-as-built-2.txt');
/** The first state's list, before the writer's comment pass: history, not checked. */
export const FIRST_LIST_FILE = join(HERE, 'twin-manifest-as-built.txt');

/** The edits made to the writer's tests when they moved to `twin-proof/test/`: [as written, as here]. */
export const TEST_EDITS = Object.freeze({
  'test/rules.test.mjs': [["from '../src/", "from '../../twin/src/"]],
  'test/desk.test.mjs': [
    ["from '../src/", "from '../../twin/src/"],
    ["new URL('../fixtures/', import.meta.url)", "new URL('../../twin/fixtures/', import.meta.url)"],
  ],
  'test/kit.test.mjs': [
    ["const ROOT = fileURLToPath(new URL('..', import.meta.url));", "const ROOT = fileURLToPath(new URL('../../twin/', import.meta.url));"],
    ["const EXPECTED = join(ROOT, 'expected');", "const EXPECTED = fileURLToPath(new URL('../expected/', import.meta.url));"],
  ],
});

/** Files of the list deliberately not copied, with the reason (none today). */
export const NOT_COPIED = Object.freeze({});

/** Where a listed path lives in this benchmark, or undefined when it is not copied. @param {string} rel */
export function placeOf(rel) {
  if (rel in NOT_COPIED) return undefined;
  if (rel in TEST_EDITS || rel.startsWith('expected/')) return join(HERE, rel);
  return join(BENCH, 'twin', rel);
}

const sha256 = (/** @type {string | Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/** Reads the frozen list. @returns {[string, string][]} [relative path, sha256] */
export function frozenList() {
  return readFileSync(LIST_FILE, 'utf8').trim().split('\n').map((line) => {
    const [hash, path] = line.split(/\s+/);
    return [path.replace(/^\.\//, ''), hash];
  });
}

/**
 * Compares every listed file with its copy here.
 * @returns {{ matched: string[], problems: string[], notCopied: string[], edited: string[] }}
 */
export function checkFrozen() {
  const matched = [];
  const problems = [];
  const notCopied = [];
  const edited = [];
  for (const [rel, hash] of frozenList()) {
    const place = placeOf(rel);
    if (!place) {
      notCopied.push(rel);
      continue;
    }
    if (!existsSync(place)) {
      problems.push(`missing: ${rel}`);
      continue;
    }
    let bytes = readFileSync(place);
    const edits = TEST_EDITS[/** @type {keyof typeof TEST_EDITS} */ (rel)];
    if (edits) {
      let text = bytes.toString('utf8');
      for (const [asWritten, asHere] of edits) {
        if (!text.includes(asHere)) problems.push(`${rel}: the edit ${JSON.stringify(asHere)} is not there`);
        text = text.split(asHere).join(asWritten);
      }
      bytes = Buffer.from(text, 'utf8');
      edited.push(rel);
    }
    if (sha256(bytes) === hash) matched.push(rel);
    else problems.push(`changed: ${rel}`);
  }
  return { matched, problems, notCopied, edited };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { matched, problems, notCopied, edited } = checkFrozen();
  console.log(`${matched.length} of ${frozenList().length} listed files match the frozen hashes (${edited.length} of them after undoing the listed path edits); not copied: ${notCopied.join(', ') || 'none'}.`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
