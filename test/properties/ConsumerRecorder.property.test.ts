/**
 * Property-based tests for Consumer Recorder Equality
 *
 * These tests verify that custom consumer recorders implementing the Recorder
 * interface receive the same events with the same data as library-provided
 * recorders when attached to the same Scope.
 *
 * Feature: scope-recorder-pattern
 */

import * as fc from 'fast-check';
import { GlobalStore } from '../../src/core/memory/GlobalStore';
import { Scope } from '../../src/scope/Scope';
import { DebugRecorder } from '../../src/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../src/scope/recorders/MetricRecorder';
import type {
  CommitEvent,
  ErrorEvent,
  ReadEvent,
  Recorder,
  StageEvent,
  WriteEvent,
} from '../../src/scope/types';

// ============================================================================
// Spy Recorder - A custom consumer recorder for testing
// ============================================================================

/**
 * Recorded event with type information for comparison.
 */
interface RecordedEvent {
  type: 'read' | 'write' | 'commit' | 'error' | 'stageStart' | 'stageEnd';
  event: ReadEvent | WriteEvent | CommitEvent | ErrorEvent | StageEvent;
}

/**
 * SpyRecorder - A simple consumer recorder that records all events.
 *
 * This implements the Recorder interface exactly as a library consumer would,
 * recording all events for later comparison with library recorders.
 */
class SpyRecorder implements Recorder {
  readonly id: string;
  private events: RecordedEvent[] = [];

  constructor(id: string) {
    this.id = id;
  }

  onRead(event: ReadEvent): void {
    this.events.push({ type: 'read', event: { ...event } });
  }

  onWrite(event: WriteEvent): void {
    this.events.push({ type: 'write', event: { ...event } });
  }

  onCommit(event: CommitEvent): void {
    // Deep copy mutations array to avoid reference issues
    this.events.push({
      type: 'commit',
      event: {
        ...event,
        mutations: event.mutations.map((m) => ({ ...m, path: [...m.path] })),
      },
    });
  }

  onError(event: ErrorEvent): void {
    this.events.push({
      type: 'error',
      event: {
        ...event,
        path: event.path ? [...event.path] : undefined,
      },
    });
  }

  onStageStart(event: StageEvent): void {
    this.events.push({ type: 'stageStart', event: { ...event } });
  }

  onStageEnd(event: StageEvent): void {
    this.events.push({ type: 'stageEnd', event: { ...event } });
  }

  getEvents(): RecordedEvent[] {
    return [...this.events];
  }

  getEventsByType(type: RecordedEvent['type']): RecordedEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  clear(): void {
    this.events = [];
  }
}

// ============================================================================
// Arbitraries (Generators)
// ============================================================================

/**
 * Arbitrary for valid path segments (non-empty strings without special chars).
 */
const arbPathSegment = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

/**
 * Arbitrary for valid paths (arrays of path segments).
 */
const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 3 });

/**
 * Arbitrary for valid keys (non-empty strings).
 */
const arbKey = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

/**
 * Arbitrary for pipeline IDs.
 */
const arbPipelineId = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/**
 * Arbitrary for stage names.
 */
const arbStageName = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/**
 * Arbitrary for JSON-serializable primitive values.
 */
const arbPrimitive = fc.oneof(
  fc.string({ maxLength: 50 }),
  fc.integer({ min: -10000, max: 10000 }),
  fc.boolean(),
  fc.constant(null)
);

/**
 * Arbitrary for JSON-serializable values.
 */
const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  primitive: arbPrimitive,
  array: fc.array(tie('primitive'), { maxLength: 5 }),
  object: fc.dictionary(arbKey, tie('primitive'), { maxKeys: 3 }),
  value: fc.oneof(
    { weight: 3, arbitrary: tie('primitive') },
    { weight: 1, arbitrary: tie('array') },
    { weight: 1, arbitrary: tie('object') }
  ),
})).value;

/**
 * Operation types for generating sequences.
 */
type OperationType = 'read' | 'setValue' | 'updateValue' | 'commit' | 'startStage' | 'endStage';

/**
 * Arbitrary for a single operation type.
 */
const arbOperation: fc.Arbitrary<OperationType> = fc.constantFrom(
  'read',
  'setValue',
  'updateValue',
  'commit',
  'startStage',
  'endStage'
);

/**
 * Arbitrary for a sequence of operations.
 */
const arbOperationSequence = fc.array(arbOperation, { minLength: 1, maxLength: 30 });

// ============================================================================
// Property Tests
// ============================================================================

describe('Consumer Recorder Property Tests', () => {
  describe('Property 20: Consumer Recorder Equality', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 20: Consumer Recorder Equality
     * **Validates: Requirements 7.2, 7.4**
     *
     * For any custom Recorder implementing the Recorder interface, it SHALL
     * receive the same events with the same data as library-provided Recorders
     * when attached to the same Scope.
     */

    test('consumer recorder receives same read events as DebugRecorder', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          fc.nat({ max: 10 }),
          (pipelineId, stageName, path, key, value, numReads) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');
            const debugRecorder = new DebugRecorder({ id: 'debug-recorder', verbosity: 'verbose' });

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder, debugRecorder],
            });

            // Set initial value so reads return something
            scope.setValue(path, key, value);
            scope.commit();

            // Clear recorders to start fresh
            spyRecorder.clear();
            debugRecorder.clear();

            // Act - perform reads
            for (let i = 0; i < numReads; i++) {
              scope.getValue(path, key);
            }

            // Assert - both recorders should have the same number of read events
            const spyReadEvents = spyRecorder.getEventsByType('read');
            const debugEntries = debugRecorder.getEntries().filter((e) => e.type === 'read');

            expect(spyReadEvents.length).toBe(numReads);
            expect(debugEntries.length).toBe(numReads);

            // Verify event data matches
            for (let i = 0; i < numReads; i++) {
              const spyEvent = spyReadEvents[i].event as ReadEvent;
              const debugEntry = debugEntries[i];

              expect(spyEvent.stageName).toBe(debugEntry.stageName);
              expect(spyEvent.pipelineId).toBe(pipelineId);
              expect(spyEvent.path).toEqual(path);
              expect(spyEvent.key).toBe(key);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder receives same write events as DebugRecorder', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          fc.array(arbJsonValue, { minLength: 1, maxLength: 10 }),
          (pipelineId, stageName, path, key, values) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');
            const debugRecorder = new DebugRecorder({ id: 'debug-recorder', verbosity: 'verbose' });

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder, debugRecorder],
            });

            // Act - perform writes
            for (const value of values) {
              scope.setValue(path, key, value);
            }

            // Assert - both recorders should have the same number of write events
            const spyWriteEvents = spyRecorder.getEventsByType('write');
            const debugEntries = debugRecorder.getEntries().filter((e) => e.type === 'write');

            expect(spyWriteEvents.length).toBe(values.length);
            expect(debugEntries.length).toBe(values.length);

            // Verify event data matches
            for (let i = 0; i < values.length; i++) {
              const spyEvent = spyWriteEvents[i].event as WriteEvent;
              const debugData = debugEntries[i].data as {
                path: string[];
                key: string;
                value: unknown;
                operation: string;
              };

              expect(spyEvent.stageName).toBe(debugEntries[i].stageName);
              expect(spyEvent.pipelineId).toBe(pipelineId);
              expect(spyEvent.path).toEqual(debugData.path);
              expect(spyEvent.key).toBe(debugData.key);
              expect(spyEvent.value).toEqual(debugData.value);
              expect(spyEvent.operation).toBe(debugData.operation);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder receives same commit events with mutations', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.array(fc.tuple(arbPath, arbKey, arbJsonValue), { minLength: 1, maxLength: 5 }),
          (pipelineId, stageName, writes) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - perform writes and commit
            for (const [path, key, value] of writes) {
              scope.setValue(path, key, value);
            }
            scope.commit();

            // Assert - spy recorder should have received commit event
            const commitEvents = spyRecorder.getEventsByType('commit');
            expect(commitEvents.length).toBe(1);

            const commitEvent = commitEvents[0].event as CommitEvent;
            expect(commitEvent.stageName).toBe(stageName);
            expect(commitEvent.pipelineId).toBe(pipelineId);
            expect(commitEvent.mutations.length).toBe(writes.length);

            // Verify mutations contain correct data
            for (let i = 0; i < writes.length; i++) {
              const [expectedPath, expectedKey, expectedValue] = writes[i];
              const mutation = commitEvent.mutations[i];

              expect(mutation.path).toEqual(expectedPath);
              expect(mutation.key).toBe(expectedKey);
              expect(mutation.value).toEqual(expectedValue);
              expect(mutation.operation).toBe('set');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder receives same stage lifecycle events as MetricRecorder', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 5 }),
          (pipelineId, initialStage, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');
            const metricRecorder = new MetricRecorder('metric-recorder');

            const scope = new Scope({
              pipelineId,
              stageName: initialStage,
              globalStore,
              recorders: [spyRecorder, metricRecorder],
            });

            // Act - start and end each stage
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Assert - spy recorder should have received all stage events
            const stageStartEvents = spyRecorder.getEventsByType('stageStart');
            const stageEndEvents = spyRecorder.getEventsByType('stageEnd');

            expect(stageStartEvents.length).toBe(stageNames.length);
            expect(stageEndEvents.length).toBe(stageNames.length);

            // Verify MetricRecorder tracked the same stages
            const metrics = metricRecorder.getMetrics();
            expect(metrics.stageMetrics.size).toBe(stageNames.length);

            // Verify stage names match
            for (let i = 0; i < stageNames.length; i++) {
              const startEvent = stageStartEvents[i].event as StageEvent;
              const endEvent = stageEndEvents[i].event as StageEvent;

              expect(startEvent.stageName).toBe(stageNames[i]);
              expect(endEvent.stageName).toBe(stageNames[i]);
              expect(startEvent.pipelineId).toBe(pipelineId);
              expect(endEvent.pipelineId).toBe(pipelineId);

              // MetricRecorder should have metrics for this stage
              const stageMetrics = metricRecorder.getStageMetrics(stageNames[i]);
              expect(stageMetrics).toBeDefined();
              expect(stageMetrics?.invocationCount).toBe(1);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder can be attached and detached like library recorders', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          arbJsonValue,
          (pipelineId, stageName, path, key, valueBefore, valueAfter) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - attach recorder, perform operation, detach, perform another operation
            scope.attachRecorder(spyRecorder);
            scope.setValue(path, key, valueBefore);

            // Verify recorder is in the list
            const recordersBeforeDetach = scope.getRecorders();
            expect(recordersBeforeDetach.some((r) => r.id === 'spy-recorder')).toBe(true);

            // Detach recorder
            scope.detachRecorder('spy-recorder');

            // Verify recorder is no longer in the list
            const recordersAfterDetach = scope.getRecorders();
            expect(recordersAfterDetach.some((r) => r.id === 'spy-recorder')).toBe(false);

            // Perform another operation
            scope.setValue(path, key, valueAfter);

            // Assert - spy recorder should only have the first write event
            const writeEvents = spyRecorder.getEventsByType('write');
            expect(writeEvents.length).toBe(1);

            const writeEvent = writeEvents[0].event as WriteEvent;
            expect(writeEvent.value).toEqual(valueBefore);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder receives events in same order as library recorders', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');
            const debugRecorder = new DebugRecorder({ id: 'debug-recorder', verbosity: 'verbose' });

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder, debugRecorder],
            });

            // Act - perform a sequence of operations
            scope.startStage(stageName);
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();
            scope.endStage();

            // Assert - both recorders should have events in the same order
            const spyEvents = spyRecorder.getEvents();
            const debugEntries = debugRecorder.getEntries();

            // Map debug entry types to our event types
            const debugEventTypes = debugEntries.map((e) => e.type);
            const spyEventTypes = spyEvents.map((e) => e.type);

            // Both should have: stageStart, write, read, stageEnd
            // (commit is not recorded by DebugRecorder, but we can verify the others)
            expect(spyEventTypes).toContain('stageStart');
            expect(spyEventTypes).toContain('write');
            expect(spyEventTypes).toContain('read');
            expect(spyEventTypes).toContain('commit');
            expect(spyEventTypes).toContain('stageEnd');

            // Verify order: stageStart should come before write
            const stageStartIndex = spyEventTypes.indexOf('stageStart');
            const writeIndex = spyEventTypes.indexOf('write');
            const readIndex = spyEventTypes.indexOf('read');
            const commitIndex = spyEventTypes.indexOf('commit');
            const stageEndIndex = spyEventTypes.indexOf('stageEnd');

            expect(stageStartIndex).toBeLessThan(writeIndex);
            expect(writeIndex).toBeLessThan(readIndex);
            expect(readIndex).toBeLessThan(commitIndex);
            expect(commitIndex).toBeLessThan(stageEndIndex);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple consumer recorders all receive the same events', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          fc.integer({ min: 2, max: 5 }),
          (pipelineId, stageName, path, key, value, numRecorders) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorders = Array.from(
              { length: numRecorders },
              (_, i) => new SpyRecorder(`spy-recorder-${i}`)
            );

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: spyRecorders,
            });

            // Act - perform operations
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();

            // Assert - all recorders should have the same events
            const firstRecorderEvents = spyRecorders[0].getEvents();

            for (let i = 1; i < numRecorders; i++) {
              const otherRecorderEvents = spyRecorders[i].getEvents();

              expect(otherRecorderEvents.length).toBe(firstRecorderEvents.length);

              for (let j = 0; j < firstRecorderEvents.length; j++) {
                expect(otherRecorderEvents[j].type).toBe(firstRecorderEvents[j].type);

                // Verify key event properties match (timestamps may differ slightly)
                const firstEvent = firstRecorderEvents[j].event;
                const otherEvent = otherRecorderEvents[j].event;

                expect((otherEvent as any).stageName).toBe((firstEvent as any).stageName);
                expect((otherEvent as any).pipelineId).toBe((firstEvent as any).pipelineId);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder attached at stage level receives only stage events', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 4 }),
          arbPath,
          arbKey,
          arbJsonValue,
          (pipelineId, stageNames, path, key, value) => {
            fc.pre(stageNames.length >= 2);

            // Arrange
            const globalStore = new GlobalStore();
            const targetStage = stageNames[0];
            const otherStage = stageNames[1];

            const stageSpyRecorder = new SpyRecorder('stage-spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
            });

            // Attach recorder only to target stage
            scope.attachStageRecorder(targetStage, stageSpyRecorder);

            // Act - perform operations in target stage
            scope.startStage(targetStage);
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();
            scope.endStage();

            const eventsAfterTargetStage = stageSpyRecorder.getEvents().length;

            // Perform operations in other stage
            scope.startStage(otherStage);
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();
            scope.endStage();

            // Assert - recorder should only have events from target stage
            const allEvents = stageSpyRecorder.getEvents();
            expect(allEvents.length).toBe(eventsAfterTargetStage);

            // All events should be from target stage
            for (const event of allEvents) {
              expect((event.event as any).stageName).toBe(targetStage);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder with partial implementation receives only implemented hooks', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, path, key, value) => {
            // Arrange - create a partial recorder that only implements onWrite
            const writeOnlyEvents: WriteEvent[] = [];
            const partialRecorder: Recorder = {
              id: 'partial-recorder',
              onWrite(event: WriteEvent): void {
                writeOnlyEvents.push({ ...event });
              },
              // Other hooks are not implemented
            };

            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [partialRecorder],
            });

            // Act - perform various operations (should not throw)
            scope.startStage(stageName);
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();
            scope.endStage();

            // Assert - only write events should be captured
            expect(writeOnlyEvents.length).toBe(1);
            expect(writeOnlyEvents[0].path).toEqual(path);
            expect(writeOnlyEvents[0].key).toBe(key);
            expect(writeOnlyEvents[0].value).toEqual(value);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder event data structure matches library recorder expectations', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act
            scope.startStage(stageName);
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();
            scope.endStage();

            // Assert - verify event structure matches expected types
            const events = spyRecorder.getEvents();

            // Find each event type and verify structure
            const stageStartEvent = events.find((e) => e.type === 'stageStart')?.event as StageEvent;
            expect(stageStartEvent).toBeDefined();
            expect(typeof stageStartEvent.stageName).toBe('string');
            expect(typeof stageStartEvent.pipelineId).toBe('string');
            expect(typeof stageStartEvent.timestamp).toBe('number');

            const writeEvent = events.find((e) => e.type === 'write')?.event as WriteEvent;
            expect(writeEvent).toBeDefined();
            expect(Array.isArray(writeEvent.path)).toBe(true);
            expect(typeof writeEvent.key).toBe('string');
            expect(writeEvent.operation).toBe('set');

            const readEvent = events.find((e) => e.type === 'read')?.event as ReadEvent;
            expect(readEvent).toBeDefined();
            expect(Array.isArray(readEvent.path)).toBe(true);

            const commitEvent = events.find((e) => e.type === 'commit')?.event as CommitEvent;
            expect(commitEvent).toBeDefined();
            expect(Array.isArray(commitEvent.mutations)).toBe(true);

            const stageEndEvent = events.find((e) => e.type === 'stageEnd')?.event as StageEvent;
            expect(stageEndEvent).toBeDefined();
            expect(typeof stageEndEvent.duration).toBe('number');
            expect(stageEndEvent.duration).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('consumer recorder receives updateValue operations as write events with update operation type', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          fc.dictionary(arbKey, arbPrimitive, { minKeys: 1, maxKeys: 3 }),
          fc.dictionary(arbKey, arbPrimitive, { minKeys: 1, maxKeys: 3 }),
          (pipelineId, stageName, path, key, initialValue, updateValue) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - set initial value, then update
            scope.setValue(path, key, initialValue);
            scope.updateValue(path, key, updateValue);

            // Assert - should have two write events
            const writeEvents = spyRecorder.getEventsByType('write');
            expect(writeEvents.length).toBe(2);

            // First write should be 'set' operation
            const setEvent = writeEvents[0].event as WriteEvent;
            expect(setEvent.operation).toBe('set');
            expect(setEvent.value).toEqual(initialValue);

            // Second write should be 'update' operation
            const updateEvent = writeEvents[1].event as WriteEvent;
            expect(updateEvent.operation).toBe('update');
            expect(updateEvent.value).toEqual(updateValue);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 21: Event Context Completeness', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 21: Event Context Completeness
     * **Validates: Requirements 7.5**
     *
     * For any event passed to a Recorder hook, it SHALL contain non-empty
     * stageName, non-empty pipelineId, and a valid timestamp.
     *
     * This property verifies that ALL event types (ReadEvent, WriteEvent,
     * CommitEvent, ErrorEvent, StageEvent) include the required context fields.
     */

    /**
     * Helper to validate that an event has complete context fields.
     * - stageName: must be a non-empty string
     * - pipelineId: must be a non-empty string
     * - timestamp: must be a positive number (valid Unix timestamp)
     */
    function validateEventContext(event: unknown, expectedStageName: string, expectedPipelineId: string): void {
      const ctx = event as { stageName: string; pipelineId: string; timestamp: number };

      // stageName must be a non-empty string
      expect(typeof ctx.stageName).toBe('string');
      expect(ctx.stageName.length).toBeGreaterThan(0);
      expect(ctx.stageName).toBe(expectedStageName);

      // pipelineId must be a non-empty string
      expect(typeof ctx.pipelineId).toBe('string');
      expect(ctx.pipelineId.length).toBeGreaterThan(0);
      expect(ctx.pipelineId).toBe(expectedPipelineId);

      // timestamp must be a valid Unix timestamp (positive number)
      expect(typeof ctx.timestamp).toBe('number');
      expect(ctx.timestamp).toBeGreaterThan(0);
      expect(Number.isFinite(ctx.timestamp)).toBe(true);
      expect(Number.isInteger(ctx.timestamp)).toBe(true);
    }

    test('ReadEvent includes complete context (stageName, pipelineId, timestamp)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          fc.nat({ max: 10 }),
          (pipelineId, stageName, path, key, value, numReads) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Set a value so reads return something
            scope.setValue(path, key, value);
            scope.commit();
            spyRecorder.clear();

            // Act - perform reads
            for (let i = 0; i < numReads; i++) {
              scope.getValue(path, key);
            }

            // Assert - all read events have complete context
            const readEvents = spyRecorder.getEventsByType('read');
            expect(readEvents.length).toBe(numReads);

            for (const recorded of readEvents) {
              validateEventContext(recorded.event, stageName, pipelineId);

              // Additional ReadEvent-specific checks
              const readEvent = recorded.event as ReadEvent;
              expect(Array.isArray(readEvent.path)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('WriteEvent includes complete context (stageName, pipelineId, timestamp)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          fc.array(arbJsonValue, { minLength: 1, maxLength: 10 }),
          (pipelineId, stageName, path, key, values) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - perform writes (both set and update)
            for (let i = 0; i < values.length; i++) {
              if (i % 2 === 0) {
                scope.setValue(path, key, values[i]);
              } else {
                scope.updateValue(path, key, values[i]);
              }
            }

            // Assert - all write events have complete context
            const writeEvents = spyRecorder.getEventsByType('write');
            expect(writeEvents.length).toBe(values.length);

            for (const recorded of writeEvents) {
              validateEventContext(recorded.event, stageName, pipelineId);

              // Additional WriteEvent-specific checks
              const writeEvent = recorded.event as WriteEvent;
              expect(Array.isArray(writeEvent.path)).toBe(true);
              expect(typeof writeEvent.key).toBe('string');
              expect(['set', 'update']).toContain(writeEvent.operation);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('CommitEvent includes complete context (stageName, pipelineId, timestamp)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.array(fc.tuple(arbPath, arbKey, arbJsonValue), { minLength: 1, maxLength: 5 }),
          fc.nat({ max: 5 }),
          (pipelineId, stageName, writes, numCommits) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - perform writes and multiple commits
            for (let c = 0; c <= numCommits; c++) {
              for (const [p, k, v] of writes) {
                scope.setValue(p, k, v);
              }
              scope.commit();
            }

            // Assert - all commit events have complete context
            const commitEvents = spyRecorder.getEventsByType('commit');
            expect(commitEvents.length).toBe(numCommits + 1);

            for (const recorded of commitEvents) {
              validateEventContext(recorded.event, stageName, pipelineId);

              // Additional CommitEvent-specific checks
              const commitEvent = recorded.event as CommitEvent;
              expect(Array.isArray(commitEvent.mutations)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('StageEvent (start) includes complete context (stageName, pipelineId, timestamp)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 10 }),
          (pipelineId, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - start multiple stages
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage(); // End each stage to allow starting the next
            }

            // Assert - all stageStart events have complete context
            const stageStartEvents = spyRecorder.getEventsByType('stageStart');
            expect(stageStartEvents.length).toBe(stageNames.length);

            for (let i = 0; i < stageNames.length; i++) {
              const recorded = stageStartEvents[i];
              validateEventContext(recorded.event, stageNames[i], pipelineId);

              // StageEvent at start should NOT have duration
              const stageEvent = recorded.event as StageEvent;
              expect(stageEvent.duration).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('StageEvent (end) includes complete context (stageName, pipelineId, timestamp)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 10 }),
          (pipelineId, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - start and end multiple stages
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Assert - all stageEnd events have complete context
            const stageEndEvents = spyRecorder.getEventsByType('stageEnd');
            expect(stageEndEvents.length).toBe(stageNames.length);

            for (let i = 0; i < stageNames.length; i++) {
              const recorded = stageEndEvents[i];
              validateEventContext(recorded.event, stageNames[i], pipelineId);

              // StageEvent at end should have duration (>= 0)
              const stageEvent = recorded.event as StageEvent;
              expect(typeof stageEvent.duration).toBe('number');
              expect(stageEvent.duration).toBeGreaterThanOrEqual(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('ErrorEvent includes complete context (stageName, pipelineId, timestamp)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          fc.string({ minLength: 1, maxLength: 50 }),
          (pipelineId, stageName, path, key, errorMessage) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            // Create a recorder that throws an error to trigger onError
            const errorThrowingRecorder: Recorder = {
              id: 'error-thrower',
              onWrite(): void {
                throw new Error(errorMessage);
              },
            };

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [errorThrowingRecorder, spyRecorder],
            });

            // Act - perform a write which will trigger the error
            scope.setValue(path, key, 'test-value');

            // Assert - error event should have complete context
            const errorEvents = spyRecorder.getEventsByType('error');
            expect(errorEvents.length).toBe(1);

            const recorded = errorEvents[0];
            validateEventContext(recorded.event, stageName, pipelineId);

            // Additional ErrorEvent-specific checks
            const errorEvent = recorded.event as ErrorEvent;
            expect(errorEvent.error).toBeInstanceOf(Error);
            expect(errorEvent.error.message).toBe(errorMessage);
            expect(['read', 'write', 'commit']).toContain(errorEvent.operation);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('all event types in a complete workflow have valid context', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - perform a complete workflow with all event types
            scope.startStage(stageName);
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();
            scope.endStage();

            // Assert - verify all events have complete context
            const allEvents = spyRecorder.getEvents();

            // Should have: stageStart, write, read, commit, stageEnd
            expect(allEvents.length).toBe(5);

            // Verify each event type is present and has valid context
            const eventTypes = allEvents.map((e) => e.type);
            expect(eventTypes).toContain('stageStart');
            expect(eventTypes).toContain('write');
            expect(eventTypes).toContain('read');
            expect(eventTypes).toContain('commit');
            expect(eventTypes).toContain('stageEnd');

            // Validate context for all events
            for (const recorded of allEvents) {
              validateEventContext(recorded.event, stageName, pipelineId);
            }

            // Verify timestamps are in chronological order
            const timestamps = allEvents.map((e) => (e.event as { timestamp: number }).timestamp);
            for (let i = 1; i < timestamps.length; i++) {
              expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('context fields are consistent across multiple operations in same stage', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          fc.array(arbJsonValue, { minLength: 2, maxLength: 10 }),
          (pipelineId, stageName, path, key, values) => {
            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - perform multiple operations in the same stage
            scope.startStage(stageName);
            for (const value of values) {
              scope.setValue(path, key, value);
              scope.getValue(path, key);
            }
            scope.commit();
            scope.endStage();

            // Assert - all events should have consistent stageName and pipelineId
            const allEvents = spyRecorder.getEvents();

            for (const recorded of allEvents) {
              const ctx = recorded.event as { stageName: string; pipelineId: string; timestamp: number };

              // stageName and pipelineId should be consistent
              expect(ctx.stageName).toBe(stageName);
              expect(ctx.pipelineId).toBe(pipelineId);

              // timestamp should be valid
              expect(ctx.timestamp).toBeGreaterThan(0);
              expect(Number.isFinite(ctx.timestamp)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('context fields update correctly when stage changes', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 5 }),
          arbPath,
          arbKey,
          arbJsonValue,
          (pipelineId, stageNames, path, key, value) => {
            fc.pre(stageNames.length >= 2);

            // Arrange
            const globalStore = new GlobalStore();
            const spyRecorder = new SpyRecorder('spy-recorder');

            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [spyRecorder],
            });

            // Act - perform operations in different stages
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.setValue(path, key, value);
              scope.getValue(path, key);
              scope.commit();
              scope.endStage();
            }

            // Assert - events should have correct stageName for each stage
            const allEvents = spyRecorder.getEvents();

            // Group events by stage
            const eventsByStage = new Map<string, RecordedEvent[]>();
            for (const event of allEvents) {
              const ctx = event.event as { stageName: string };
              const existing = eventsByStage.get(ctx.stageName) || [];
              existing.push(event);
              eventsByStage.set(ctx.stageName, existing);
            }

            // Each stage should have events
            for (const stageName of stageNames) {
              const stageEvents = eventsByStage.get(stageName);
              expect(stageEvents).toBeDefined();
              expect(stageEvents!.length).toBeGreaterThan(0);

              // All events for this stage should have correct context
              for (const recorded of stageEvents!) {
                validateEventContext(recorded.event, stageName, pipelineId);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
