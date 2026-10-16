import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });
const lint = async (text: string, file = 'src/lint-compatibility-fixture.ts') =>
  (await eslint.lintText(text, { filePath: path.resolve(file) }))[0].messages;

describe('development linter compatibility', () => {
  it('keeps explicit any as a warning in source, as before the tooling upgrade', async () => {
    const messages = await lint('export const value: any = 1;\n');
    expect(messages.filter((message) => message.ruleId === '@typescript-eslint/no-explicit-any')).toEqual([
      expect.objectContaining({ severity: 1 }),
    ]);
  });

  it('keeps Standard expression options while still refusing unused expressions', async () => {
    const messages = await lint(
      'declare const enabled: boolean;\ndeclare function write(): void;\nenabled && write();\nenabled ? write() : write();\n42;\n',
    );
    const expressions = messages.filter((message) => message.ruleId === '@typescript-eslint/no-unused-expressions');
    expect(expressions).toEqual([expect.objectContaining({ line: 5, severity: 2 })]);
  });

  it('keeps the renamed empty-object check active outside the deliberate declaration merge', async () => {
    const messages = await lint('export interface Empty {}\n');
    expect(messages).toContainEqual(
      expect.objectContaining({ ruleId: '@typescript-eslint/no-empty-object-type', severity: 2 }),
    );
  });
});
