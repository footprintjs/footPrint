/**
 * `foottrace/write` loads no footprintjs file.
 *
 * The engine writes its record through foottrace's write door. A writer who imports that door must get
 * foottrace alone, never a piece of this engine. Foottrace's export list and file layout are its own and
 * are tested in its own suite; this file checks only the edge back into this repository.
 */
import { execFileSync } from 'child_process';
import { dirname, sep } from 'path';
import { describe, expect, it } from 'vitest';

const REPO = dirname(dirname(__dirname));
const RECORD_ROOT = dirname(require.resolve('foottrace/package.json'));

/** Every module an isolated process loads for `require('foottrace/write')`. */
function loads(): string[] {
  const output = execFileSync(
    process.execPath,
    ['-e', "require('foottrace/write'); console.log(JSON.stringify(Object.keys(require.cache)));"],
    { cwd: REPO, encoding: 'utf8' },
  );
  return JSON.parse(output);
}

describe('foottrace/write — loads no footprintjs file', () => {
  const files = loads();

  it('loads files of the foottrace package', () => {
    expect(files.some((f) => f.startsWith(RECORD_ROOT + sep))).toBe(true);
  });

  it('every file it loads belongs to the foottrace package, so none is a footprintjs file', () => {
    const outside = files.filter((f) => !f.startsWith(RECORD_ROOT + sep));
    expect(outside, 'importing foottrace/write must load nothing outside foottrace').toEqual([]);
  });
});
