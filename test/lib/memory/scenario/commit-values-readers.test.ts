/** Readers of either encoding need the record, not the engine's loop scheduler. */
import { causalChain, commitValueAt, findCommit, findLastWriter } from '../../../../src/trace';
import { growingHistoryRecord } from '../../../helpers/growingHistoryRecord';

const canonical = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? 'null');

describe('consumer-matrix pins (delta logs)', () => {
  const deltaRun = () => growingHistoryRecord('delta').snapshot();

  it('findCommit / findLastWriter treat an appending stage as a writer of the key', async () => {
    const snap = await deltaRun();
    const log = snap.commitLog;

    const firstWork = findCommit(log, 'work', 'history')!;
    expect(firstWork).toBeDefined();
    expect(firstWork.trace.find((t) => t.path === 'history')!.verb).toBe('append');

    const lastWriter = findLastWriter(log, 'history')!;
    expect(lastWriter.stageId).toBe('work');
    // The last writer is the LAST loop iteration's append:
    expect(lastWriter.trace.find((t) => t.path === 'history')!.verb).toBe('append');
  });

  it('causalChain walks delta logs by trace.path — the appender is the causal parent', async () => {
    const snap = await deltaRun();
    const log = snap.commitLog;
    const lastWork = findLastWriter(log, 'history')!;

    const chain = causalChain(log, lastWork.runtimeStageId, () => ['history'])!;
    expect(chain).toBeDefined();
    expect(chain.keysWritten).toContain('history');
    // Its parent for 'history' is the PREVIOUS appender (an append bundle).
    const parent = chain.parents.find((p) => p.keysWritten.includes('history'));
    expect(parent).toBeDefined();
    expect(parent!.linkedBy).toBe('history');
    expect(parent!.stageId).toBe('work'); // the prior loop iteration
  });

  it('delta dedup removes duplicate causal edges without losing keysWritten', async () => {
    const snap = await deltaRun();
    for (const b of snap.commitLog) {
      const paths = b.trace.map((t) => t.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it('commitValueAt reconstructs the SAME full value from full-mode and delta-mode logs at every history commit', async () => {
    const runWith = (commitValues: 'full' | 'delta') => growingHistoryRecord(commitValues).snapshot().commitLog;
    const fullLog = await runWith('full');
    const deltaLog = await runWith('delta');
    expect(deltaLog.length).toBe(fullLog.length);
    for (let i = 0; i < fullLog.length; i++) {
      expect(canonical(commitValueAt(deltaLog, i, 'history'))).toEqual(canonical(commitValueAt(fullLog, i, 'history')));
    }
    // And the final reconstruction equals the v1 "full value in overwrite" read:
    const v1Read = findLastWriter(fullLog, 'history')!.overwrite.history;
    expect(canonical(commitValueAt(deltaLog, deltaLog.length - 1, 'history'))).toEqual(canonical(v1Read));
  });
});
