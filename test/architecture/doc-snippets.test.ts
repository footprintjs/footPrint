import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { analyze, checkSnippets, discoverDocuments, extractSnippets } from '../../scripts/doc-snippets/index.mjs';
import { docCompilerFixture } from '../helpers/doc-compiler';

const repository = resolve(__dirname, '../..');
const { root, cleanup } = docCompilerFixture();
const made: string[] = [];
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));
afterAll(cleanup);
const fence = (code: string, language = 'typescript') => `\n\`\`\`${language}\n${code}\n\`\`\`\n`;

describe('documentation snippet discovery', () => {
  it('includes the source README and extensionless editor instructions, not historical records or scripts', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'doc-discovery-'));
    made.push(fixture);
    for (const file of [
      'src/README.md',
      'src/lib/leaf/README.md',
      'ai-instructions/clinerules',
      'ai-instructions/windsurfrules',
      'ai-instructions/setup.sh',
      'docs/design/old.md',
      'docs/proposals/future.md',
      'docs/internals/historical.md',
    ]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), '# Fixture\n');
    }
    expect(discoverDocuments(fixture, ['src', 'ai-instructions', 'docs']).files).toEqual([
      'ai-instructions/clinerules',
      'ai-instructions/windsurfrules',
      'src/README.md',
      'src/lib/leaf/README.md',
    ]);
  });

  it('reports a missing configured root instead of silently reducing coverage', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'doc-missing-'));
    made.push(fixture);
    expect(discoverDocuments(fixture, ['README.md']).errors).toHaveLength(1);
  });

  it('finds attributed, CRLF and tilde fences without reading a nested code sample as a real fence', () => {
    const text = [
      'Title',
      '```typescript title="Example"',
      "import { flowChart } from 'footprintjs';",
      '```',
      '~~~tsx',
      "import type { FlowRecorder } from 'footprintjs';",
      '~~~',
      '````markdown',
      '```ts',
      "import { fake } from 'footprintjs';",
      '```',
      '````',
    ].join('\r\n');
    const result = extractSnippets(text, 'README.md');
    expect(result.units.map((unit: { line: number; language: string }) => [unit.line, unit.language])).toEqual([
      [3, 'typescript'],
      [6, 'tsx'],
    ]);
    expect(result.errors).toEqual([]);
  });

  it('selects real module references, including a malformed import, but not a comment or ordinary string', () => {
    const text = [
      "// import { fake } from 'footprintjs';",
      'const text = "import { fake } from \'footprintjs\';";',
      "import { flowChart from 'footprintjs';",
      "const api = await import('footprintjs');",
      "const api = require('footprintjs');",
      "export { flowChart } from 'footprintjs';",
    ]
      .map((code) => fence(code))
      .join('');
    expect(extractSnippets(text, 'README.md').units).toHaveLength(4);
  });

  it('refuses an unclosed FootPrint code fence', () => {
    expect(extractSnippets("```ts\nimport { flowChart } from 'footprintjs';", 'README.md').errors).toHaveLength(1);
  });

  it('rejects suppression comments without mistaking quoted text for a directive', () => {
    for (const directive of ['ignore', 'expect-error', 'nocheck']) {
      const result = extractSnippets(
        fence(`// @ts-${directive}\nimport { flowChart } from 'footprintjs';`),
        'README.md',
      );
      expect(result.errors).toEqual([expect.objectContaining({ code: 'DOC_SUPPRESSION', line: 3, column: 1 })]);
    }
    const quoted = extractSnippets(
      fence("import { flowChart } from 'footprintjs';\nconst text = '@ts-ignore';"),
      'README.md',
    );
    expect(quoted.errors).toEqual([]);
  });

  it('fails closed when no import-bearing snippets were found', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'doc-empty-'));
    made.push(fixture);
    for (const directory of ['docs', 'docs-site/src/content', 'examples', 'src', 'ai-instructions']) {
      mkdirSync(join(fixture, directory), { recursive: true });
    }
    for (const file of ['README.md', 'CLAUDE.md', 'AGENTS.md']) writeFileSync(join(fixture, file), '# Empty\n');
    expect(analyze(fixture).diagnostics).toEqual([expect.objectContaining({ code: 'DOC_EMPTY' })]);
  });
});

describe('strict snippet compiler', () => {
  // Compiles the whole public package from source, as hook-registry-compile and layering do, so it
  // takes their timeout: alone it runs in under a second, beside the other architecture compiles on a
  // loaded two-core CI runner it took 3.9 s on main and 5.2 s on the C5 branch (twice).
  it('checks a real public-package contract against repository source', () => {
    const units = extractSnippets(
      fence("import { FlowChartExecutor } from 'footprintjs';\nnew FlowChartExecutor(42);"),
      'real-api.md',
    ).units;
    expect(checkSnippets(repository, units)).toEqual([
      expect.objectContaining({ file: 'real-api.md', line: 4, code: 2345 }),
    ]);
  }, 60_000);

  it('keeps every compiler error and maps it back to the offending block', () => {
    const importLine = "import { flowChart, FlowChartExecutor } from 'footprintjs';";
    const sources = {
      'assignment.md': `${importLine}\nconst label: string = 42;`,
      'argument.md': `${importLine}\nnew FlowChartExecutor(42);`,
      'implicit.md': `${importLine}\nfunction identity(value) { return value; }`,
      'missing.md': `${importLine}\nmissingValue;`,
      'syntax.md': `${importLine}\nconst broken = ;`,
      'bad-import.md': "import { flowChart from 'footprintjs';",
      'null.md': `${importLine}\nconst label: string = null;`,
    };
    const units = Object.entries(sources).flatMap(([file, code]) => extractSnippets(fence(code), file).units);
    const diagnostics = checkSnippets(root, units);
    for (const [file, code] of [
      ['assignment.md', 2322],
      ['argument.md', 2345],
      ['implicit.md', 7006],
      ['missing.md', 2304],
      ['syntax.md', 1109],
      ['null.md', 2322],
    ] as const) {
      expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file, line: 4, code })]));
    }
    expect(diagnostics.some((item: { file: string }) => item.file === 'bad-import.md')).toBe(true);
  });

  it('isolates repeated names, requires declared context and checks TSX as TSX', () => {
    const documents = {
      'separate.md':
        fence("import { flowChart } from 'footprintjs'; const chart = flowChart('A', () => {}, 'a');") +
        fence("import { flowChart } from 'footprintjs'; const chart = flowChart('B', () => {}, 'b');"),
      'dynamic.md':
        fence("const api = await import('footprintjs'); const chart = api.flowChart('A', () => {}, 'a');") +
        fence("const api = await import('footprintjs'); const chart = api.flowChart('B', () => {}, 'b');"),
      'jsx.md': fence(
        "import { flowChart } from 'footprintjs';\nconst View = () => null;\nconst view = <View />;",
        'tsx',
      ),
      'undeclared.md': fence("import { flowChart } from 'footprintjs'; executor.run();"),
    };
    const units = Object.entries(documents).flatMap(([file, text]) => extractSnippets(text, file).units);
    const diagnostics = checkSnippets(root, units);
    expect(diagnostics.map((item: { file: string; code: number }) => [item.file, item.code])).toEqual([
      ['undeclared.md', 2304],
    ]);
  });

  it('does not hide a duplicate declaration within one fence', () => {
    const units = extractSnippets(
      fence("import { flowChart } from 'footprintjs'; const value = 1; const value = 2;"),
      'duplicate.md',
    ).units;
    expect(checkSnippets(root, units)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2451 })]));
    expect(() => checkSnippets(root, [...units, ...units])).toThrow('Duplicate snippet identity');
  });

  it('does not let one example supply ambient globals to another', () => {
    const provider = extractSnippets(
      fence("import { flowChart } from 'footprintjs'; declare global { var suppliedElsewhere: string; }"),
      'provider.md',
    ).units;
    const consumer = extractSnippets(
      fence("import { flowChart } from 'footprintjs'; const value: string = suppliedElsewhere;"),
      'consumer.md',
    ).units;
    expect(checkSnippets(root, [...provider, ...consumer])).toEqual([
      expect.objectContaining({ file: 'consumer.md', code: 2304 }),
    ]);
  });

  it('does not expose other fences as importable virtual dependencies', () => {
    const provider = extractSnippets(
      fence("import { flowChart } from 'footprintjs'; export const label = 'hidden';"),
      'provider.md',
    ).units;
    const consumer = extractSnippets(
      fence("import { flowChart } from 'footprintjs'; import { label } from './provider.md.__snippet_1';"),
      'consumer.md',
    ).units;
    expect(checkSnippets(root, [...provider, ...consumer])).toEqual([
      expect.objectContaining({ file: 'consumer.md', code: 2307 }),
    ]);
  });

  it('resolves imports beside the document and reports errors in imported source too', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'doc-relative-'));
    made.push(fixture);
    writeFileSync(join(fixture, 'helper.ts'), "export const label: string = 'example';\n");
    const units = extractSnippets(
      fence(
        "import { flowChart } from 'footprintjs';\nimport { label } from './helper';\nflowChart(label, () => {}, 'example');",
      ),
      join(fixture, 'README.md'),
    ).units;
    expect(checkSnippets(root, units)).toEqual([]);
    writeFileSync(join(fixture, 'helper.ts'), 'export const label: string = 42;\n');
    expect(checkSnippets(root, units)).toEqual([
      expect.objectContaining({ file: expect.stringContaining('helper.ts'), code: 2322, line: 1 }),
    ]);
    const missing = extractSnippets(
      fence("import { flowChart } from 'footprintjs';\nimport { label } from './missing';"),
      join(fixture, 'README.md'),
    ).units;
    expect(checkSnippets(root, missing)).toEqual([expect.objectContaining({ code: 2307, line: 4 })]);
  });

  it('the CLI returns failure for diagnostics and unexpected compiler failures', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'doc-cli-'));
    made.push(fixture);
    const scripts = join(fixture, 'scripts');
    mkdirSync(join(scripts, 'doc-snippets'), { recursive: true });
    writeFileSync(
      join(scripts, 'check-doc-snippets.mjs'),
      readFileSync(join(repository, 'scripts/check-doc-snippets.mjs')),
    );
    for (const body of [
      "export const analyze = () => ({ diagnostics: ['failed'] }); export const format = () => 'fixture diagnostic';",
      "export const analyze = () => { throw new Error('fixture compiler failed'); }; export const format = () => '';",
    ]) {
      writeFileSync(join(scripts, 'doc-snippets/index.mjs'), body);
      const result = spawnSync(process.execPath, [join(scripts, 'check-doc-snippets.mjs')], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('fixture');
    }
  });
});
