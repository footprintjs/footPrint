/**
 * Architecture — every function `footprintjs/trace` hands out is classified (F4b, 9.33.0).
 *
 * Each export is on one of the two lists below: a KEY READER (one that can answer `undefined` or empty for
 * a key, and must say why with a registered code), or NOT one (with the reason). A new export that is on
 * neither fails here. The readers themselves, and the codes they answer with, are foottrace's behaviour
 * and are tested in foottrace's own suite.
 */
import * as record from 'foottrace';
import { normaliseStateKey, pathSegments } from 'foottrace/paths';
import { describe, expect, it } from 'vitest';

import * as engineTrace from '../../src/trace';

const trace = { ...record, ...engineTrace, normaliseStateKey, pathSegments };

const KEY_READERS = [
  'commitValueAt',
  'commitValueAtWithBasis',
  'findLastWriter',
  'findLastWriterWithBasis',
  'findCommit',
  'sliceForKey',
  'causalChain',
  'arrayProvenance',
  'elementProvenance',
  'keyTimeline',
  'forwardSliceForKey',
  'stateAt',
];

const NOT_KEY_READERS: Record<string, string> = {
  readStoredCapture: 'engine capture-history admission with explicit unknown reasons, no state-key query',
  deepEqual: 'structural equality, no log query',
  serveRecord: 'defensive record copy, no log query',
  isExecutionKey: 'id grammar',
  buildAttemptId: 'id grammar (foottrace 1.1.0)',
  parseAttemptId: 'id grammar (foottrace 1.1.0)',
  readStoredRecord: 'reads a sink back into logs; answers no key (foottrace 1.1.0)',
  readRequirementResults:
    'bounded structural admission of requirement/check references, no state-key query (foottrace 1.3.0)',
  RequirementValidationError: 'a fixed structural-admission refusal class, no state-key query (foottrace 1.3.0)',
  joinPath: 'id grammar',
  idPathSegments: 'id grammar',
  stageIdOf: 'id grammar',
  subflowSegmentsOf: 'id grammar',
  applySmartMerge: 'folds ONE bundle onto a state the caller hands it — no key query (an unknown verb throws)',
  BoundaryStateStore: 'a recorder store keyed by runtimeStageId, not a log reader',
  CommitRangeIndex: 'commit-index ranges, no state key',
  ControlDepRecorder: 'a recorder (decider per step), no state key',
  InOutRecorder: 'a recorder (subflow boundaries), no state key',
  KeyedStore: 'a recorder store keyed by runtimeStageId',
  QualityRecorder: 'a recorder (per-step quality), no state key',
  SequenceStore: 'a recorder store (ordered events)',
  TopologyRecorder: 'a recorder (graph shape)',
  UnknownVerbError: 'an error class',
  buildBranchSegment: 'id grammar',
  buildCommitIndex: 'runtimeStageId → commit index, no state key',
  inferLegacyPhases: 'a pre-9.39.0 log → the phase of each bundle (F8), no state key',
  recordsPhases: 'does a log record continuation phases (F8) — a boolean, no state key',
  buildRuntimeStageId: 'id grammar',
  commitIndexOf: 'runtimeStageId → commit index (-1 = not in this log, its documented indexOf answer)',
  commitStops: 'the time-travel axis, no state key',
  controlDepRecorder: 'recorder factory',
  createExecutionCounter: 'id grammar',
  filterStops: 'the time-travel axis',
  findCommits: 'by stageId only, no state key',
  flattenCausalDAG: 'a projection of a causalChain answer',
  formatCausalChain: 'a rendering of a causalChain answer',
  formatForwardSlice: 'a rendering (it prints the notes and missing reason)',
  formatQualityTrace: 'a rendering of a quality trace',
  formatSlice: 'a rendering (it prints the missing reason and, since 9.33.0, the notes)',
  formatTimeline: 'a rendering (it prints the notes and missing reason)',
  forwardSliceToJSON: 'a serialization (it carries the notes and missing reason)',
  hasBranchSegmentMarker: 'id grammar',
  inOutRecorder: 'recorder factory',
  isBranchSegment: 'id grammar',
  isCommitBundle: 'a shape guard',
  keysReadFromExecutionTree: 'a reads provider, not an answer about a key',
  keysReadFromMap: 'a reads provider',
  normaliseStateKey: 'key spelling',
  parseBranchSegment: 'id grammar',
  parseRuntimeStageId: 'id grammar',
  pathSegments: 'key spelling',
  qualityTrace: 'a quality projection, no state key',
  resolveKeysReadSource: 'a reads provider',
  sliceToJSON: 'a serialization (it carries missing, notes and edge basis)',
  splitAxis: 'the time-travel axis',
  splitStageId: 'id grammar',
  tagStops: 'the time-travel axis',
  timeTravel: 'a cursor over stops; its fold is stateAt',
  topologyRecorder: 'recorder factory',
  walkSubflowSpec: 'a chart-spec walker',
};

describe('every export of footprintjs/trace is classified', () => {
  it('every function on footprintjs/trace is classified: a key reader, or not one with its reason', () => {
    const fns = Object.keys(trace).filter((k) => typeof (trace as Record<string, unknown>)[k] === 'function');
    const unclassified = fns.filter(
      (k) => !KEY_READERS.includes(k) && !Object.prototype.hasOwnProperty.call(NOT_KEY_READERS, k),
    );
    expect(unclassified, 'classify the new export here').toEqual([]);
    for (const name of [...KEY_READERS, ...Object.keys(NOT_KEY_READERS)]) expect(fns, name).toContain(name);
  });
});
