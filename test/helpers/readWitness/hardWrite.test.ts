/**
 * The wider selection (`selector.ts · sameStageHardWrittenReadInputs`) and what rests on it
 * (`domain.ts · staleReadsUnderHardWrite`, `assertBuildHardWrittenReadsUndefined`), on inert ports.
 *
 * The ports stand for an engine: the buffer answers `readResult` (nothing, unless a test says so) and
 * the stage answers `fallback` when the buffer had nothing. An engine that falls back to live state
 * below its own hard write is 9.28.0; the build answers nothing there.
 */
import { expect, it } from 'vitest';

import { captureNativeSync } from './capture.js';
import {
  assertBuildDeletedReadsUndefined,
  assertBuildHardWrittenReadsUndefined,
  BuildHardWrittenReadViolation,
  oracleDomain,
  staleReadsUnderHardWrite,
} from './domain.js';
import type { NativeFact, Receipt } from './observationTypes.js';
import { BufferPort, hooks, StagePort } from './portsFixture.js';
import { sameStageHardWrittenReadInputs } from './selector.js';

/**
 * One stage on fresh ports: `act` stages and reads, and what the last read returned comes back. `engine`
 * says what the stage does when its buffer has nothing: fall back to a value (9.28.0), or answer nothing.
 */
function capture(
  act: (stage: StagePort, buffer: BufferPort) => unknown,
  engine: 'falls back' | 'answers nothing' = 'falls back',
) {
  return captureNativeSync(hooks, 'run', () => {
    const buffer = new BufferPort();
    const stage = new StagePort(buffer);
    stage.fallback = engine === 'falls back' ? 'stale' : undefined;
    return act(stage, buffer);
  });
}

it('a set of a value hides what was below it: the read the buffer cannot answer is selected, and a fall-back is stale', () => {
  const seen = capture((stage) => {
    stage.setObject([], 'list', 's');
    return stage.getValue(['list'], 'y');
  });
  expect(seen.value).toBe('stale');
  const [input] = sameStageHardWrittenReadInputs(seen.native);
  expect(input.writtenBy.method).toBe('set');
  expect(input.writtenBy.address).toEqual(['list']);
  expect(input.get.address).toEqual(['list', 'y']);
  expect(input.get.result).toEqual({ kind: 'undefined' });
  expect(input.read.result).toEqual({ kind: 'defined' });
  expect(staleReadsUnderHardWrite(seen.native)).toHaveLength(1);
  // The first selection does not see it: a set of a defined value is no tombstone.
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
  expect(() => assertBuildDeletedReadsUndefined(seen.native)).not.toThrow();
  expect(() => assertBuildHardWrittenReadsUndefined(seen.native)).toThrow(BuildHardWrittenReadViolation);
});

it('the same read answered with nothing is the build: selected, not stale, and the law holds', () => {
  const seen = capture((stage) => {
    stage.setObject([], 'list', 's');
    return stage.getValue(['list'], 'y');
  }, 'answers nothing');
  expect(seen.value).toBeUndefined();
  expect(sameStageHardWrittenReadInputs(seen.native)).toHaveLength(1);
  expect(staleReadsUnderHardWrite(seen.native)).toEqual([]);
  expect(() => assertBuildHardWrittenReadsUndefined(seen.native)).not.toThrow();
});

it('a read the buffer answers is the stage’s own value, whatever was written above it', () => {
  const seen = capture((stage, buffer) => {
    stage.setObject([], 'list', { y: 1 });
    buffer.readResult = 1;
    return stage.getValue(['list'], 'y');
  });
  expect(seen.value).toBe(1);
  expect(sameStageHardWrittenReadInputs(seen.native)).toEqual([]);
  expect(staleReadsUnderHardWrite(seen.native)).toEqual([]);
});

it.each([
  ['a delete above the read', (stage: StagePort) => stage.setObject([], 'list', undefined, false, undefined, 'delete')],
  ['a set of the read path itself', (stage: StagePort) => stage.setObject(['list'], 'y', undefined)],
  ['a set two levels above', (stage: StagePort) => stage.setObject([], 'list', { deep: {} })],
] as const)('%s owns the path', (_name, write) => {
  const seen = capture((stage) => {
    write(stage);
    return stage.getValue(['list'], 'y');
  });
  expect(staleReadsUnderHardWrite(seen.native)).toHaveLength(1);
});

it.each([
  [
    'a merge above the read',
    (stage: StagePort) => {
      stage.updateObject([], 'list', { z: 1 });
    },
  ],
  [
    'a set beside the read',
    (stage: StagePort) => {
      stage.setObject(['list'], 'other', 1);
    },
  ],
  [
    'a set below the read',
    (stage: StagePort) => {
      stage.setObject(['list', 'y'], 'deeper', 1);
    },
  ],
  [
    'a set on another key',
    (stage: StagePort) => {
      stage.setObject([], 'other', 1);
    },
  ],
  ['no write at all', () => undefined],
] as const)('%s does not own the path: a fall-back there is the law on both engines', (_name, write) => {
  const seen = capture((stage) => {
    write(stage);
    return stage.getValue(['list'], 'y');
  });
  expect(seen.value).toBe('stale');
  expect(sameStageHardWrittenReadInputs(seen.native)).toEqual([]);
  expect(() => assertBuildHardWrittenReadsUndefined(seen.native)).not.toThrow();
});

it('a set that threw staged nothing, so it owns nothing', () => {
  const seen = capture((stage, buffer) => {
    buffer.writeError = new Error('refused');
    try {
      stage.setObject([], 'list', 's');
    } catch {
      /* the write did not land */
    }
    buffer.writeError = undefined;
    return stage.getValue(['list'], 'y');
  });
  expect(sameStageHardWrittenReadInputs(seen.native)).toEqual([]);
});

it('a write owns the reads AFTER it, in the same round of staging and on the same stage only', () => {
  const before = capture((stage) => {
    const read = stage.getValue(['list'], 'y');
    stage.setObject([], 'list', 's');
    return read;
  });
  expect(sameStageHardWrittenReadInputs(before.native)).toEqual([]);

  const afterCommit = capture((stage) => {
    stage.setObject([], 'list', 's');
    stage.commit(); // a new round: the buffer starts again, and so do its hard writes
    return stage.getValue(['list'], 'y');
  });
  expect(sameStageHardWrittenReadInputs(afterCommit.native)).toEqual([]);

  const otherStage = captureNativeSync(hooks, 'run', () => {
    const writer = new StagePort(new BufferPort());
    writer.setObject([], 'list', 's');
    const reader = new StagePort(new BufferPort());
    reader.fallback = 'live';
    return reader.getValue(['list'], 'y');
  });
  expect(sameStageHardWrittenReadInputs(otherStage.native)).toEqual([]);
});

it('a later write does not take the path back: the buffer was asked and had nothing', () => {
  const seen = capture((stage) => {
    stage.setObject([], 'list', undefined, false, undefined, 'delete');
    stage.setObject(['list'], 'x', 1); // writes below the delete, and leaves `list.y` unanswered
    return stage.getValue(['list'], 'y');
  });
  // The first selection steps back here (a later overlapping write), and compares strictly.
  expect(oracleDomain(seen.native)).toEqual({ kind: 'in-domain' });
  // This one does not need to guess: it reads the buffer's own answer.
  expect(staleReadsUnderHardWrite(seen.native)).toHaveLength(1);
});

it('an index and its text are one path, as the buffer keeps them', () => {
  const seen = capture((stage) => {
    stage.setObject(['rows'], '0', 's');
    return stage.getValue(['rows', 0], 'leaf');
  });
  expect(staleReadsUnderHardWrite(seen.native)).toHaveLength(1);
});

it('the stage’s address is part of the path: a write under one run does not own a read under another', () => {
  const seen = captureNativeSync(hooks, 'run', () => {
    const buffer = new BufferPort();
    const stage = new StagePort(buffer, ['runs', 'r1']);
    stage.fallback = 'live';
    stage.setObject([], 'list', 's');
    const own = stage.getValue(['list'], 'y');
    return own;
  });
  const [input] = sameStageHardWrittenReadInputs(seen.native);
  expect(input.writtenBy.address).toEqual(['runs', 'r1', 'list']);
  expect(input.get.address).toEqual(['runs', 'r1', 'list', 'y']);
});

it.each(['issue', 'missing-get', 'duplicate-id', 'cross-leg'] as const)(
  'a damaged receipt (%s) is refused, never read as "nothing stale"',
  (damage) => {
    const native = capture((stage) => {
      stage.setObject([], 'list', 's');
      return stage.getValue(['list'], 'y');
    }).native;
    let changed: Receipt = native;
    if (damage === 'issue') changed = { ...native, issues: ['uncollected evidence'] };
    if (damage === 'missing-get') changed = { ...native, events: native.events.filter((e) => e.method !== 'get') };
    if (damage === 'duplicate-id') changed = { ...native, events: [...native.events, native.events[0]] };
    if (damage === 'cross-leg') changed = { ...native, leg: 'other' };
    expect(() => staleReadsUnderHardWrite(changed)).toThrow();
    expect(() => assertBuildHardWrittenReadsUndefined(changed)).toThrow();
  },
);

it('a get with no recorded answer cannot be read as "the buffer had nothing"', () => {
  const native = capture((stage) => {
    stage.setObject([], 'list', 's');
    return stage.getValue(['list'], 'y');
  }).native;
  const withoutAnswer: Receipt = {
    ...native,
    events: native.events.map((event): NativeFact => {
      if (event.method !== 'get') return event;
      const { result: _answer, ...rest } = event;
      return rest;
    }),
  };
  expect(() => staleReadsUnderHardWrite(withoutAnswer)).toThrow();
});
