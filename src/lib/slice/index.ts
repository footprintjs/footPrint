/**
 * slice/ — variable-first backward slicing (the triage query layer).
 *
 * One question, one contract, every surface: "why is this VARIABLE what it
 * is?" — asked identically by UI panels (explainable-ui / lens), LLM triage
 * tools (trace toolpacks), and offline autopsy agents. See README.md for the
 * algorithms (thin-slice composition, append-fold provenance), the honesty
 * model, serialization rules, and the evolution path.
 *
 * DAG position: memory ← slice (leaf-adjacent; imports memory/ only).
 */

export { arrayProvenance, elementProvenance } from './elementProvenance.js';
export { keysReadFromExecutionTree, keysReadFromMap, resolveKeysReadSource } from './keysReadSources.js';
export { formatSlice, sliceToJSON } from './serialize.js';
export { type SliceForKeyOptions, normaliseStateKey, sliceForKey } from './sliceForKey.js';
export type {
  ArrayProvenance,
  AttributionBasis,
  ElementBirth,
  KeysReadSource,
  MissingProvenanceReason,
  MissingSliceReason,
  ReadsCoverage,
  SliceJSON,
  StateKey,
  VariableSlice,
} from './types.js';
