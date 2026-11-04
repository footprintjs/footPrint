import type {
  Attention,
  CommitBundle,
  CommitPhase,
  CommitValuesMode,
  ControlDependency,
  ControlDepLookup,
  EmitSourcePosition,
  LogAddress,
  LogOutcome,
  Meta,
  StoredLog,
  StoredRecordLimits,
  UntrackedSource,
} from 'foottrace';
import { buildAttemptId, buildRuntimeStageId, causalChain, commitValueAtWithBasis, readStoredRecord } from 'foottrace';
import type { AttemptId, RuntimeStageId } from 'foottrace';
import type {
  ReadSource,
  ReadSourceLimits,
  ReadSourceRecord,
  ReadSourceSnapshot,
  RecordEntry,
  RecordSink,
  WriteProvenanceMode,
  WriteScrub,
  WriteVerb,
} from 'foottrace/write';
import { createReadSourceRecord, decodeReadSourceSnapshot, EventLog, RecordFrame, SharedMemory } from 'foottrace/write';

// These are the shapes the engine passes through the public boundary, not package internals.
const stage: RuntimeStageId = buildRuntimeStageId('stage', 0);
const attempt: AttemptId = buildAttemptId(stage, 1);
const address: LogAddress = { logRunId: 'contract', drillPath: [] };
const limits: StoredRecordLimits = { entries: 10 };
const outcome: LogOutcome = 'ok';
const phase: CommitPhase = 'exit';
const values: CommitValuesMode = 'full';
const provenance: WriteProvenanceMode = 'reads-prefix';
const scrub: WriteScrub = { whole: true, fields: ['secret'] };
const verb: WriteVerb = 'set';
const meta: Meta = { source: 'contract' };
const source: ReadSource = { kind: 'committed', commitIdx: 0 };
const sourceLimits: ReadSourceLimits = {
  maxOccurrences: 10,
  maxPerExecution: 10,
  maxBytes: 10000,
  maxOrigins: 10,
  maxStaging: 10,
};
const entries: RecordEntry[] = [];
const sink: RecordSink = {
  opened: (entry) => {
    entries.push({ ...entry, kind: 'opened' });
  },
  commit: (entry) => {
    entries.push({ ...entry, kind: 'commit' });
  },
  note: (entry) => {
    entries.push({ ...entry, kind: 'note', note: entry.kind });
  },
  closed: (entry) => {
    entries.push({ ...entry, kind: 'closed' });
  },
};
const state = new SharedMemory(undefined, { count: 1 });
const log = new EventLog(state.getState(), { sink, address, meta });
const frame = new RecordFrame(state, log);
frame.useEncoding({ commitValues: values, writeProvenance: provenance });
frame.write(frame.at([], 'count'), 2, verb, scrub);
frame.noteReadAttempt(attempt);
frame.commit(() => ({ stage: 'Stage', stageId: 'stage', runtimeStageId: stage, phase }));
log.close(outcome);
const commits: CommitBundle[] = log.list();
const position: EmitSourcePosition | undefined = log.capturePosition('run');
const stored: StoredLog | undefined = readStoredRecord(entries, limits).root(address.logRunId);
const dependency: ControlDependency = { deciderId: stage, label: 'contract' };
const lookup: ControlDepLookup = () => dependency;
causalChain(commits, stage, () => ['count'], { controlDeps: lookup });
commitValueAtWithBasis(commits, 0, 'count', { initialState: log.getInitialState() });
const book: ReadSourceRecord = createReadSourceRecord(state, address, { limits: sourceLimits });
const snapshot: ReadSourceSnapshot | undefined = decodeReadSourceSnapshot(book.snapshot());
function consumeEvidence(attention: Attention, untracked: UntrackedSource): void {
  void attention;
  void untracked;
}
void [source, position, stored, snapshot, consumeEvidence];
