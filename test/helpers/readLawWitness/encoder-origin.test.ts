import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { NativeFact } from '../readWitness.js';
import { identicalNativeCommits } from './commits.js';
import { equalNativeTrace } from './readPair.js';
import type { JoinedRun } from './types.js';

interface OriginalCommit {
  nativeId: number;
  start: number;
  end: number;
  frame: number;
  buffer: number;
  epoch: number;
  header: { stageId: string; runId: string; runtimeStageId: string };
  encoderMethod: 'toChangeOnlyPayload' | 'toDeltaPayload';
  encoderMode: 'full' | 'delta';
  encoderStart: number;
  encoderEnd: number;
  innerBytes: string;
  outerBytes: string;
  foldsBack: boolean;
}
interface Intake {
  program: string;
  baseline: OriginalCommit[];
  build: OriginalCommit[];
}
const intake = JSON.parse(readFileSync(new URL('./encoder-origin.json', import.meta.url), 'utf8')) as {
  node22: Intake;
  node24: Intake;
};

/** Copies captured commit facts only. This is NOT a new run or an observer-generated receipt. */
function replay(original: Intake, side: 'baseline' | 'build'): JoinedRun {
  const rows = original[side];
  const events: NativeFact[] = rows.map((row) => ({
    id: row.nativeId,
    start: row.start,
    end: row.end,
    frame: row.frame,
    buffer: row.buffer,
    epoch: row.epoch,
    leg: 'run',
    tier: 'buffer-call',
    phase: 'commit',
    method: 'commit',
    outcome: 'returned',
    header: row.header,
    encoder: {
      method: row.encoderMethod,
      mode: row.encoderMode,
      start: row.encoderStart,
      end: row.encoderEnd,
      bytes: row.innerBytes,
    },
  }));
  return {
    program: original.program,
    kept: {},
    native: { leg: 'run', events, issues: [] },
    commits: rows.map((row) => ({ bytes: row.outerBytes, foldsBack: row.foldsBack, nativeId: row.nativeId })),
  };
}

describe('original C-F5 encoder facts — inert replay, no native engine execution', () => {
  it.each(['node22', 'node24'] as const)(
    '%s compares exact bytes across engines and retains each own encoder join',
    (runtime) => {
      const a = replay(intake[runtime], 'baseline');
      const b = replay(intake[runtime], 'build');
      expect(a.native.events[1].encoder?.mode).toBe('full');
      expect(b.native.events[1].encoder?.mode).toBe('delta');
      expect(() => identicalNativeCommits(a, b)).not.toThrow();
      expect(equalNativeTrace(a.native, b.native, [])).toBe(true);
    },
  );
  it.each(['node22', 'node24'] as const)(
    '%s refuses changed encoder bytes even if the outer wrapper hides them',
    (runtime) => {
      const a = replay(intake[runtime], 'baseline');
      const b = replay(intake[runtime], 'build');
      Object.assign(b.native.events[1].encoder!, { bytes: 'independent native byte corruption' });
      expect(() => identicalNativeCommits(a, b)).toThrow();
      expect(equalNativeTrace(a.native, b.native, [])).toBe(false);
    },
  );
  it.each(['node22', 'node24'] as const)('%s refuses an encoder method inconsistent with its OWN mode', (runtime) => {
    const a = replay(intake[runtime], 'baseline');
    const b = replay(intake[runtime], 'build');
    Object.assign(b.native.events[1].encoder!, { method: 'toChangeOnlyPayload' });
    expect(() => identicalNativeCommits(a, b)).toThrow();
    expect(() => equalNativeTrace(a.native, b.native, [])).toThrow();
  });
  it('refuses different cross-engine payload bytes even when each own encoder/outer join holds', () => {
    const a = replay(intake.node24, 'baseline');
    const b = replay(intake.node24, 'build');
    Object.assign(b.native.events[1].encoder!, { bytes: 'changed native and outer payload' });
    Object.assign(b.commits[1], { bytes: 'changed native and outer payload' });
    expect(() => identicalNativeCommits(a, b)).toThrow();
    expect(equalNativeTrace(a.native, b.native, [])).toBe(false);
  });
  it.each(['count', 'order', 'outer', 'span', 'address', 'value'] as const)(
    'preserves %s refusal beside byte-identical C-F5 rows',
    (damage) => {
      const a = replay(intake.node24, 'baseline');
      const b = replay(intake.node24, 'build');
      const rows = b.native.events as NativeFact[];
      if (damage === 'count') rows.pop();
      if (damage === 'order') [rows[0], rows[1]] = [rows[1], rows[0]];
      if (damage === 'outer') Object.assign(b.commits[1], { bytes: 'another outer payload' });
      if (damage === 'span') Object.assign(rows[1].encoder!, { start: rows[1].start });
      if (damage === 'address') Object.assign(rows[1], { address: ['independent'] });
      if (damage === 'value') Object.assign(rows[1], { value: { kind: 'number', value: '99' } });
      if (damage === 'address' || damage === 'value') expect(equalNativeTrace(a.native, b.native, [])).toBe(false);
      else expect(() => identicalNativeCommits(a, b)).toThrow();
    },
  );
});
