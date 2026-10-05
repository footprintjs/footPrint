import { afterAll, describe, expect, it } from 'vitest';

import { checkSnippets, extractSnippets } from '../../scripts/doc-snippets/index.mjs';
import { docCompilerFixture } from '../helpers/doc-compiler';

const { root, cleanup } = docCompilerFixture();
afterAll(cleanup);
const importLine = "import { flowChart } from 'footprintjs';";

describe('Markdown documentation fences', () => {
  it('checks MDX fences immediately inside JSX containers without changing Markdown HTML handling', () => {
    const lines = [
      '<Tabs>',
      '<TabItem label="TypeScript">',
      '```ts',
      importLine,
      'const value: string = 42;',
      '```',
      '</TabItem>',
      '</Tabs>',
    ];
    const text = lines.join('\r\n');
    const result = extractSnippets(text, 'tabs.mdx');
    expect(result.units).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(checkSnippets(root, result.units)).toEqual([
      expect.objectContaining({ file: 'tabs.mdx', line: 5, column: 7, code: 2322 }),
    ]);
    expect(extractSnippets(text, 'tabs.md').units).toEqual([]);
  });

  it('discovers fences in quotes, list bodies, and on list-item opening lines', () => {
    const examples = [
      ['> ```ts', `> ${importLine}`, '> const value: string = 42;', '> ```'],
      [
        '- Example:',
        '',
        '    ```typescript title="Example"',
        `    ${importLine}`,
        '    const value: string = 42;',
        '    ```',
      ],
      ['- ```ts', `  ${importLine}`, '  const value: string = 42;', '  ```'],
      ['> - ```tsx', `>   ${importLine}`, '>   const value: string = 42;', '>   ```'],
    ];
    for (const lines of examples) {
      const result = extractSnippets(lines.join('\n'), 'nested.md');
      expect(result.units).toHaveLength(1);
      expect(result.errors).toEqual([]);
      const errorLine = lines.findIndex((line) => line.includes('const value'));
      expect(checkSnippets(root, result.units)).toEqual([
        expect.objectContaining({
          file: 'nested.md',
          line: errorLine + 1,
          column: lines[errorLine].indexOf('value') + 1,
          code: 2322,
        }),
      ]);
    }
  });

  it('uses the Markdown parser for long fences and does not select nested examples or indented code', () => {
    const text = [
      '````markdown',
      '```ts',
      importLine,
      '```',
      '````',
      '',
      '    ```ts',
      `    ${importLine}`,
      '    ```',
      '',
      '````typescript',
      importLine,
      "const marker = '```';",
      '````',
      '',
      '~~~ts',
      importLine,
      '~~~',
    ].join('\n');
    const result = extractSnippets(text, 'fences.md');
    expect(result.total).toBe(2);
    expect(result.units).toHaveLength(2);
    expect(result.errors).toEqual([]);
    expect(checkSnippets(root, result.units)).toEqual([]);
  });

  it('refuses selected fences auto-closed at EOF or at the end of a list or quote', () => {
    const examples = [
      ['```ts', importLine],
      ['> ```ts', `> ${importLine}`, '', 'Outside the quote'],
      ['- ```ts', `  ${importLine}`, '', 'Outside the list'],
      ['````ts', importLine, '```'],
    ];
    for (const lines of examples) {
      const result = extractSnippets(lines.join('\n'), 'unclosed.md');
      expect(result.units).toHaveLength(1);
      expect(result.errors).toEqual([expect.objectContaining({ file: 'unclosed.md', line: 1, code: 'DOC_FENCE' })]);
    }
  });

  it('retains malformed imports and maps suppression directives through containers and CRLF', () => {
    const lines = ['> ```ts', '> // @ts-ignore', "> import { flowChart from 'footprintjs';", '> ```'];
    const result = extractSnippets(lines.join('\r\n'), 'malformed.md');
    expect(result.units).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ file: 'malformed.md', line: 2, column: 3, code: 'DOC_SUPPRESSION' }),
    ]);
    expect(checkSnippets(root, result.units)).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: 'malformed.md', line: 3, code: 1005 })]),
    );
  });

  it('maps partially expanded prefix tabs to original UTF-16 columns', () => {
    const lines = ['  ```ts', `\t${importLine}`, '\tconst value: string = 42;', '  ```'];
    const result = extractSnippets(lines.join('\r\n'), 'tabs.md');
    expect(result.errors).toEqual([]);
    const mapping = result.units[0].lineMap[1];
    expect(result.units[0].source.split('\n')[1]).toBe('  const value: string = 42;');
    expect(mapping.columns.slice(0, 3)).toEqual([1, 1, 2]);
    expect(checkSnippets(root, result.units)).toEqual([
      expect.objectContaining({ file: 'tabs.md', line: 3, column: lines[2].indexOf('value') + 1, code: 2322 }),
    ]);
  });
});
