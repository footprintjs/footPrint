/**
 * Runtime support is a package contract; the contributor default and automation
 * must agree with it. These checks pin the declared policy, while the CI matrix
 * runs the full suite on both supported LTS lines.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../..');
const read = (file: string): string => readFileSync(resolve(repo, file), 'utf8');
const literalVersions = (workflow: string): number[] =>
  [...workflow.matchAll(/^[ \t]+node-version:[ \t]*(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((version) => !version.startsWith('[') && !version.startsWith('$'))
    .map((version) => Number(version.replace(/^(['"])(.*)\1$/, '$2')));

describe('Node support policy', () => {
  it('declares Node 22 as the library minimum', () => {
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=22');
  });

  it('selects Node 24 for project development', () => {
    expect(read('.nvmrc').trim()).toBe('24');
  });

  it('runs compatibility tests on both Node 22 and 24', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/node-version:\s*\[22,\s*24\]/);
    expect(ci).toMatch(/node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/);
  });

  it.each([
    ['docs', [24, 24]],
    ['publish', [24, 24]],
  ] as const)('%s uses the contributor default for its non-matrix jobs', (workflow, expected) => {
    // Matrix expressions/lists are checked separately above. Collect every
    // literal selector, including quoted values, so another version cannot hide.
    const versions = literalVersions(read(`.github/workflows/${workflow}.yml`));
    expect(versions).toEqual(expected);
    expect(versions.every((version) => String(version) === read('.nvmrc').trim())).toBe(true);
  });

  it('lints on Node 24 while engine compatibility stays on its matrix', () => {
    const section = read('.github/workflows/ci.yml').split(/^jobs:\s*$/m)[1];
    const blocks = section.split(/^ {2}([\w-]+):\r?\n/m);
    const jobs: Record<string, string> = {};
    for (let i = 1; i < blocks.length; i += 2) jobs[blocks[i]] = blocks[i + 1];
    expect(Object.keys(jobs).sort()).toEqual(['lint', 'test']);
    expect(literalVersions(jobs.lint)).toEqual([24]);
    expect(literalVersions(jobs.test)).toEqual([]);
    expect(jobs.test).toMatch(/node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/);
  });
});
