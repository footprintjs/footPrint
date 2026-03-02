/**
 * NullNarrativeGenerator — No-op implementation of INarrativeGenerator.
 *
 * WHY: When narrative generation is disabled (the default), the Pipeline
 * still holds an INarrativeGenerator reference so handlers can call it
 * unconditionally. This Null Object satisfies the interface with empty
 * method bodies — zero allocation, zero string formatting, zero array
 * pushes. Production pipelines that never call `enableNarrative()` pay
 * exactly zero cost for the narrative feature.
 *
 * DESIGN: Every method is an empty body. `getSentences()` returns a bare
 * `[]` literal rather than a stored field to avoid even a single array
 * allocation at construction time. This is the Null Object pattern:
 * callers never need to null-check the generator reference.
 *
 * RELATED:
 * - {@link INarrativeGenerator} - The interface this implements
 * - {@link NarrativeGenerator} - The active implementation that accumulates sentences
 * - {@link Pipeline} - Chooses between this and NarrativeGenerator based on the enableNarrative flag
 *
 */

import { INarrativeGenerator } from './types';

/**
 * No-op narrative generator for when narrative is disabled.
 *
 * WHY: Implements the Null Object pattern so handlers can call narrative
 * methods unconditionally without branching on an enabled/disabled flag.
 * All methods are empty — zero allocation, zero string formatting.
 *
 * RESPONSIBILITIES:
 * - Satisfy the INarrativeGenerator contract with no-op implementations
 * - Guarantee zero runtime cost when narrative is not needed
 *
 * DESIGN DECISIONS:
 * - Empty method bodies instead of conditional checks in handlers:
 *   eliminates per-call branching and keeps handler code clean
 * - Returns `[]` literal from getSentences() instead of a stored field:
 *   avoids allocating an array at construction time
 *
 * @example
 * ```typescript
 * // Pipeline uses NullNarrativeGenerator when narrative is disabled:
 * const generator: INarrativeGenerator = new NullNarrativeGenerator();
 * generator.onStageExecuted('myStage', 'My Stage'); // no-op
 * generator.getSentences(); // → []
 * ```
 *
 */
export class NullNarrativeGenerator implements INarrativeGenerator {
  onStageExecuted(): void {}
  onNext(): void {}
  onDecision(): void {}
  onFork(): void {}
  onSelected(): void {}
  onSubflowEntry(): void {}
  onSubflowExit(): void {}
  onLoop(): void {}
  onBreak(): void {}
  onError(): void {}
  getSentences(): string[] { return []; }
}
