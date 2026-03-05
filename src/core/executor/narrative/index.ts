/**
 * Barrel export for the narrative generation module.
 *
 * WHY: Provides a single import point for consumers and internal modules
 * that need the narrative interface and its implementations. Keeps import
 * paths clean and decouples consumers from the internal file structure.
 */

export { INarrativeGenerator } from './types';
export { NarrativeGenerator } from './NarrativeGenerator';
export { NullNarrativeGenerator } from './NullNarrativeGenerator';
export { CombinedNarrativeBuilder } from './CombinedNarrativeBuilder';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './CombinedNarrativeBuilder';
