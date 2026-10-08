/**
 * The record's bytes as the fixtures pin them (README.md in this folder).
 *
 * `stringifySnapshot` — the record's own encoder: JSON, key order kept — over
 * a copy that spells what JSON drops and settles what the clock stamps:
 *   - Date → '«date:<ISO>»', Map → { '«map»': [[k, v], …] }, Set → { '«set»': […] },
 *     an own `undefined` (or an array slot) → '«undefined»';
 *   - a run id (`<ms>-<10 digits>`, runner/runId.ts) → '«run:N»', numbered by
 *     first appearance, so "the same run" stays visible;
 *   - a `timestamp` or `pausedAt` number → '«time»'.
 * Everything else is the record's JSON, with JSON's own losses (NaN and
 * ±Infinity → null, -0 → 0, an Error or RegExp → {}). Laid out two-space
 * indented, one value per line, so a re-pin reads as a diff.
 */
import { stringifySnapshot } from '../../src/index.js';

const RUN_ID = /^\d+-\d{10}$/;
const CLOCK_KEYS = new Set(['timestamp', 'pausedAt']);
const UNDEFINED = '«undefined»';
const DATE = /^«date:(.*)»$/;

/** The pinned text of `value` — what a fixture file holds. */
export function pinnedText(value: unknown): string {
  const runs = new Map<string, string>();
  const tag = (v: unknown, key: string): unknown => {
    if (v === undefined) return UNDEFINED;
    if (typeof v === 'number' && CLOCK_KEYS.has(key)) return '«time»';
    if (typeof v === 'string' && RUN_ID.test(v)) {
      if (!runs.has(v)) runs.set(v, `«run:${runs.size + 1}»`);
      return runs.get(v);
    }
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return `«date:${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()}»`;
    if (v instanceof Map) return { '«map»': [...v].map(([k, x]) => [tag(k, ''), tag(x, '')]) };
    if (v instanceof Set) return { '«set»': [...v].map((x) => tag(x, '')) };
    if (Array.isArray(v)) return Array.from(v, (x, i) => tag(x, String(i)));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = tag((v as Record<string, unknown>)[k], k);
    return out;
  };
  return `${JSON.stringify(JSON.parse(stringifySnapshot(tag(value, ''))), null, 2)}\n`;
}

/** The value a pinned text spelled: Date, Map, Set and own `undefined` restored. */
export function revive(v: unknown): unknown {
  if (v === UNDEFINED) return undefined;
  const date = typeof v === 'string' ? DATE.exec(v) : null;
  if (date) return new Date(date[1]!);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(revive);
  const o = v as Record<string, unknown>;
  if (Array.isArray(o['«map»'])) return new Map((o['«map»'] as unknown[][]).map(([k, x]) => [revive(k), revive(x)]));
  if (Array.isArray(o['«set»'])) return new Set((o['«set»'] as unknown[]).map(revive));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = revive(o[k]);
  return out;
}
