/**
 * Checks a fixture name given by the model: a plain name of a file in the
 * working copy's `fixtures/` folder, with or without `.json`.
 * Example: `checkFixture(dir, 'school-paper.json')` → `'school-paper'`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} workdir @param {string} name @returns {string} */
export function checkFixture(workdir, name) {
  const bare = String(name).replace(/^fixtures\//, '').replace(/\.json$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(bare) || !existsSync(join(workdir, 'fixtures', `${bare}.json`))) {
    const known = readdirSync(join(workdir, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    throw new Error(`no fixture "${name}". Fixtures: ${known.join(', ')}`);
  }
  return bare;
}
