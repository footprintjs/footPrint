/** The canonical public contracts that replaced the expired compatibility doors keep working. */
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ResumeEntry } from '../../src/advanced';
import { hasCircularReference } from '../../src/lib/capture/circular';
import { summarizeValue } from '../../src/lib/capture/summarize';
import { disableDevMode, enableDevMode, isDevMode } from '../../src/lib/devMode';

const root = resolve(__dirname, '../..');
const doors = ['index', 'advanced', 'recorders', 'trace', 'detach', 'zod', 'sinks'];
const paths = doors.map((door) => join(root, 'src', `${door}.ts`));
const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  root,
);
const program = ts.createProgram(paths, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();

function exportsOf(door: string): readonly ts.Symbol[] {
  const file = program.getSourceFile(join(root, 'src', `${door}.ts`));
  if (!file) throw new Error(`Missing public door: ${door}`);
  const symbol = checker.getSymbolAtLocation(file);
  if (!symbol) throw new Error(`Missing public module: ${door}`);
  return checker.getExportsOfModule(symbol);
}

describe('canonical public contracts', () => {
  it('NarrativeFormatter is on the main and recorders doors', () => {
    for (const door of ['index', 'recorders']) {
      expect(
        exportsOf(door).map((symbol) => symbol.name),
        door,
      ).toContain('NarrativeFormatter');
    }
  });

  it.each(['TraverserOptions', 'HandlerDeps'])('%s accepts the resume owner', (name) => {
    const exported = exportsOf('advanced').find((symbol) => symbol.name === name);
    if (!exported) throw new Error(`Missing public type: ${name}`);
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const properties = checker
      .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target))
      .map((symbol) => symbol.name);
    expect(properties).toContain('resume');
  });

  it('preserves explicit, public seed-only ResumeEntry plans and their one-shot law', () => {
    const entry = ResumeEntry.fromCaptures({ child: { previous: 7 } });
    expect(entry.start).toBeUndefined();
    expect(entry.enterSubflow('child')).toEqual({ subflowId: 'child', seed: { previous: 7 } });
    expect(entry.enterSubflow('child')).toBeUndefined();
    expect(entry.spent).toBe(true);
  });
});

describe('canonical leaf modules', () => {
  it('keeps the canonical dev flag, cycle probe and value summary working', () => {
    try {
      disableDevMode();
      expect(isDevMode()).toBe(false);
      enableDevMode();
      expect(isDevMode()).toBe(true);
      expect(hasCircularReference({ value: 1 })).toBe(false);
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(hasCircularReference(cyclic)).toBe(true);
      expect(summarizeValue(7)).toBe('7');
    } finally {
      disableDevMode();
    }
  });
});
