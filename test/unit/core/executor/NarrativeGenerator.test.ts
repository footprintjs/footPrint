/**
 * NarrativeGenerator.test.ts
 *
 * Unit tests, scenario tests, and property-based tests for NarrativeGenerator.
 * Covers every branch in every method to achieve 100% line + branch coverage.
 *
 * UNCOVERED LINES TARGETED:
 * - Line 71:  onStageExecuted with description (first stage with description)
 * - Line 87:  onNext with description
 * - Line 103: onDecision with both deciderDescription AND rationale
 * - Line 105: onDecision with deciderDescription only (no rationale)
 * - Line 153: onLoop with description
 *
 * STRUCTURE:
 * 1. Unit tests - every method, every branch combination
 * 2. Scenario tests - realistic pipeline narrative flows
 * 3. Property tests - invariants with fast-check
 */

import * as fc from 'fast-check';
import { NarrativeGenerator } from '../../../../src/core/executor/narrative/NarrativeGenerator';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unit Tests — every method, every branch
// ─────────────────────────────────────────────────────────────────────────────

describe('NarrativeGenerator', () => {
  let gen: NarrativeGenerator;

  beforeEach(() => {
    gen = new NarrativeGenerator();
  });

  // ─── onStageExecuted ────────────────────────────────────────────────────────

  describe('onStageExecuted', () => {
    it('uses description for the opening sentence when provided (line 71)', () => {
      gen.onStageExecuted('init', 'Initialize', 'Set up the agent with LLM and tools');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('The process began: Set up the agent with LLM and tools.');
    });

    it('uses displayName when no description is provided', () => {
      gen.onStageExecuted('init', 'Initialize');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('The process began with Initialize.');
    });

    it('falls back to stageName when neither displayName nor description is provided', () => {
      gen.onStageExecuted('init');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('The process began with init.');
    });

    it('only generates a sentence for the first stage', () => {
      gen.onStageExecuted('first', 'First Stage');
      gen.onStageExecuted('second', 'Second Stage');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('The process began with First Stage.');
    });

    it('only generates a sentence for the first stage (with description)', () => {
      gen.onStageExecuted('first', undefined, 'First step description');
      gen.onStageExecuted('second', undefined, 'Second step description');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('The process began: First step description.');
    });

    it('uses description over displayName when both are provided', () => {
      gen.onStageExecuted('init', 'Initialize', 'Prepare the system');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('The process began: Prepare the system.');
      expect(sentences[0]).not.toContain('Initialize');
    });
  });

  // ─── onNext ─────────────────────────────────────────────────────────────────

  describe('onNext', () => {
    it('uses description when provided (line 87)', () => {
      gen.onNext('stageA', 'stageB', 'Stage B', 'Build the prompt from system instructions');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Next step: Build the prompt from system instructions.');
    });

    it('uses toDisplayName when no description is provided', () => {
      gen.onNext('stageA', 'stageB', 'Stage B');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Next, it moved on to Stage B.');
    });

    it('falls back to toStage when neither toDisplayName nor description is provided', () => {
      gen.onNext('stageA', 'stageB');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Next, it moved on to stageB.');
    });

    it('uses description over toDisplayName when both are provided', () => {
      gen.onNext('stageA', 'stageB', 'Stage B', 'Process the data');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Next step: Process the data.');
      expect(sentences[0]).not.toContain('Stage B');
    });
  });

  // ─── onDecision ─────────────────────────────────────────────────────────────

  describe('onDecision', () => {
    it('uses deciderDescription AND rationale when both are provided (line 103)', () => {
      gen.onDecision(
        'routeDecider',
        'finalize',
        'Finalize',
        'the LLM provided a final answer',
        'decided whether to use tools or respond',
      );
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe(
        'It decided whether to use tools or respond: the LLM provided a final answer, so it chose Finalize.',
      );
    });

    it('uses deciderDescription only when rationale is not provided (line 105)', () => {
      gen.onDecision(
        'routeDecider',
        'finalize',
        'Finalize',
        undefined,
        'decided whether to use tools or respond',
      );
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe(
        'It decided whether to use tools or respond and chose Finalize.',
      );
    });

    it('uses rationale without deciderDescription', () => {
      gen.onDecision('routeDecider', 'finalize', 'Finalize', 'the LLM provided a final answer');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe(
        'A decision was made: the LLM provided a final answer, so the path taken was Finalize.',
      );
    });

    it('uses generic phrasing when neither rationale nor deciderDescription is provided', () => {
      gen.onDecision('routeDecider', 'finalize', 'Finalize');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('A decision was made, and the path taken was Finalize.');
    });

    it('falls back to chosenBranch when chosenDisplayName is not provided', () => {
      gen.onDecision('routeDecider', 'finalize');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('A decision was made, and the path taken was finalize.');
    });

    it('uses chosenBranch with deciderDescription and rationale when no displayName', () => {
      gen.onDecision(
        'routeDecider',
        'finalize',
        undefined,
        'the user asked to stop',
        'decided the next action',
      );
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe(
        'It decided the next action: the user asked to stop, so it chose finalize.',
      );
    });

    it('uses chosenBranch with deciderDescription only when no displayName and no rationale', () => {
      gen.onDecision(
        'routeDecider',
        'finalize',
        undefined,
        undefined,
        'decided the next action',
      );
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('It decided the next action and chose finalize.');
    });
  });

  // ─── onFork ─────────────────────────────────────────────────────────────────

  describe('onFork', () => {
    it('lists child names and count', () => {
      gen.onFork('parallel', ['taskA', 'taskB', 'taskC']);
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('3 paths were executed in parallel: taskA, taskB, taskC.');
    });

    it('handles a single child', () => {
      gen.onFork('parallel', ['onlyTask']);
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('1 paths were executed in parallel: onlyTask.');
    });
  });

  // ─── onSelected ─────────────────────────────────────────────────────────────

  describe('onSelected', () => {
    it('lists selected names with total count', () => {
      gen.onSelected('selector', ['taskA', 'taskC'], 4);
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('2 of 4 paths were selected: taskA, taskC.');
    });

    it('handles single selection', () => {
      gen.onSelected('selector', ['taskA'], 3);
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('1 of 3 paths were selected: taskA.');
    });
  });

  // ─── onSubflowEntry / onSubflowExit ────────────────────────────────────────

  describe('onSubflowEntry', () => {
    it('generates entry sentence', () => {
      gen.onSubflowEntry('validation');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Entering the validation subflow.');
    });
  });

  describe('onSubflowExit', () => {
    it('generates exit sentence', () => {
      gen.onSubflowExit('validation');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Exiting the validation subflow.');
    });
  });

  // ─── onLoop ─────────────────────────────────────────────────────────────────

  describe('onLoop', () => {
    it('uses description when provided (line 153)', () => {
      gen.onLoop('retry', 'Retry Step', 3, 'Attempt the operation');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('On pass 3: Attempt the operation again.');
    });

    it('uses targetDisplayName when no description is provided', () => {
      gen.onLoop('retry', 'Retry Step', 2);
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('On pass 2 through Retry Step.');
    });

    it('falls back to targetStage when neither targetDisplayName nor description is provided', () => {
      gen.onLoop('retry', undefined, 1);
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('On pass 1 through retry.');
    });

    it('uses description over targetDisplayName when both are provided', () => {
      gen.onLoop('retry', 'Retry Step', 5, 'Re-validate the input');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('On pass 5: Re-validate the input again.');
      expect(sentences[0]).not.toContain('Retry Step');
    });
  });

  // ─── onBreak ────────────────────────────────────────────────────────────────

  describe('onBreak', () => {
    it('uses displayName when provided', () => {
      gen.onBreak('halt', 'Halt Execution');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Execution stopped at Halt Execution.');
    });

    it('falls back to stageName when no displayName', () => {
      gen.onBreak('halt');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('Execution stopped at halt.');
    });
  });

  // ─── onError ────────────────────────────────────────────────────────────────

  describe('onError', () => {
    it('uses displayName when provided', () => {
      gen.onError('validate', 'input was invalid', 'Validate Input');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('An error occurred at Validate Input: input was invalid.');
    });

    it('falls back to stageName when no displayName', () => {
      gen.onError('validate', 'input was invalid');
      const sentences = gen.getSentences();

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('An error occurred at validate: input was invalid.');
    });
  });

  // ─── getSentences ──────────────────────────────────────────────────────────

  describe('getSentences', () => {
    it('returns empty array when no events have occurred', () => {
      expect(gen.getSentences()).toEqual([]);
    });

    it('returns a defensive copy (mutations do not affect internal state)', () => {
      gen.onStageExecuted('init', 'Initialize');
      const copy = gen.getSentences();
      copy.push('injected sentence');
      copy[0] = 'mutated';

      const fresh = gen.getSentences();
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toBe('The process began with Initialize.');
    });

    it('accumulates sentences across multiple event types', () => {
      gen.onStageExecuted('init', 'Initialize');
      gen.onNext('init', 'process', 'Process Data');
      gen.onError('process', 'timeout', 'Process Data');

      const sentences = gen.getSentences();
      expect(sentences).toHaveLength(3);
      expect(sentences[0]).toContain('began');
      expect(sentences[1]).toContain('moved on');
      expect(sentences[2]).toContain('error');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Scenario Tests — realistic pipeline narratives
// ─────────────────────────────────────────────────────────────────────────────

describe('NarrativeGenerator scenario tests', () => {
  // ─── Linear flow ────────────────────────────────────────────────────────────

  describe('linear flow', () => {
    it('produces a coherent linear narrative with descriptions', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize', 'Set up the agent with LLM and tools');
      gen.onNext('init', 'assemble', 'Assemble Prompt', 'Build the prompt from system instructions');
      gen.onNext('assemble', 'callLLM', 'Call LLM', 'Send messages to the LLM provider');
      gen.onNext('callLLM', 'format', 'Format Output', 'Format the response for the user');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began: Set up the agent with LLM and tools.',
        'Next step: Build the prompt from system instructions.',
        'Next step: Send messages to the LLM provider.',
        'Next step: Format the response for the user.',
      ]);
    });

    it('produces a coherent linear narrative without descriptions', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onNext('init', 'assemble', 'Assemble Prompt');
      gen.onNext('assemble', 'callLLM', 'Call LLM');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'Next, it moved on to Assemble Prompt.',
        'Next, it moved on to Call LLM.',
      ]);
    });

    it('produces a linear narrative ending with a break', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onNext('init', 'check', 'Check Condition');
      gen.onBreak('check', 'Check Condition');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'Next, it moved on to Check Condition.',
        'Execution stopped at Check Condition.',
      ]);
    });
  });

  // ─── Decider flow ──────────────────────────────────────────────────────────

  describe('decider flow', () => {
    it('produces narrative with decider description and rationale', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', undefined, 'Initialize the agent');
      gen.onNext('init', 'callLLM', undefined, 'Call the language model');
      gen.onDecision(
        'routeDecider',
        'finalize',
        'Finalize',
        'the LLM provided a final answer',
        'decided whether to use tools or respond',
      );
      gen.onNext('finalize', 'output', undefined, 'Format the final response');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began: Initialize the agent.',
        'Next step: Call the language model.',
        'It decided whether to use tools or respond: the LLM provided a final answer, so it chose Finalize.',
        'Next step: Format the final response.',
      ]);
    });

    it('produces narrative with decider description but no rationale', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onDecision(
        'modeDecider',
        'fast',
        'Fast Mode',
        undefined,
        'chose the execution mode',
      );

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'It chose the execution mode and chose Fast Mode.',
      ]);
    });

    it('produces narrative with rationale but no decider description', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onDecision(
        'routeDecider',
        'toolCall',
        'Tool Call',
        'the LLM returned a tool invocation',
      );

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'A decision was made: the LLM returned a tool invocation, so the path taken was Tool Call.',
      ]);
    });

    it('produces narrative with no rationale and no decider description', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onDecision('routeDecider', 'branchA', 'Branch A');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'A decision was made, and the path taken was Branch A.',
      ]);
    });
  });

  // ─── Loop flow ──────────────────────────────────────────────────────────────

  describe('loop flow', () => {
    it('produces narrative for multiple loop iterations with descriptions', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', undefined, 'Start the retry loop');
      gen.onLoop('callAPI', 'Call API', 1, 'Call the external API');
      gen.onLoop('callAPI', 'Call API', 2, 'Call the external API');
      gen.onLoop('callAPI', 'Call API', 3, 'Call the external API');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began: Start the retry loop.',
        'On pass 1: Call the external API again.',
        'On pass 2: Call the external API again.',
        'On pass 3: Call the external API again.',
      ]);
    });

    it('produces narrative for loop iterations without descriptions', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onLoop('retry', 'Retry', 1);
      gen.onLoop('retry', 'Retry', 2);

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'On pass 1 through Retry.',
        'On pass 2 through Retry.',
      ]);
    });

    it('produces narrative for loop ending with error', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onLoop('callAPI', 'Call API', 1);
      gen.onLoop('callAPI', 'Call API', 2);
      gen.onError('callAPI', 'max retries exceeded', 'Call API');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'On pass 1 through Call API.',
        'On pass 2 through Call API.',
        'An error occurred at Call API: max retries exceeded.',
      ]);
    });
  });

  // ─── Subflow flow ──────────────────────────────────────────────────────────

  describe('subflow flow', () => {
    it('produces narrative for entering and exiting a subflow', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onNext('init', 'validate', 'Validate');
      gen.onSubflowEntry('validation');
      gen.onNext('subInit', 'subCheck', 'Sub Check');
      gen.onSubflowExit('validation');
      gen.onNext('validate', 'finish', 'Finish');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'Next, it moved on to Validate.',
        'Entering the validation subflow.',
        'Next, it moved on to Sub Check.',
        'Exiting the validation subflow.',
        'Next, it moved on to Finish.',
      ]);
    });

    it('produces narrative for nested subflows', () => {
      const gen = new NarrativeGenerator();

      gen.onStageExecuted('init', 'Initialize');
      gen.onSubflowEntry('outer');
      gen.onSubflowEntry('inner');
      gen.onNext('a', 'b', 'Step B');
      gen.onSubflowExit('inner');
      gen.onSubflowExit('outer');

      const sentences = gen.getSentences();
      expect(sentences).toEqual([
        'The process began with Initialize.',
        'Entering the outer subflow.',
        'Entering the inner subflow.',
        'Next, it moved on to Step B.',
        'Exiting the inner subflow.',
        'Exiting the outer subflow.',
      ]);
    });
  });

  // ─── Complex mixed flow ────────────────────────────────────────────────────

  describe('complex mixed flow', () => {
    it('produces a full agent-style narrative with descriptions across all event types', () => {
      const gen = new NarrativeGenerator();

      // Opening with description
      gen.onStageExecuted('init', 'Initialize', 'Set up the agent with LLM and tools');

      // Linear transition with description
      gen.onNext('init', 'assemble', 'Assemble Prompt', 'Build the prompt from system instructions');

      // Decision with deciderDescription and rationale
      gen.onDecision(
        'routeDecider',
        'toolCall',
        'Tool Call',
        'the LLM returned a tool invocation',
        'decided whether to use tools or respond',
      );

      // Loop with description
      gen.onLoop('toolCall', 'Tool Call', 1, 'Execute the requested tool');

      // Decision with deciderDescription only
      gen.onDecision(
        'routeDecider',
        'finalize',
        'Finalize',
        undefined,
        'decided whether to continue or finalize',
      );

      // Fork
      gen.onFork('parallel', ['taskA', 'taskB']);

      // Selected
      gen.onSelected('selector', ['taskA'], 2);

      // Subflow
      gen.onSubflowEntry('post-processing');
      gen.onSubflowExit('post-processing');

      // Error
      gen.onError('finalize', 'unexpected EOF', 'Finalize');

      // Break
      gen.onBreak('finalize', 'Finalize');

      const sentences = gen.getSentences();
      expect(sentences).toHaveLength(11);
      expect(sentences[0]).toBe('The process began: Set up the agent with LLM and tools.');
      expect(sentences[1]).toBe('Next step: Build the prompt from system instructions.');
      expect(sentences[2]).toBe(
        'It decided whether to use tools or respond: the LLM returned a tool invocation, so it chose Tool Call.',
      );
      expect(sentences[3]).toBe('On pass 1: Execute the requested tool again.');
      expect(sentences[4]).toBe('It decided whether to continue or finalize and chose Finalize.');
      expect(sentences[5]).toBe('2 paths were executed in parallel: taskA, taskB.');
      expect(sentences[6]).toBe('1 of 2 paths were selected: taskA.');
      expect(sentences[7]).toBe('Entering the post-processing subflow.');
      expect(sentences[8]).toBe('Exiting the post-processing subflow.');
      expect(sentences[9]).toBe('An error occurred at Finalize: unexpected EOF.');
      expect(sentences[10]).toBe('Execution stopped at Finalize.');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Property-Based Tests — invariants with fast-check
// ─────────────────────────────────────────────────────────────────────────────

// ─── Generators ──────────────────────────────────────────────────────────────

const stageNameArb = fc.stringMatching(/^[a-z]{3,10}$/).map((s) => `zq${s}`);
const wordArb = fc.stringMatching(/^[a-z]{2,8}$/);
const displayNameArb = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((words) => `xk ${words.join(' ')}`);
const descriptionArb = fc
  .array(wordArb, { minLength: 2, maxLength: 6 })
  .map((words) => `yd ${words.join(' ')}`);
const rationaleArb = fc
  .array(wordArb, { minLength: 2, maxLength: 5 })
  .map((words) => words.join(' '));
const iterationArb = fc.integer({ min: 1, max: 100 });
const errorMessageArb = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((words) => words.join(' '));
const childNamesArb = fc.array(displayNameArb, { minLength: 1, maxLength: 5 });

/**
 * Represents any narrative event including description-bearing variants.
 * Every event type in this union always produces exactly one sentence.
 */
type NarrativeEvent =
  | { type: 'stageExecutedFirst'; stageName: string; displayName: string; description?: string }
  | { type: 'next'; from: string; to: string; toDisplay: string; description?: string }
  | { type: 'decision'; decider: string; branch: string; display: string; rationale?: string; deciderDescription?: string }
  | { type: 'fork'; parent: string; children: string[] }
  | { type: 'selected'; parent: string; selected: string[]; total: number }
  | { type: 'subflowEntry'; name: string }
  | { type: 'subflowExit'; name: string }
  | { type: 'loop'; target: string; display?: string; iteration: number; description?: string }
  | { type: 'break'; stageName: string; display: string }
  | { type: 'error'; stageName: string; message: string; display: string };

/**
 * Generates a random narrative event that always produces exactly one sentence.
 * Includes description variants for onNext, onDecision, and onLoop to cover all branches.
 */
const narrativeEventArb: fc.Arbitrary<NarrativeEvent> = fc.oneof(
  // onNext with optional description
  fc.tuple(stageNameArb, stageNameArb, displayNameArb, fc.option(descriptionArb, { nil: undefined })).map(
    ([from, to, toDisplay, description]) => ({
      type: 'next' as const,
      from,
      to,
      toDisplay,
      description,
    }),
  ),
  // onDecision with all 4 branch combos for deciderDescription x rationale
  fc.tuple(
    stageNameArb,
    stageNameArb,
    displayNameArb,
    fc.option(rationaleArb, { nil: undefined }),
    fc.option(descriptionArb, { nil: undefined }),
  ).map(([decider, branch, display, rationale, deciderDescription]) => ({
    type: 'decision' as const,
    decider,
    branch,
    display,
    rationale,
    deciderDescription,
  })),
  // onFork
  fc.tuple(stageNameArb, childNamesArb).map(([parent, children]) => ({
    type: 'fork' as const,
    parent,
    children,
  })),
  // onSelected
  fc.tuple(stageNameArb, childNamesArb, fc.integer({ min: 1, max: 10 })).map(
    ([parent, selected, extra]) => ({
      type: 'selected' as const,
      parent,
      selected,
      total: selected.length + extra,
    }),
  ),
  // onSubflowEntry
  displayNameArb.map((name) => ({ type: 'subflowEntry' as const, name })),
  // onSubflowExit
  displayNameArb.map((name) => ({ type: 'subflowExit' as const, name })),
  // onLoop with optional description
  fc.tuple(stageNameArb, fc.option(displayNameArb, { nil: undefined }), iterationArb, fc.option(descriptionArb, { nil: undefined })).map(
    ([target, display, iteration, description]) => ({
      type: 'loop' as const,
      target,
      display,
      iteration,
      description,
    }),
  ),
  // onBreak
  fc.tuple(stageNameArb, displayNameArb).map(([stageName, display]) => ({
    type: 'break' as const,
    stageName,
    display,
  })),
  // onError
  fc.tuple(stageNameArb, errorMessageArb, displayNameArb).map(([stageName, message, display]) => ({
    type: 'error' as const,
    stageName,
    message,
    display,
  })),
);

/**
 * Applies a narrative event to a generator.
 * For 'stageExecutedFirst', this must only be called on a fresh generator
 * (isFirstStage = true) to guarantee it produces a sentence.
 */
function applyEvent(gen: NarrativeGenerator, event: NarrativeEvent): void {
  switch (event.type) {
    case 'stageExecutedFirst':
      gen.onStageExecuted(event.stageName, event.displayName, event.description);
      break;
    case 'next':
      gen.onNext(event.from, event.to, event.toDisplay, event.description);
      break;
    case 'decision':
      gen.onDecision(event.decider, event.branch, event.display, event.rationale, event.deciderDescription);
      break;
    case 'fork':
      gen.onFork(event.parent, event.children);
      break;
    case 'selected':
      gen.onSelected(event.parent, event.selected, event.total);
      break;
    case 'subflowEntry':
      gen.onSubflowEntry(event.name);
      break;
    case 'subflowExit':
      gen.onSubflowExit(event.name);
      break;
    case 'loop':
      gen.onLoop(event.target, event.display, event.iteration, event.description);
      break;
    case 'break':
      gen.onBreak(event.stageName, event.display);
      break;
    case 'error':
      gen.onError(event.stageName, event.message, event.display);
      break;
  }
}

describe('NarrativeGenerator property tests', () => {
  // ─── Property: Any sequence of events produces non-empty sentences ─────────

  describe('any sequence of events produces non-empty sentences', () => {
    it('every event produces a sentence that is a non-empty string', () => {
      fc.assert(
        fc.property(
          fc.array(narrativeEventArb, { minLength: 1, maxLength: 15 }),
          (events) => {
            const gen = new NarrativeGenerator();

            // Start with a first stage so onStageExecuted fires
            gen.onStageExecuted('firstStage', 'First Stage');

            for (const event of events) {
              applyEvent(gen, event);
            }

            const sentences = gen.getSentences();

            // At least the opening sentence
            expect(sentences.length).toBeGreaterThanOrEqual(1);

            // Every sentence is a non-empty string
            for (const sentence of sentences) {
              expect(typeof sentence).toBe('string');
              expect(sentence.length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('each individual event type produces a non-empty sentence', () => {
      fc.assert(
        fc.property(narrativeEventArb, (event) => {
          const gen = new NarrativeGenerator();

          // Ensure isFirstStage is consumed first if event is not stageExecutedFirst
          if (event.type !== 'stageExecutedFirst') {
            gen.onStageExecuted('initStage', 'Init');
          }

          const beforeCount = gen.getSentences().length;
          applyEvent(gen, event);
          const afterSentences = gen.getSentences();

          // The event produced exactly one sentence
          expect(afterSentences.length).toBe(beforeCount + 1);

          // That sentence is non-empty
          const newSentence = afterSentences[afterSentences.length - 1];
          expect(newSentence.length).toBeGreaterThan(0);
        }),
        { numRuns: 200 },
      );
    });
  });

  // ─── Property: getSentences returns a defensive copy ───────────────────────

  describe('getSentences returns a defensive copy', () => {
    it('mutating the returned array does not affect internal state', () => {
      fc.assert(
        fc.property(
          fc.array(narrativeEventArb, { minLength: 1, maxLength: 10 }),
          (events) => {
            const gen = new NarrativeGenerator();
            gen.onStageExecuted('firstStage', 'First Stage');

            for (const event of events) {
              applyEvent(gen, event);
            }

            // Take a snapshot of the original sentences
            const original = gen.getSentences();
            const originalCopy = [...original];

            // Mutate the returned array
            const mutable = gen.getSentences();
            mutable.push('INJECTED');
            mutable[0] = 'MUTATED';
            mutable.length = 0;

            // Internal state must be unchanged
            const afterMutation = gen.getSentences();
            expect(afterMutation).toEqual(originalCopy);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ─── Property: Sentence count matches event count ──────────────────────────

  describe('sentence count matches event count', () => {
    it('each event that always produces a sentence increments the count by exactly 1', () => {
      fc.assert(
        fc.property(
          fc.array(narrativeEventArb, { minLength: 0, maxLength: 15 }),
          (events) => {
            const gen = new NarrativeGenerator();

            // The opening stage always produces one sentence
            gen.onStageExecuted('firstStage', 'First Stage');
            let expectedCount = 1;

            for (const event of events) {
              applyEvent(gen, event);
              expectedCount += 1;
            }

            const sentences = gen.getSentences();
            expect(sentences.length).toBe(expectedCount);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('onStageExecuted after the first stage does not add a sentence', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          displayNameArb,
          fc.option(descriptionArb, { nil: undefined }),
          (stageName, displayName, description) => {
            const gen = new NarrativeGenerator();

            // First stage: produces 1 sentence
            gen.onStageExecuted('firstStage', 'First Stage');
            expect(gen.getSentences().length).toBe(1);

            // Second call: should NOT produce an additional sentence
            gen.onStageExecuted(stageName, displayName, description);
            expect(gen.getSentences().length).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
