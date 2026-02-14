/**
 * Property-Based Tests: NarrativeGenerator Sentence Formatting
 *
 * INVARIANTS TESTED:
 * These properties must hold for ALL valid inputs:
 * 1. Sentence formatting uses displayName over raw stage name
 * 2. Narrative order matches the order events were called
 * 3. Decider sentences include both branch name and rationale when provided
 * 4. NullNarrativeGenerator always returns an empty array
 * 5. Sentences contain no internal identifiers (paths, object notation, JSON)
 *
 * GENERATOR STRATEGY:
 * We generate random stage names, display names, branch names, and rationale
 * strings from alphabetic characters and spaces. Names are constrained to be
 * non-empty and human-readable. We avoid generating strings that contain
 * path separators or JSON-like structures in display names to keep generators
 * focused on the property under test.
 *
 * Feature: pipeline-narrative-generation
 */

import * as fc from 'fast-check';
import { NarrativeGenerator } from '../../src/core/executor/narrative/NarrativeGenerator';
import { NullNarrativeGenerator } from '../../src/core/executor/narrative/NullNarrativeGenerator';

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a valid internal stage name with a unique prefix to avoid
 * accidental substring matches with sentence template words.
 * WHY: Stage names like "pr" could match "process" in the template.
 * Using a "zq" prefix ensures stage names never appear as substrings
 * of the fixed sentence patterns ("The process began with", "Next, it
 * moved on to", "A decision was made", "Execution stopped at", etc.).
 */
const stageNameArb = fc
  .stringMatching(/^[a-z]{3,10}$/)
  .map((s) => `zq${s}`);

/**
 * Generates a single lowercase word (2–8 chars).
 * WHY: Building block for display names and rationale strings.
 */
const wordArb = fc.stringMatching(/^[a-z]{2,8}$/);

/**
 * Generates a human-readable display name (words separated by spaces)
 * with a unique prefix to distinguish from stage names.
 * WHY: Display names are the human-friendly labels consumers provide.
 * The "xk" prefix ensures display names never collide with stage names
 * or sentence template words.
 */
const displayNameArb = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((words) => `xk ${words.join(' ')}`);

/**
 * Generates a non-empty rationale string (plain English clause).
 * WHY: Rationale explains why a decider chose a branch, e.g.,
 * "the user role equals admin".
 */
const rationaleArb = fc
  .array(wordArb, { minLength: 2, maxLength: 5 })
  .map((words) => words.join(' '));

/**
 * Generates a positive integer for loop iterations.
 */
const iterationArb = fc.integer({ min: 1, max: 100 });

/**
 * Generates an error message string.
 */
const errorMessageArb = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((words) => words.join(' '));

/**
 * Generates an array of child names for fork/selector events.
 */
const childNamesArb = fc.array(displayNameArb, { minLength: 1, maxLength: 5 });

// ─────────────────────────────────────────────────────────────────────────────
// Property 1: Sentence formatting uses displayName over name
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 1: Sentence formatting uses displayName over name', () => {
  /**
   * PROPERTY: For any stage name and displayName pair, when displayName is
   * provided, the generated sentence SHALL contain the displayName and not
   * the raw stage name.
   *
   * VALIDATES: Requirements 8.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means the NarrativeGenerator
   * is using the internal stage name instead of the human-readable displayName,
   * leaking implementation details into the narrative.
   */
  it('onStageExecuted uses displayName when provided', () => {
    fc.assert(
      fc.property(stageNameArb, displayNameArb, (stageName, displayName) => {
        // Ensure stageName and displayName are different so we can distinguish them
        fc.pre(stageName !== displayName);

        const gen = new NarrativeGenerator();
        gen.onStageExecuted(stageName, displayName);
        const sentences = gen.getSentences();

        expect(sentences.length).toBe(1);
        expect(sentences[0]).toContain(displayName);
        expect(sentences[0]).not.toContain(stageName);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * PROPERTY: For onNext, when toDisplayName is provided, the sentence
   * SHALL contain the displayName and not the raw toStage name.
   *
   * VALIDATES: Requirements 8.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, transition sentences are using
   * internal identifiers instead of display names.
   */
  it('onNext uses toDisplayName when provided', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, displayNameArb, (from, to, toDisplay) => {
        fc.pre(to !== toDisplay);

        const gen = new NarrativeGenerator();
        gen.onNext(from, to, toDisplay);
        const sentences = gen.getSentences();

        expect(sentences.length).toBe(1);
        expect(sentences[0]).toContain(toDisplay);
        expect(sentences[0]).not.toContain(to);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * PROPERTY: For onDecision, when chosenDisplayName is provided, the sentence
   * SHALL contain the displayName and not the raw chosenBranch name.
   *
   * VALIDATES: Requirements 8.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, decision sentences are using
   * internal branch identifiers instead of display names.
   */
  it('onDecision uses chosenDisplayName when provided', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, displayNameArb, (decider, branch, branchDisplay) => {
        fc.pre(branch !== branchDisplay);

        const gen = new NarrativeGenerator();
        gen.onDecision(decider, branch, branchDisplay);
        const sentences = gen.getSentences();

        expect(sentences.length).toBe(1);
        expect(sentences[0]).toContain(branchDisplay);
        expect(sentences[0]).not.toContain(branch);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * PROPERTY: For onBreak, when displayName is provided, the sentence
   * SHALL contain the displayName and not the raw stage name.
   *
   * VALIDATES: Requirements 8.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, break sentences are using
   * internal identifiers instead of display names.
   */
  it('onBreak uses displayName when provided', () => {
    fc.assert(
      fc.property(stageNameArb, displayNameArb, (stageName, displayName) => {
        fc.pre(stageName !== displayName);

        const gen = new NarrativeGenerator();
        gen.onBreak(stageName, displayName);
        const sentences = gen.getSentences();

        expect(sentences.length).toBe(1);
        expect(sentences[0]).toContain(displayName);
        expect(sentences[0]).not.toContain(stageName);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * PROPERTY: For onError, when displayName is provided, the sentence
   * SHALL contain the displayName and not the raw stage name.
   *
   * VALIDATES: Requirements 8.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, error sentences are using
   * internal identifiers instead of display names.
   */
  it('onError uses displayName when provided', () => {
    fc.assert(
      fc.property(stageNameArb, errorMessageArb, displayNameArb, (stageName, errMsg, displayName) => {
        fc.pre(stageName !== displayName);

        const gen = new NarrativeGenerator();
        gen.onError(stageName, errMsg, displayName);
        const sentences = gen.getSentences();

        expect(sentences.length).toBe(1);
        expect(sentences[0]).toContain(displayName);
        expect(sentences[0]).not.toContain(stageName);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * PROPERTY: For onLoop, when targetDisplayName is provided, the sentence
   * SHALL contain the displayName and not the raw target stage name.
   *
   * VALIDATES: Requirements 8.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, loop sentences are using
   * internal identifiers instead of display names.
   */
  it('onLoop uses targetDisplayName when provided', () => {
    fc.assert(
      fc.property(stageNameArb, displayNameArb, iterationArb, (target, targetDisplay, iteration) => {
        fc.pre(target !== targetDisplay);

        const gen = new NarrativeGenerator();
        gen.onLoop(target, targetDisplay, iteration);
        const sentences = gen.getSentences();

        expect(sentences.length).toBe(1);
        expect(sentences[0]).toContain(targetDisplay);
        expect(sentences[0]).not.toContain(target);
      }),
      { numRuns: 200 },
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Property 2: Narrative order matches call order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single narrative event call that can be replayed on a generator.
 * WHY: We need to generate arbitrary sequences of events and verify the output
 * order matches the call order.
 */
type NarrativeEvent =
  | { type: 'stageExecuted'; stageName: string; displayName: string }
  | { type: 'next'; from: string; to: string; toDisplay: string }
  | { type: 'decision'; decider: string; branch: string; display: string; rationale?: string }
  | { type: 'fork'; parent: string; children: string[] }
  | { type: 'subflowEntry'; name: string }
  | { type: 'subflowExit'; name: string }
  | { type: 'loop'; target: string; display: string; iteration: number }
  | { type: 'break'; stageName: string; display: string }
  | { type: 'error'; stageName: string; message: string; display: string };

/**
 * Generates a random narrative event. Each event type produces exactly one sentence.
 * WHY: We skip onStageExecuted for non-first stages (it only produces a sentence
 * for the first stage), so we use event types that always produce a sentence.
 */
const narrativeEventArb: fc.Arbitrary<NarrativeEvent> = fc.oneof(
  fc.tuple(stageNameArb, displayNameArb).map(([to, toDisplay]) => ({
    type: 'next' as const,
    from: 'prev',
    to,
    toDisplay,
  })),
  fc.tuple(stageNameArb, displayNameArb, fc.option(rationaleArb, { nil: undefined })).map(
    ([branch, display, rationale]) => ({
      type: 'decision' as const,
      decider: 'decider',
      branch,
      display,
      rationale,
    }),
  ),
  fc.tuple(stageNameArb, childNamesArb).map(([parent, children]) => ({
    type: 'fork' as const,
    parent,
    children,
  })),
  displayNameArb.map((name) => ({ type: 'subflowEntry' as const, name })),
  displayNameArb.map((name) => ({ type: 'subflowExit' as const, name })),
  fc.tuple(stageNameArb, displayNameArb, iterationArb).map(([target, display, iteration]) => ({
    type: 'loop' as const,
    target,
    display,
    iteration,
  })),
  fc.tuple(stageNameArb, displayNameArb).map(([stageName, display]) => ({
    type: 'break' as const,
    stageName,
    display,
  })),
  fc.tuple(stageNameArb, errorMessageArb, displayNameArb).map(([stageName, message, display]) => ({
    type: 'error' as const,
    stageName,
    message,
    display,
  })),
);

/**
 * Applies a narrative event to a generator and returns the expected sentence count (always 1).
 */
function applyEvent(gen: NarrativeGenerator, event: NarrativeEvent): void {
  switch (event.type) {
    case 'stageExecuted':
      gen.onStageExecuted(event.stageName, event.displayName);
      break;
    case 'next':
      gen.onNext(event.from, event.to, event.toDisplay);
      break;
    case 'decision':
      gen.onDecision(event.decider, event.branch, event.display, event.rationale);
      break;
    case 'fork':
      gen.onFork(event.parent, event.children);
      break;
    case 'subflowEntry':
      gen.onSubflowEntry(event.name);
      break;
    case 'subflowExit':
      gen.onSubflowExit(event.name);
      break;
    case 'loop':
      gen.onLoop(event.target, event.display, event.iteration);
      break;
    case 'break':
      gen.onBreak(event.stageName, event.display);
      break;
    case 'error':
      gen.onError(event.stageName, event.message, event.display);
      break;
  }
}

describe('Property 2: Narrative order matches call order', () => {
  /**
   * PROPERTY: For any sequence of narrative event calls, getSentences() SHALL
   * return sentences in the same order the events were called.
   *
   * VALIDATES: Requirements 2.2
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means the NarrativeGenerator is
   * reordering sentences relative to the order events were called — the narrative
   * would not reflect the true execution sequence.
   */
  it('getSentences returns sentences in the same order events were called', () => {
    fc.assert(
      fc.property(
        fc.array(narrativeEventArb, { minLength: 1, maxLength: 10 }),
        (events) => {
          const gen = new NarrativeGenerator();

          // Apply each event and record the sentence it produces
          const expectedSentences: string[] = [];
          for (const event of events) {
            const beforeCount = gen.getSentences().length;
            applyEvent(gen, event);
            const afterSentences = gen.getSentences();
            // Each event produces exactly one sentence
            expect(afterSentences.length).toBe(beforeCount + 1);
            expectedSentences.push(afterSentences[afterSentences.length - 1]);
          }

          // Final sentences should match the order we recorded
          const finalSentences = gen.getSentences();
          expect(finalSentences).toEqual(expectedSentences);
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Property 3: Decider sentences include rationale when provided
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 3: Decider sentences include rationale when provided', () => {
  /**
   * PROPERTY: For any decider event with a non-empty rationale string, the
   * generated sentence SHALL contain both the branch name and the rationale text.
   *
   * VALIDATES: Requirements 4.1, 4.3
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means the NarrativeGenerator is
   * dropping the rationale or branch name from decision sentences — the reader
   * loses the "why" behind the decision, which is the most valuable part of
   * the narrative for LLM context engineering.
   */
  it('decision sentence contains both branch display name and rationale', () => {
    fc.assert(
      fc.property(
        stageNameArb,
        stageNameArb,
        displayNameArb,
        rationaleArb,
        (decider, branch, branchDisplay, rationale) => {
          const gen = new NarrativeGenerator();
          gen.onDecision(decider, branch, branchDisplay, rationale);
          const sentences = gen.getSentences();

          expect(sentences.length).toBe(1);
          expect(sentences[0]).toContain(branchDisplay);
          expect(sentences[0]).toContain(rationale);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * PROPERTY: When no rationale is provided, the sentence still contains
   * the branch name (graceful degradation).
   *
   * VALIDATES: Requirements 4.3
   *
   * COUNTEREXAMPLE MEANING: If this fails, decisions without rationale are
   * not including the branch name — the reader can't tell which path was taken.
   */
  it('decision sentence without rationale still contains branch name', () => {
    fc.assert(
      fc.property(
        stageNameArb,
        stageNameArb,
        displayNameArb,
        (decider, branch, branchDisplay) => {
          const gen = new NarrativeGenerator();
          gen.onDecision(decider, branch, branchDisplay, undefined);
          const sentences = gen.getSentences();

          expect(sentences.length).toBe(1);
          expect(sentences[0]).toContain(branchDisplay);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 4: NullNarrativeGenerator always returns empty
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 4: NullNarrativeGenerator always returns empty', () => {
  /**
   * PROPERTY: For any sequence of narrative event calls on NullNarrativeGenerator,
   * getSentences() SHALL always return an empty array.
   *
   * VALIDATES: Requirements 1.2, 9.3
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means the NullNarrativeGenerator
   * is accumulating sentences when it should be a complete no-op — production
   * pipelines would pay an unexpected cost for narrative generation.
   */
  it('getSentences always returns empty array regardless of events called', () => {
    fc.assert(
      fc.property(
        fc.array(narrativeEventArb, { minLength: 0, maxLength: 15 }),
        (events) => {
          const nullGen = new NullNarrativeGenerator();

          for (const event of events) {
            // Apply the same events but on NullNarrativeGenerator
            switch (event.type) {
              case 'stageExecuted':
                nullGen.onStageExecuted(event.stageName, event.displayName);
                break;
              case 'next':
                nullGen.onNext(event.from, event.to, event.toDisplay);
                break;
              case 'decision':
                nullGen.onDecision(event.decider, event.branch, event.display, event.rationale);
                break;
              case 'fork':
                nullGen.onFork(event.parent, event.children);
                break;
              case 'subflowEntry':
                nullGen.onSubflowEntry(event.name);
                break;
              case 'subflowExit':
                nullGen.onSubflowExit(event.name);
                break;
              case 'loop':
                nullGen.onLoop(event.target, event.display, event.iteration);
                break;
              case 'break':
                nullGen.onBreak(event.stageName, event.display);
                break;
              case 'error':
                nullGen.onError(event.stageName, event.message, event.display);
                break;
            }
          }

          const sentences = nullGen.getSentences();
          expect(sentences).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Property 5: Sentences contain no internal identifiers
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 5: Sentences contain no internal identifiers', () => {
  /**
   * PROPERTY: For any generated narrative sentence, the sentence SHALL not
   * contain path separators, object notation, or JSON-like structures.
   *
   * VALIDATES: Requirements 8.5
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means the NarrativeGenerator is
   * leaking internal identifiers, file paths, or serialized objects into the
   * narrative — the output reads like debug logs instead of a human story.
   */
  it('no sentence contains path separators, object notation, or JSON structures', () => {
    fc.assert(
      fc.property(
        fc.array(narrativeEventArb, { minLength: 1, maxLength: 10 }),
        (events) => {
          const gen = new NarrativeGenerator();

          // Start with a first stage so the generator is initialized
          gen.onStageExecuted('initStage', 'initialize');

          for (const event of events) {
            applyEvent(gen, event);
          }

          const sentences = gen.getSentences();

          for (const sentence of sentences) {
            // No path separators (forward slash used as path, not in normal prose)
            // Allow "of" patterns like "2 of 4" but disallow file-path-like slashes
            expect(sentence).not.toMatch(/\w\/\w/);

            // No backslash path separators
            expect(sentence).not.toContain('\\');

            // No JSON-like structures: opening braces/brackets
            expect(sentence).not.toMatch(/[{}\[\]]/);

            // No object dot notation (e.g., "obj.prop" patterns)
            // Allow sentence-ending periods and decimal numbers
            expect(sentence).not.toMatch(/[a-zA-Z]\.[a-zA-Z]/);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
