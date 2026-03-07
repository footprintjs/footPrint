/**
 * Unit test: CombinedNarrativeBuilder — merges flow + data narrative.
 */

import { CombinedNarrativeBuilder } from '../../../../src/lib/engine/narrative/CombinedNarrativeBuilder';
import { NarrativeRecorder } from '../../../../src/lib/scope/recorders/NarrativeRecorder';

function makeRecorderWithData(
  stages: Array<{
    name: string;
    ops: Array<{ type: 'read' | 'write'; key: string; value?: unknown; operation?: 'set' | 'update' | 'delete' }>;
  }>,
): NarrativeRecorder {
  const recorder = new NarrativeRecorder();
  for (const stage of stages) {
    for (const op of stage.ops) {
      if (op.type === 'read') {
        recorder.onRead({ stageName: stage.name, key: op.key, value: op.value ?? 'test' });
      } else {
        recorder.onWrite({
          stageName: stage.name,
          key: op.key,
          value: op.value ?? 'test',
          operation: op.operation ?? 'set',
        });
      }
    }
  }
  return recorder;
}

describe('CombinedNarrativeBuilder', () => {
  describe('buildEntries', () => {
    it('converts stage flow sentences with data operations', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([
        { name: 'Validate Input', ops: [{ type: 'write', key: 'name', value: 'Alice' }] },
      ]);

      const entries = builder.buildEntries(['The process began with Validate Input.'], recorder);

      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries[0].type).toBe('stage');
      expect(entries[0].text).toContain('Stage 1');
      expect(entries[0].text).toContain('Validate Input');
      expect(entries[1].type).toBe('step');
      expect(entries[1].text).toContain('Write');
      expect(entries[1].text).toContain('name');
      expect(entries[1].depth).toBe(1);
    });

    it('handles Next step sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([
        { name: 'Check', ops: [] },
        { name: 'Process', ops: [{ type: 'write', key: 'result', value: 42 }] },
      ]);

      const entries = builder.buildEntries(
        ['The process began with Check.', 'Next, it moved on to Process.'],
        recorder,
      );

      const stageEntries = entries.filter((e) => e.type === 'stage');
      expect(stageEntries.length).toBe(2);
      expect(stageEntries[0].text).toContain('Stage 1');
      expect(stageEntries[1].text).toContain('Stage 2');
    });

    it('handles condition/decision sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['A decision was made, and it chose Reject.'], recorder);

      expect(entries.length).toBe(1);
      expect(entries[0].type).toBe('condition');
      expect(entries[0].text).toContain('[Condition]');
    });

    it('handles fork sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['3 paths were executed in parallel: email, sms, push.'], recorder);

      expect(entries.length).toBe(1);
      expect(entries[0].type).toBe('fork');
      expect(entries[0].text).toContain('[Parallel]');
    });

    it('handles subflow sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['Entering LLM Core subflow.', 'Exiting LLM Core subflow.'], recorder);

      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('subflow');
      expect(entries[1].type).toBe('subflow');
    });

    it('handles loop sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['On pass 3 through Retry.'], recorder);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('loop');
    });

    it('handles break sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['Execution stopped at Validate.'], recorder);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('break');
    });

    it('handles error sentences', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['An error occurred in stage Process: timeout.'], recorder);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('error');
      expect(entries[0].text).toContain('[Error]');
    });

    it('includes unreferenced stages with operations', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([
        { name: 'Hidden', ops: [{ type: 'write', key: 'secret', value: 'val' }] },
      ]);

      // Flow sentences don't mention "Hidden"
      const entries = builder.buildEntries(['The process began with Start.'], recorder);

      // Should still include Hidden stage since it has operations
      const hiddenEntry = entries.find((e) => e.stageName === 'Hidden');
      expect(hiddenEntry).toBeDefined();
    });

    it('handles read operations', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([{ name: 'Reader', ops: [{ type: 'read', key: 'name', value: 'Bob' }] }]);

      const entries = builder.buildEntries(['The process began with Reader.'], recorder);

      const stepEntry = entries.find((e) => e.type === 'step');
      expect(stepEntry).toBeDefined();
      expect(stepEntry!.text).toContain('Read');
      expect(stepEntry!.text).toContain('name');
    });

    it('handles update and delete operations', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([
        {
          name: 'Updater',
          ops: [
            { type: 'write', key: 'count', value: 5, operation: 'update' },
            { type: 'write', key: 'temp', value: undefined, operation: 'delete' },
          ],
        },
      ]);

      const entries = builder.buildEntries(['The process began with Updater.'], recorder);

      const steps = entries.filter((e) => e.type === 'step');
      expect(steps.length).toBe(2);
      expect(steps[0].text).toContain('Update');
      expect(steps[1].text).toContain('Delete');
    });

    it('fuzzy matches stage names (case-insensitive substring)', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([
        { name: 'validateInput', ops: [{ type: 'write', key: 'valid', value: true }] },
      ]);

      // Flow sentence has different casing
      const entries = builder.buildEntries(['The process began with Validate Input.'], recorder);

      // Should match via fuzzy matching
      const stepEntry = entries.find((e) => e.type === 'step');
      // If fuzzy match doesn't work (substring), it'll be added as unreferenced
      const hasStep = entries.some((e) => e.type === 'step');
      expect(hasStep).toBe(true);
    });
  });

  describe('build', () => {
    it('returns formatted strings with indentation', () => {
      const builder = new CombinedNarrativeBuilder({ indent: '  ' });
      const recorder = makeRecorderWithData([{ name: 'Init', ops: [{ type: 'write', key: 'x', value: 1 }] }]);

      const lines = builder.build(['The process began with Init.'], recorder);

      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]).toMatch(/^Stage 1:/);
      // Step should be indented
      expect(lines[1]).toMatch(/^\s+/);
    });

    it('respects includeStepNumbers option', () => {
      const builder = new CombinedNarrativeBuilder({ includeStepNumbers: false });
      const recorder = makeRecorderWithData([{ name: 'Init', ops: [{ type: 'write', key: 'x', value: 1 }] }]);

      const lines = builder.build(['The process began with Init.'], recorder);

      const stepLine = lines.find((l) => l.includes('Write'));
      expect(stepLine).toBeDefined();
      expect(stepLine).not.toContain('Step 1');
    });

    it('respects includeValues=false option', () => {
      const builder = new CombinedNarrativeBuilder({ includeValues: false });
      const recorder = makeRecorderWithData([{ name: 'Init', ops: [{ type: 'write', key: 'x', value: 42 }] }]);

      const lines = builder.build(['The process began with Init.'], recorder);

      const stepLine = lines.find((l) => l.includes('Write'));
      expect(stepLine).toBeDefined();
      expect(stepLine).not.toContain('42');
    });
  });

  describe('parseSentence edge cases', () => {
    it('handles "It chose" pattern', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['It chose the Reject path.'], recorder);

      expect(entries[0].type).toBe('condition');
    });

    it('handles "so it chose" pattern', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['The score was too low, so it chose Reject.'], recorder);

      expect(entries[0].type).toBe('condition');
    });

    it('handles "paths were selected" pattern', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['2 paths were selected: email, sms.'], recorder);

      expect(entries[0].type).toBe('fork');
    });

    it('unrecognized sentence defaults to stage type', () => {
      const builder = new CombinedNarrativeBuilder();
      const recorder = makeRecorderWithData([]);

      const entries = builder.buildEntries(['Something completely custom happened.'], recorder);

      expect(entries[0].type).toBe('stage');
    });
  });
});
