/**
 * The timer law — every wait of a caller-supplied length is armed by `attempt/longTimeout.ts · setLongTimeout`.
 *
 * WHY: a host timer holds at most 2^31 − 1 ms, and Node turns a longer delay — `Infinity` included — into 1 ms. A raw
 * `setTimeout(fn, limit)` whose limit the caller chose therefore gives up at once exactly when it was asked to wait
 * longest. Six sites did, until each was routed through the one law. This test reads every source file under `src/`
 * and refuses a raw `setTimeout` / `setInterval` whose delay is not a numeric literal a host timer holds, or a constant
 * named in ALLOWED. The law's own file is the one place a raw timer belongs.
 *
 * ALLOWED is the named allow-list for FIXED SMALL CONSTANTS: each entry names its file, the constant, and why the
 * constant can never overflow. The list must be live — an entry that matches no call fails — so it cannot outlive
 * its reason. A caller-supplied duration never belongs on it: route it through `setLongTimeout`.
 *
 *   unit      the detector: what it flags and what it lets through
 *   scenario  the real tree: no raw timer outside the law, and no stale allow-list entry
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import layering from '../../scripts/layering.config.cjs';

const REPO = resolve(__dirname, '../..');
/** The one file a raw host timer belongs in. */
const LAW = 'src/lib/attempt/longTimeout.ts';
const TIMERS = new Set(['setTimeout', 'setInterval']);
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

/** A raw timer call whose delay the law has not vetted. */
interface RawTimer {
  readonly file: string;
  readonly line: number;
  readonly call: string;
}

/** The name a call reaches a timer by — `setTimeout(...)` or `globalThis.setTimeout(...)` — else undefined. */
function timerName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return TIMERS.has(callee.text) ? callee.text : undefined;
  if (ts.isPropertyAccessExpression(callee)) return TIMERS.has(callee.name.text) ? callee.name.text : undefined;
  return undefined;
}

/** A delay the law need not vet: none, a literal a host timer holds, or a constant ALLOWED in this file. */
function vetted(delay: ts.Expression | undefined, file: string, allowed: readonly Allowed[]): boolean {
  if (delay === undefined) return true;
  if (ts.isNumericLiteral(delay)) return Number(delay.text) <= MAX_TIMER_MS;
  return allowed.some((entry) => entry.file === file && entry.delay === delay.getText());
}

/** Every raw timer call in `source` (the text of `file`) whose delay is not vetted. */
function rawTimers(file: string, source: string, allowed: readonly Allowed[] = ALLOWED): RawTimer[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: RawTimer[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && timerName(node) && !vetted(node.arguments[1], file, allowed)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({ file, line: line + 1, call: node.getText(sourceFile).split('\n')[0] });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Every source file under `src/` but the law's own. */
const sourceFiles = (): string[] => layering.listSourceFiles(REPO, 'src').filter((file: string) => file !== LAW);
const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

describe('the detector', () => {
  const flagged = (source: string, allowed: readonly Allowed[] = []) =>
    rawTimers('src/lib/x.ts', source, allowed).map((timer) => timer.call);

  it('flags a timer whose delay is a caller value, however the timer is reached', () => {
    expect(flagged('setTimeout(fire, ms);')).toEqual(['setTimeout(fire, ms)']);
    expect(flagged('globalThis.setTimeout(fire, options.timeoutMs);')).toHaveLength(1);
    expect(flagged('setInterval(tick, every);')).toHaveLength(1);
    expect(flagged('setTimeout(fire, Math.max(0, limit - elapsed));')).toHaveLength(1);
  });

  it('lets through no delay, and a literal a host timer holds', () => {
    expect(flagged('setTimeout(fire); setTimeout(fire, 0); setTimeout(fire, 2_147_483_647);')).toEqual([]);
  });

  it('flags a literal past what a host timer holds — a constant can overflow too', () => {
    expect(flagged('setTimeout(fire, 2_147_483_648);')).toHaveLength(1);
  });

  it('lets through a constant only where ALLOWED names it, for that file', () => {
    const grace: Allowed = { file: 'src/lib/x.ts', delay: 'GRACE_MS', why: 'a fixed 50 ms grace' };
    expect(flagged('setTimeout(close, GRACE_MS);', [grace])).toEqual([]);
    expect(flagged('setTimeout(close, GRACE_MS);')).toHaveLength(1);
    expect(rawTimers('src/lib/y.ts', 'setTimeout(close, GRACE_MS);', [grace])).toHaveLength(1);
  });

  it('flags the law itself — the real-tree scan skips only that one file', () => {
    expect(rawTimers(LAW, read(LAW))).not.toEqual([]);
    expect(sourceFiles()).not.toContain(LAW);
  });
});

describe('the source tree', () => {
  it('arms every wait of a caller-supplied length with setLongTimeout', () => {
    const raw = sourceFiles().flatMap((file) => rawTimers(file, read(file)));
    expect(raw.map((timer) => `${timer.file}:${timer.line} ${timer.call}`)).toEqual([]);
  });

  it('keeps no stale allow-list entry: each one matches a real call', () => {
    for (const entry of ALLOWED) {
      expect(
        rawTimers(entry.file, read(entry.file), [])
          .map((timer) => timer.call)
          .join('\n'),
      ).toContain(entry.delay);
    }
  });
});
