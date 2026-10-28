/**
 * The timer law — every wait of a caller-supplied length is armed by `timers/longTimeout.ts · setLongTimeout`.
 *
 * WHY: a host timer holds at most 2^31 − 1 ms, and Node turns a longer delay — `Infinity` included — into 1 ms. A raw
 * `setTimeout(fn, limit)` whose limit the caller chose therefore gives up at once exactly when it was asked to wait
 * longest. Six sites did, until each was routed through the one law. This test reads every source file under `src/`
 * and refuses, outside the law's own file, every way of reaching a host timer the law has not vetted:
 *
 *   raw-delay             `setTimeout` / `setInterval` (direct, or `x.setTimeout(...)`) whose delay is not a numeric
 *                         literal a host timer holds, nor a constant ALLOWED in that file
 *   indirect              any other reach of `setTimeout` / `setInterval`: an alias, `globalThis['setTimeout']`,
 *                         `.call` / `.apply` / `.bind`, destructuring, `Reflect.apply`, a shorthand property, a
 *                         shadowing declaration — none of which a delay check can see
 *   timers-module         an import (static, `require`, dynamic, re-export) of `timers` or `timers/promises`, with or
 *                         without `node:` — the promises API takes its delay as argument 0, past any argument check
 *   scheduler-wait        `scheduler.wait`
 *   abort-signal-timeout  `AbortSignal.timeout(x)` with a non-literal `x` or a literal past 2^31 − 1 (Node 24 aborts
 *                         `AbortSignal.timeout(2 ** 31)` after about 1 ms): use `attempt/deadline.ts · armDeadline`
 *
 * Types are not reaches: `ReturnType<typeof setTimeout>` is erased. Nor are member NAMES (an interface method or an
 * object key called `setTimeout` — its value is checked on its own).
 *
 * ALLOWED is the named allow-list for FIXED SMALL CONSTANTS: each entry names its file, the constant, and why the
 * constant can never overflow. It must be live — an entry that matches no raw delay fails, by the same predicate the
 * check uses (`===` on the delay's text) — so it cannot outlive its reason. A caller-supplied duration never belongs
 * on it: route it through `setLongTimeout`.
 *
 *   unit      the detector: every shape it flags and every shape it lets through; the stale check
 *   scenario  the real tree: no finding outside the law, and no stale allow-list entry
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import layering from '../../scripts/layering.config.cjs';

const REPO = resolve(__dirname, '../..');
/** The one file a raw host timer belongs in. */
const LAW = 'src/lib/timers/longTimeout.ts';
const TIMERS = new Set(['setTimeout', 'setInterval']);
const TIMER_MODULES = new Set(['timers', 'node:timers', 'timers/promises', 'node:timers/promises']);
/** The longest delay a host timer honours; a literal past it overflows like any caller value. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A fixed small constant a raw timer may take in one file, and why it can never overflow. */
interface Allowed {
  readonly file: string;
  readonly delay: string;
  readonly why: string;
}

/** The allow-list. Empty today: every timer in `src/` with a non-literal delay is armed by the law. */
const ALLOWED: readonly Allowed[] = [];

type Kind = 'raw-delay' | 'indirect' | 'timers-module' | 'scheduler-wait' | 'abort-signal-timeout';

/** One way a file reaches a host timer that the law has not vetted. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly kind: Kind;
  /** The first line of the offending code, for the failure message. */
  readonly code: string;
  /** For a raw delay: the delay expression's whole text — what an ALLOWED entry is matched against, with `===`. */
  readonly delay?: string;
}

/** A numeric literal a host timer holds. */
const holdableLiteral = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isNumericLiteral(node) && Number(node.text) <= MAX_TIMER_MS;

/** Whether `node` sits inside a type (erased at runtime: `typeof setTimeout`, `ReturnType<…>`). */
function inType(node: ts.Node): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isTypeNode(at)) return true;
    if (ts.isStatement(at) || ts.isExpressionStatement(at)) return false;
  }
  return false;
}

/** A call whose callee IS `name` — `setTimeout(...)` or `x.setTimeout(...)` — as opposed to any other mention. */
function directCallOf(node: ts.Identifier): ts.CallExpression | undefined {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const call = parent.parent;
    if (ts.isCallExpression(call) && call.expression === parent) return call;
  }
  return undefined;
}

/** A member NAME, not a reach: an object key, an interface or class member called `setTimeout`. */
function memberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  );
}

/** The module a node imports, when it is one: `import … from`, `export … from`, `import x = require`, `require()`, `import()`. */
function importedModule(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return ts.isStringLiteral(expression) ? expression.text : undefined;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
    const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
    const [first] = node.arguments;
    if ((isRequire || isDynamicImport) && first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  }
  return undefined;
}

/** `scheduler` or `globalThis.scheduler` (any host object named `scheduler`). */
const isScheduler = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'scheduler') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'scheduler');

/** `AbortSignal` or `globalThis.AbortSignal`. */
const isAbortSignal = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'AbortSignal') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'AbortSignal');

/** Every way `source` (the text of `file`) reaches a host timer that the law has not vetted. */
function findings(file: string, source: string, allowed: readonly Allowed[] = ALLOWED): Finding[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];
  const report = (node: ts.Node, kind: Kind, delay?: string) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const code = node.getText(sourceFile).split('\n')[0];
    found.push({ file, line: line + 1, kind, code, ...(delay !== undefined && { delay }) });
  };
  const allowedHere = (delay: string) => allowed.some((entry) => entry.file === file && entry.delay === delay);

  const visit = (node: ts.Node): void => {
    const module = importedModule(node);
    if (module !== undefined && TIMER_MODULES.has(module)) {
      report(node, 'timers-module');
      return; // its specifiers (`setTimeout` from 'timers') are this one finding
    }
    if (ts.isIdentifier(node) && TIMERS.has(node.text) && !inType(node) && !memberName(node)) {
      const call = directCallOf(node);
      if (call === undefined) report(node.parent, 'indirect');
      else {
        const delay = call.arguments[1];
        if (delay !== undefined && !holdableLiteral(delay) && !allowedHere(delay.getText(sourceFile))) {
          report(call, 'raw-delay', delay.getText(sourceFile));
        }
      }
    }
    if (ts.isStringLiteralLike(node) && TIMERS.has(node.text)) {
      const parent = node.parent;
      if ((ts.isElementAccessExpression(parent) && parent.argumentExpression === node) || ts.isCallExpression(parent)) {
        report(parent, 'indirect'); // globalThis['setTimeout'], Reflect.get(globalThis, 'setTimeout')
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'wait' && isScheduler(node.expression)) {
      report(node, 'scheduler-wait');
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'timeout' && isAbortSignal(node.expression)) {
      const call = node.parent;
      const direct = ts.isCallExpression(call) && call.expression === node;
      if (!direct || !holdableLiteral(call.arguments[0])) report(direct ? call : node, 'abort-signal-timeout');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The ALLOWED entries no raw delay in their file matches any more — by the very predicate the check uses (`===`). */
function staleEntries(allowed: readonly Allowed[], sourceOf: (file: string) => string): Allowed[] {
  return allowed.filter(
    (entry) => !findings(entry.file, sourceOf(entry.file), []).some((found) => found.delay === entry.delay),
  );
}

/** Every source file under `src/` but the law's own. */
const sourceFiles = (): string[] => layering.listSourceFiles(REPO, 'src').filter((file: string) => file !== LAW);
const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

describe('the detector', () => {
  const kinds = (source: string, allowed: readonly Allowed[] = []) =>
    findings('src/lib/x.ts', source, allowed).map((found) => found.kind);

  it('raw-delay: a timer whose delay is a caller value, however the timer is called', () => {
    expect(findings('src/lib/x.ts', 'setTimeout(fire, ms);', [])).toMatchObject([
      { kind: 'raw-delay', code: 'setTimeout(fire, ms)', delay: 'ms', line: 1 },
    ]);
    expect(kinds('globalThis.setTimeout(fire, options.timeoutMs);')).toEqual(['raw-delay']);
    expect(kinds('setInterval(tick, every);')).toEqual(['raw-delay']);
    expect(kinds('setTimeout(fire, Math.max(0, limit - elapsed));')).toEqual(['raw-delay']);
    expect(kinds('setTimeout(fire, 2_147_483_648);')).toEqual(['raw-delay']); // a literal can overflow too
  });

  it('lets through no delay, a literal a host timer holds, types and member names', () => {
    expect(kinds('setTimeout(fire); setTimeout(fire, 0); globalThis.setTimeout(fire, 2_147_483_647);')).toEqual([]);
    expect(kinds('let timer: ReturnType<typeof setTimeout> | undefined; type T = typeof setInterval;')).toEqual([]);
    expect(kinds('interface Clock { setTimeout(fn: () => void, ms: number): unknown }')).toEqual([]);
    expect(kinds('const clock = { setTimeout: (fn: () => void) => fn() };')).toEqual([]);
  });

  it('indirect: every reach of a timer that is not a direct call', () => {
    expect(kinds('const later = setTimeout;')).toEqual(['indirect']);
    expect(kinds("globalThis['setTimeout'](fire, 5);")).toEqual(['indirect']);
    expect(kinds('setTimeout.call(null, fire, ms);')).toEqual(['indirect']);
    expect(kinds('setTimeout.apply(null, [fire, ms]); setInterval.bind(null);')).toEqual(['indirect', 'indirect']);
    expect(kinds('const { setTimeout: later } = globalThis;')).toEqual(['indirect']);
    expect(kinds('const { setInterval } = globalThis;')).toEqual(['indirect']);
    expect(kinds('Reflect.apply(setTimeout, globalThis, [fire, ms]);')).toEqual(['indirect']);
    expect(kinds("Reflect.get(globalThis, 'setTimeout');")).toEqual(['indirect']);
    expect(kinds('const later = globalThis.setTimeout;')).toEqual(['indirect']);
    expect(kinds('const clock = { setTimeout };')).toEqual(['indirect']);
    expect(kinds('function wrap(setTimeout: (f: () => void) => void) { return setTimeout; }')).toEqual([
      'indirect',
      'indirect',
    ]);
  });

  it('timers-module: any import of timers or timers/promises, however it is written', () => {
    expect(kinds("import { setTimeout as sleep } from 'node:timers/promises';")).toEqual(['timers-module']);
    expect(kinds("import timers from 'timers';")).toEqual(['timers-module']);
    expect(kinds("import * as promises from 'timers/promises';")).toEqual(['timers-module']);
    expect(kinds("export { setTimeout } from 'node:timers';")).toEqual(['timers-module']);
    expect(kinds("import timers = require('node:timers');")).toEqual(['timers-module']);
    expect(kinds("const timers = require('timers');")).toEqual(['timers-module']);
    expect(kinds("const promises = await import('node:timers/promises');")).toEqual(['timers-module']);
    expect(kinds("import { readFile } from 'node:fs/promises';")).toEqual([]);
  });

  it('scheduler-wait: scheduler.wait, called or not', () => {
    expect(kinds('await scheduler.wait(ms);')).toEqual(['scheduler-wait']);
    expect(kinds('await globalThis.scheduler.wait(ms);')).toEqual(['scheduler-wait']);
    expect(kinds('const pause = scheduler.wait;')).toEqual(['scheduler-wait']);
  });

  it('abort-signal-timeout: a non-literal or too-long AbortSignal.timeout', () => {
    expect(kinds('AbortSignal.timeout(ms);')).toEqual(['abort-signal-timeout']);
    expect(kinds('globalThis.AbortSignal.timeout(options.limit);')).toEqual(['abort-signal-timeout']);
    expect(kinds('AbortSignal.timeout(2_147_483_648);')).toEqual(['abort-signal-timeout']);
    expect(kinds('const make = AbortSignal.timeout;')).toEqual(['abort-signal-timeout']);
    expect(kinds('AbortSignal.timeout(5_000); AbortSignal.abort();')).toEqual([]);
  });

  it('lets a raw delay through only where ALLOWED names it, for that file', () => {
    const grace: Allowed = { file: 'src/lib/x.ts', delay: 'GRACE_MS', why: 'a fixed 50 ms grace' };
    expect(kinds('setTimeout(close, GRACE_MS);', [grace])).toEqual([]);
    expect(kinds('setTimeout(close, GRACE_MS);')).toEqual(['raw-delay']);
    expect(findings('src/lib/y.ts', 'setTimeout(close, GRACE_MS);', [grace])).toHaveLength(1);
  });

  it('flags the law itself — the real-tree scan skips only that one file', () => {
    expect(findings(LAW, read(LAW))).not.toEqual([]);
    expect(sourceFiles()).not.toContain(LAW);
  });
});

describe('the stale check', () => {
  const grace: Allowed = { file: 'src/lib/x.ts', delay: 'GRACE_MS', why: 'a fixed 50 ms grace' };

  it('reports an entry whose constant no raw delay in its file uses any more', () => {
    expect(staleEntries([grace], () => 'setTimeout(close, OTHER_MS);')).toEqual([grace]);
    expect(staleEntries([grace], () => 'const nothing = 1;')).toEqual([grace]);
  });

  it('keeps an entry a live call uses — a call that spans several lines included', () => {
    expect(staleEntries([grace], () => 'setTimeout(close, GRACE_MS);')).toEqual([]);
    expect(staleEntries([grace], () => 'setTimeout(() => {\n  close();\n}, GRACE_MS);')).toEqual([]);
  });
});

describe('the source tree', () => {
  it('reaches a host timer only through setLongTimeout', () => {
    const found = sourceFiles().flatMap((file) => findings(file, read(file)));
    expect(found.map((f) => `${f.file}:${f.line} ${f.kind} ${f.code}`)).toEqual([]);
  });

  it('keeps no stale allow-list entry', () => {
    expect(staleEntries(ALLOWED, read)).toEqual([]);
  });
});
