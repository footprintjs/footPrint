/** #124: the unchanged historical program fails in its own deleted-key dereference. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAt } from 'foottrace';
import { expect, it, vi } from 'vitest';

import { FlowChartExecutor } from '../../../src/index.js';
import { pinnedText } from '../bytes.js';
import { SCENARIOS } from './scenarios.js';

type Snapshot = ReturnType<FlowChartExecutor['getSnapshot']>;
type Pins = Awaited<ReturnType<(typeof SCENARIOS)[string]>>;

it('readTiers preserves the same TypeError from its own live.push after the committed deletion', async () => {
  const originalRun = FlowChartExecutor.prototype.run;
  const previousLimit = Error.stackTraceLimit;
  let rejection: unknown;
  let pins: Pins | undefined;
  let deletionEvidence: Record<string, unknown> | undefined;
  let testFailure: unknown;
  let escaped = false;
  const spy = vi
    .spyOn(FlowChartExecutor.prototype, 'run')
    .mockImplementationOnce(function (
      this: FlowChartExecutor,
      ...args: Parameters<typeof originalRun>
    ): ReturnType<typeof originalRun> {
      return originalRun.apply(this, args).catch((error: unknown) => {
        rejection = error;
        throw error; // The SAME object reaches served(); no recovery, wrapping or retry.
      });
    });
  Error.stackTraceLimit = 100;
  try {
    pins = await SCENARIOS.readTiers!();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rejection).toBeInstanceOf(TypeError);
    const error = rejection as Error;
    expect(error.name).toBe('TypeError');
    expect(error.message).toBe("Cannot read properties of undefined (reading 'push')");
    expect(pins.failed).toBe(`${error.name}: ${error.message}`);
    expect(typeof error.stack).toBe('string');
    const firstFrame = error.stack!.split('\n').find((line) => /^\s+at /u.test(line));
    const source = fileURLToPath(new URL('./scenarios.ts', import.meta.url));
    // Current unchanged fixture: delete x:636, read x:637, live.push:638.
    // A later source move must update this citation from a fresh actual stack.
    expect(firstFrame).toContain(`${source}:638:`);

    const snapshot = pins.snapshot as Snapshot;
    expect(snapshot.executionTree.id).toBe('before-first-write');
    const failedStage = snapshot.executionTree.next;
    expect(failedStage?.id).toBe('after-first-write');
    expect(failedStage?.runtimeStageId).toBe('after-first-write#1');
    expect(failedStage?.errors.stageExecutionError).toBe(pins.failed);
    expect(Object.hasOwn(failedStage?.stageReads ?? {}, 'x')).toBe(true);
    expect(failedStage?.stageReads?.x).toBeUndefined();
    expect(snapshot.sharedState.x).toBeUndefined();
    expect(snapshot.sharedState.y).toEqual([1]);

    const matching = snapshot.commitLog.filter((bundle) => bundle.stageId === 'after-first-write');
    expect(matching).toHaveLength(1);
    const committed = matching[0]!;
    const index = snapshot.commitLog.indexOf(committed);
    expect(index).toBe(1);
    // The current default full encoding represents deletion as set-of-undefined.
    expect(committed.trace.map(({ path, verb }) => ({ path, verb }))).toEqual([{ path: 'x', verb: 'set' }]);
    expect(Object.hasOwn(committed.overwrite, 'x')).toBe(true);
    expect(committed.overwrite.x).toBeUndefined();
    const before = stateAt(snapshot, index - 1).state;
    const after = stateAt(snapshot, index).state;
    expect(before.x).toEqual([]);
    expect(after.x).toBeUndefined();
    deletionEvidence = {
      runtimeStageId: failedStage!.runtimeStageId,
      commitIndex: index,
      trace: committed.trace,
      overwriteHasX: Object.hasOwn(committed.overwrite, 'x'),
      overwriteXIsUndefined: committed.overwrite.x === undefined,
      readHasX: Object.hasOwn(failedStage!.stageReads!, 'x'),
      readXIsUndefined: failedStage!.stageReads!.x === undefined,
      beforeX: before.x,
      afterXIsUndefined: after.x === undefined,
      servedXIsUndefined: snapshot.sharedState.x === undefined,
    };
  } catch (error: unknown) {
    escaped = true;
    testFailure = error;
    throw error;
  } finally {
    try {
      spy.mockRestore();
    } finally {
      Error.stackTraceLimit = previousLimit;
    }
    const directory = process.env.FP_READ_LAW_EVIDENCE_DIR;
    if (directory !== undefined) {
      try {
        expect(isAbsolute(directory)).toBe(true);
        const error =
          rejection instanceof Error
            ? { name: rejection.name, message: rejection.message, stack: rejection.stack }
            : { observedError: false, observedType: typeof rejection };
        const text = `${JSON.stringify(
          {
            schema: 1,
            node: process.version,
            scenario: 'readTiers',
            assertions: escaped ? 'FAILED' : 'PASSED',
            rejection: error, // exact, unshortened Error fields
            returnedPins: pins ?? null, // ordinary JSON; undefined properties are omitted
            returnedPinsFixtureText: pins === undefined ? null : pinnedText(pins),
            fixtureTextEncoding: 'existing pinnedText: undefined tagged; clocks/run ids settled',
            deletionEvidence: deletionEvidence ?? null,
            testFailure:
              testFailure instanceof Error
                ? { name: testFailure.name, message: testFailure.message, stack: testFailure.stack }
                : null,
          },
          null,
          2,
        )}\n`;
        // Preserve the WHOLE capture or fail; never clip a stack/record and call it full.
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(256 * 1024);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `read-tiers-raw-failure-node${process.versions.node.split('.')[0]}.json`), text, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (artifactError: unknown) {
        if (escaped)
          throw new AggregateError([testFailure, artifactError], 'test and optional evidence capture failed');
        throw artifactError;
      }
    }
  }
}, 10_000);
