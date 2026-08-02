/**
 * slice/ — variable-first slicing, both directions (the triage query layer).
 *
 * One variable, one contract, every surface — asked identically by UI panels
 * (explainable-ui / lens), LLM triage tools (trace toolpacks), and offline
 * autopsy agents:
 *
 * - BACKWARD — "why is this VARIABLE what it is?" (`sliceForKey`,
 *   `arrayProvenance` / `elementProvenance`).
 * - FORWARD — "who READ it, and what did it FEED?" (`forwardSliceForKey`),
 *   plus the flat chronological view (`keyTimeline`).
 *
 * See README.md for the algorithms (thin-slice composition, append-fold
 * provenance, live-range walking), the honesty model, serialization rules,
 * and the evolution path.
 *
 * DAG position: memory ← slice (leaf-adjacent; imports memory/ only).
 */

export { arrayProvenance, elementProvenance } from './elementProvenance.js';
export { type ForwardSliceForKeyOptions, forwardSliceForKey } from './forwardSliceForKey.js';
export { keysReadFromExecutionTree, keysReadFromMap, resolveKeysReadSource } from './keysReadSources.js';
export { type KeyTimelineOptions, keyTimeline } from './keyTimeline.js';
export { formatForwardSlice, formatSlice, formatTimeline, forwardSliceToJSON, sliceToJSON } from './serialize.js';
export { type SliceForKeyOptions, normaliseStateKey, sliceForKey } from './sliceForKey.js';
export type {
  ArrayProvenance,
  AttributionBasis,
  ElementBirth,
  FedBasis,
  ForwardEdge,
  ForwardNode,
  ForwardRead,
  ForwardSlice,
  ForwardSliceJSON,
  HonestyNote,
  HonestyNoteCode,
  KeyMoment,
  KeysReadSource,
  KeyTimeline,
  MissingProvenanceReason,
  MissingSliceReason,
  ReadsCoverage,
  SliceJSON,
  StateKey,
  VariableSlice,
} from './types.js';
