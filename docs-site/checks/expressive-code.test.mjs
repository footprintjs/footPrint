import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { ExpressiveCodeEngine, definePlugin } from '@expressive-code/core';
import { ExpressiveCode } from 'expressive-code';
import { toHtml } from 'hast-util-to-html';

const require = createRequire(import.meta.url);
const requireCore = createRequire(resolve(dirname(require.resolve('@expressive-code/core')), '../package.json'));
const requireNested = createRequire(requireCore.resolve('postcss-nested'));
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('the scoped compatibility override resolves the patched parser in the actual core dependency chain', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.deepEqual(manifest.overrides, { '@expressive-code/core@0.44.2': { 'postcss-nested': '7.0.2' } });
  assert.equal(requireCore('./package.json').version, '0.44.2');
  assert.equal(requireNested('./package.json').version, '7.0.2');
  const parser = requireNested('postcss-selector-parser/package.json').version;
  assert.match(parser, /^7\.\d+\.\d+$/);
  const [, minor, patch] = parser.split('.').map(Number);
  assert.ok(minor > 1 || (minor === 1 && patch >= 6), `Vulnerable parser resolved: ${parser}`);
});

const cssFixtures = [
  {
    name: 'nested selectors, ampersands and selector lists',
    input: '.frame, .terminal { color: red; &:hover, &:focus-visible { color: blue; } > pre { white-space: pre; } }',
    expected: '.expressive-code .frame,.expressive-code .terminal{color:red}.expressive-code .frame:hover,.expressive-code .frame:focus-visible,.expressive-code .terminal:hover,.expressive-code .terminal:focus-visible{color:blue}.expressive-code .frame > pre,.expressive-code .terminal > pre{white-space:pre}',
  },
  {
    name: 'nested media and container rules',
    input: '.frame { @media (hover: hover) { &:hover { color: blue; } } @container (width > 10px) { .title { color: red; } } }',
    expected: '@media (hover: hover){.expressive-code .frame:hover{color:blue}}@container (width > 10px){.expressive-code .frame .title{color:red}}',
  },
  {
    name: 'at-root and keyframes',
    input: '.frame { .title { color: red; @at-root body { margin: 0; } } @keyframes pulse { from { opacity: 0; } to { opacity: 1; } } }',
    expected: '.expressive-code .frame .title{color:red}body{margin:0}@keyframes pulse{from{opacity:0}to{opacity:1}}',
  },
  {
    name: 'newline comment removes the empty parent',
    input: '.frame {\n /* title */\n .title { color: red; }\n }',
    expected: '.expressive-code .frame .title{color:red}',
  },
  ...['/* title */', ' /* first */ /* second */ '].map((comment) => ({
    name: `inline comments retain the reviewed Nested 7 empty parent: ${comment}`,
    input: `.frame {${comment}.title { color: red; }}`,
    // Nested 6 removed this parent. Nested 7 keeps its comments until core strips
    // them, leaving an empty rule. Preserve this difference without pruning it.
    expected: '.expressive-code .frame{}.expressive-code .frame .title{color:red}',
  })),
];

for (const fixture of cssFixtures) {
  test(`public plugin CSS: ${fixture.name}`, async () => {
    const engine = new ExpressiveCodeEngine({
      plugins: [definePlugin({
        name: 'docs compatibility fixture',
        hooks: { postprocessRenderedBlock: ({ addStyles }) => addStyles(fixture.input) },
      })],
    });
    const result = await engine.render({ code: 'fixture', language: 'text' });
    assert.deepEqual([...result.styles], [fixture.expected]);
  });
}

test('Nested 7 raw inline-comment placement is kept visible before core strips comments', async () => {
  const postcss = requireCore('postcss');
  const nested = requireCore('postcss-nested');
  const result = await postcss([nested()]).process('.expressive-code{.frame {/* title */.title { color: red; }}}', { from: undefined });
  assert.equal(result.css, '.expressive-code .frame {/* title */}.expressive-code .frame .title { color: red; }');
});

test('public syntax rendering, theme CSS and frame scripts match the reviewed pre-upgrade output', async () => {
  const engine = new ExpressiveCode();
  // Captured from the unchanged core 0.44.2 / Nested 6.2.0 baseline, then proved
  // byte-identical with Nested 7.0.2 on Node 22 and 24. Do not refresh blindly.
  assert.equal(hash(await engine.getBaseStyles()), '8d61661a6c1ac0d2045c20566aaa1ac86beed76a1335999670a6626fb2e36332');
  assert.equal(hash(await engine.getThemeStyles()), 'd5cc576af77f74cb83bb75943d20f3a2a93dc0c3245bc4f3649029e20624732c');
  assert.equal(hash(JSON.stringify(await engine.getJsModules())), '45d48a3049cc44f4684a6c4fc13805faf69ac055b14fd76bf3001f6f16607e79');
  const fixtures = [
    [{ code: 'export const answer: number = 42;\nconsole.log(answer);', language: 'ts', meta: 'title="flow.ts" {1} ins={2}' }, '45cb371a9876d2e1a96dc8e0bed386ecc44b5e521dd199c5cf9b1c3d076c9d58'],
    [{ code: '{ "html": "<script>&", "enabled": true }', language: 'json', meta: 'title="settings.json"' }, 'b29b528cb40adbc694e969a836dbd1c93db8ca9c7f7385712bfa0134e7126d6d'],
    [{ code: '.frame { &:hover { color: red; } }', language: 'css', meta: '{1}' }, '2d03dd4126a0c3679a39c36699fb5843a12a6fd83d8af39def6169c6c6ed9ea4'],
    [{ code: 'npm install footprintjs\nnode example.mjs', language: 'bash', meta: 'title="Terminal"' }, 'bf084d00560744d9cda31b614c7efec3ff0b15de426c61926b21e1321ceca84b'],
  ];
  for (const [input, expected] of fixtures) {
    const result = await engine.render(input);
    assert.equal(hash(toHtml(result.renderedGroupAst)), expected, input.language);
    assert.deepEqual([...result.styles], [], input.language);
  }
});
