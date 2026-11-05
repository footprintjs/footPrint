/** C2 optional attention and PR104's one explicitly retained commit-error diagnostic are the named laws. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pinnedText } from '../bytes.js';
import { projectAttemptEffectsV11 } from './attempt-effects-v11-projection.js';
import hashes from './pre-attention-hashes.json';
import { assertReadTiers124, captureSha256, readTiersCandidate, readTiersPathChanges } from './read-tiers-candidate.js';
import { SCENARIOS } from './scenarios.js';

const CHANGED = new Set(['failures', 'forkError', 'retry', 'throttledFork', 'readTiers']);

/** These fixtures are controlled records. Only actual stage-shaped objects lose the new projection. */
function withoutAttention(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutAttention);
  const object = value as Record<string, unknown>;
  const stage =
    typeof object.id === 'string' && typeof object.runtimeStageId === 'string' && Object.hasOwn(object, 'errors');
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (stage && key === 'attention') continue;
    output[key] = withoutAttention(item);
  }
  return output;
}

/** PR104 changes exactly one diagnostic at one known failed commit; no general error-bag exemption. */
function projectCommitErrorDiagnostic(name: string, current: unknown, prior: unknown): void {
  if (name !== 'failures') return;
  type Fixture = {
    uncloneable: {
      failed: string;
      snapshot: {
        executionTree: {
          next: { id: string; runtimeStageId: string; errors: Record<string, unknown>; attention?: unknown };
        };
      };
    };
  };
  const uncloneable = (current as Fixture).uncloneable;
  const stage = uncloneable.snapshot.executionTree.next;
  expect(stage.id).toBe('uncloneable');
  expect(stage.runtimeStageId).toBe('uncloneable#1');
  expect(uncloneable.failed).toMatch(/^DataCloneError: /);
  expect(stage.errors).toEqual({ stageExecutionError: uncloneable.failed });
  expect(stage.attention).toEqual([
    { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] },
  ]);
  const projected = (prior as Fixture).uncloneable.snapshot.executionTree.next;
  expect(projected.id).toBe(stage.id);
  expect(projected.runtimeStageId).toBe(stage.runtimeStageId);
  expect(projected.errors).toEqual({ stageExecutionError: uncloneable.failed });
  delete projected.errors.stageExecutionError;
}

describe('C2 record byte boundary against the captured pre-attention engine', () => {
  it.each(Object.keys(SCENARIOS))('%s preserves every byte outside the named law', async (name) => {
    const current: unknown = JSON.parse(projectAttemptEffectsV11(name, pinnedText(await SCENARIOS[name]!())));
    if (name === 'readTiers') assertReadTiers124(current as Record<string, unknown>);
    const prior = withoutAttention(current);
    projectCommitErrorDiagnostic(name, current, prior);
    const normalized = JSON.stringify(prior, null, 2) + '\n';
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(hashes[name as keyof typeof hashes]);
    if (!CHANGED.has(name)) expect(JSON.stringify(current, null, 2) + '\n').toBe(normalized);
  });
});

it('captures readTiers #124 candidate pins without changing fixtures', async () => {
  expect(process.env.RECORD_BYTES_REPIN).not.toBe('1');
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '../../..');
  const pins = join(here, 'pinned');
  const hashFile = join(here, 'pre-attention-hashes.json');
  const beforePinText = readFileSync(join(pins, 'readTiers.json'), 'utf8');
  const beforeHashesText = readFileSync(hashFile, 'utf8');
  const protectedPaths = [
    ...readdirSync(pins)
      .sort()
      .filter((name) => name !== 'readTiers.json')
      .map((name) => join(pins, name)),
    join(repo, 'test/lib/memory/property/copy-on-write-fixture.ts'),
    join(repo, 'test/lib/memory/property/copy-on-write-differential.property.test.ts'),
    join(repo, 'test/lib/memory/property/copy-on-write-pause-differential.property.test.ts'),
    join(repo, 'test/lib/memory/scenario/copy-on-write-corpus.ts'),
    join(repo, 'test/lib/memory/scenario/reference/copy-on-write-9.28.0.json'),
  ];
  expect(protectedPaths.length).toBeLessThanOrEqual(64);
  const protectedBytes = () =>
    Object.fromEntries(
      protectedPaths.map((path) => {
        expect(statSync(path).size).toBeLessThanOrEqual(8 * 1024 * 1024);
        return [relative(repo, path), captureSha256(readFileSync(path, 'utf8'))];
      }),
    );
  const unchangedBefore = protectedBytes();
  // Exactly ONE scenario invocation. No raw-error spy or repeated source-origin experiment.
  const currentPinText = projectAttemptEffectsV11('readTiers', pinnedText(await SCENARIOS.readTiers!()));
  const failures: { phase: string; error: unknown }[] = [];
  let changes: ReturnType<typeof readTiersPathChanges> | undefined;
  let capture: ReturnType<typeof readTiersCandidate> | undefined;
  try {
    changes = readTiersPathChanges(JSON.parse(beforePinText), JSON.parse(currentPinText));
    capture = readTiersCandidate(beforePinText, currentPinText, beforeHashesText, withoutAttention);
  } catch (error: unknown) {
    failures.push({ phase: 'analysis', error });
  }

  const checks: [string, () => void][] = [
    ['protected fixture/generator/corpus bytes', () => expect(protectedBytes()).toEqual(unchangedBefore)],
    ['readTiers pin bytes', () => expect(readFileSync(join(pins, 'readTiers.json'), 'utf8')).toBe(beforePinText)],
    ['hash source bytes', () => expect(readFileSync(hashFile, 'utf8')).toBe(beforeHashesText)],
  ];
  for (const [name, check] of checks) {
    try {
      check();
    } catch (error: unknown) {
      failures.push({ phase: `verification: ${name}`, error });
    }
  }

  const directory = process.env.FP_READ_TIERS_PIN_CAPTURE_DIR;
  if (directory !== undefined) {
    let target: string | undefined;
    let outputs: Record<string, string> | undefined;
    try {
      expect(isAbsolute(directory)).toBe(true);
      target = resolve(directory);
      const displacement = relative(repo, target);
      expect(displacement === '..' || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)).toBe(true);
      expect(existsSync(target)).toBe(false); // never overwrite an earlier receipt
      outputs = {
        'before-readTiers.json': beforePinText,
        'candidate-readTiers.json': currentPinText, // ACTUAL run, never the constructed oracle
        'before-pre-attention-hashes.json': beforeHashesText,
        'changes.json': `${JSON.stringify(
          {
            scenario: 'readTiers',
            law: '#124',
            classification: failures.length ? 'UNPROVED' : 'EXACT_NAMED_DELTA',
            changes: changes ?? null,
            pathDiffComplete: changes !== undefined,
            protectedBytes: unchangedBefore,
            failures: failures.map(({ phase, error }) => ({
              phase,
              error:
                error instanceof Error
                  ? { name: error.name, message: error.message, stack: error.stack }
                  : { type: typeof error },
            })),
          },
          null,
          2,
        )}\n`,
      };
      if (capture && failures.length === 0) {
        outputs['candidate-pre-attention-hashes.json'] = capture.candidateHashesText;
        outputs['readTiers-without-attention.json'] = capture.normalizedText;
        outputs['capture.json'] = `${JSON.stringify(capture, null, 2)}\n`;
      }
      expect(Object.values(outputs).reduce((sum, value) => sum + Buffer.byteLength(value), 0)).toBeLessThanOrEqual(
        1024 * 1024,
      );
      mkdirSync(target, { mode: 0o700 });
    } catch (error: unknown) {
      failures.push({ phase: 'artifact preparation', error });
      target = undefined;
    }
    if (target !== undefined && outputs !== undefined) {
      for (const [name, value] of Object.entries(outputs)) {
        try {
          writeFileSync(join(target, name), value, { flag: 'wx', mode: 0o600 });
        } catch (error: unknown) {
          failures.push({ phase: `artifact write: ${name}`, error });
        }
      }
    }
  }

  // All verification and bounded evidence attempts finish before any failure escapes.
  // No throwing/assertion/IO occurs inside finally, and the primary cause stays first.
  if (failures.length === 1) throw failures[0]!.error;
  if (failures.length > 1)
    throw new AggregateError(
      failures.map(({ error }) => error),
      `readTiers capture failed (${failures.map(({ phase }) => phase).join('; ')})`,
    );
}, 10_000);
