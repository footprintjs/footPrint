/**
 * Property-based tests for DebugRecorder
 *
 * These tests verify universal properties that should hold across all valid inputs.
 *
 * Feature: scope-recorder-pattern
 */

import * as fc from 'fast-check';
import { DebugRecorder, type DebugVerbosity } from '../../src/scope/recorders/DebugRecorder';
import type { ErrorEvent, ReadEvent, StageEvent, WriteEvent } from '../../src/scope/types';

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
const arbPath = fc.array(arbPathSegment, { minLength: 0, maxLength: 3 });

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
 * Arbitrary for error messages.
 */
const arbErrorMessage = fc.string({ minLength: 1, maxLength: 100 });

/**
 * Arbitrary for error operation types.
 */
const arbErrorOperation: fc.Arbitrary<'read' | 'write' | 'commit'> = fc.constantFrom(
  'read',
  'write',
  'commit'
);

/**
 * Arbitrary for verbosity levels.
 */
const arbVerbosity: fc.Arbitrary<DebugVerbosity> = fc.constantFrom('minimal', 'verbose');

/**
 * Arbitrary for timestamps (positive integers).
 */
const arbTimestamp = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

/**
 * Arbitrary for generating an ErrorEvent.
 */
const arbErrorEvent: fc.Arbitrary<ErrorEvent> = fc.record({
  stageName: arbStageName,
  pipelineId: arbPipelineId,
  timestamp: arbTimestamp,
  error: arbErrorMessage.map((msg) => new Error(msg)),
  operation: arbErrorOperation,
  path: fc.option(arbPath, { nil: undefined }),
  key: fc.option(arbKey, { nil: undefined }),
});

/**
 * Arbitrary for generating a sequence of ErrorEvents.
 */
const arbErrorEventSequence = fc.array(arbErrorEvent, { minLength: 1, maxLength: 20 });

// ============================================================================
// Property Tests
// ============================================================================

describe('DebugRecorder Property Tests', () => {
  describe('Property 16: DebugRecorder Error Recording', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 16: DebugRecorder Error Recording
     * **Validates: Requirements 6.1**
     *
     * For any DebugRecorder attached to a Scope, when an error occurs during
     * a scope operation, that error SHALL appear in getErrors() with the
     * correct operation type and context.
     */

    test('all errors are recorded regardless of verbosity level', () => {
      fc.assert(
        fc.property(
          arbVerbosity,
          arbErrorEventSequence,
          (verbosity, errorEvents) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity });

            // Act - record all errors
            for (const event of errorEvents) {
              debugRecorder.onError(event);
            }

            // Assert - all errors should be recorded
            const errors = debugRecorder.getErrors();
            expect(errors).toHaveLength(errorEvents.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('error data is captured correctly (error object, operation, path, key)', () => {
      fc.assert(
        fc.property(arbErrorEvent, (errorEvent) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

          // Act
          debugRecorder.onError(errorEvent);

          // Assert - error should be recorded with correct data
          const errors = debugRecorder.getErrors();
          expect(errors).toHaveLength(1);

          const recordedError = errors[0];
          expect(recordedError.type).toBe('error');
          expect(recordedError.stageName).toBe(errorEvent.stageName);
          expect(recordedError.timestamp).toBe(errorEvent.timestamp);

          const data = recordedError.data as {
            error: Error;
            operation: string;
            path?: string[];
            key?: string;
            pipelineId: string;
          };

          // Verify error object is captured
          expect(data.error).toBe(errorEvent.error);
          expect(data.error.message).toBe(errorEvent.error.message);

          // Verify operation type is captured
          expect(data.operation).toBe(errorEvent.operation);

          // Verify path is captured (if provided)
          if (errorEvent.path !== undefined) {
            expect(data.path).toEqual(errorEvent.path);
          }

          // Verify key is captured (if provided)
          if (errorEvent.key !== undefined) {
            expect(data.key).toBe(errorEvent.key);
          }

          // Verify pipelineId is captured
          expect(data.pipelineId).toBe(errorEvent.pipelineId);
        }),
        { numRuns: 100 }
      );
    });

    test('errors are recorded in both minimal and verbose modes', () => {
      fc.assert(
        fc.property(arbErrorEvent, (errorEvent) => {
          // Arrange - create two recorders with different verbosity
          const minimalRecorder = new DebugRecorder({ verbosity: 'minimal' });
          const verboseRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - record the same error in both
          minimalRecorder.onError(errorEvent);
          verboseRecorder.onError(errorEvent);

          // Assert - both should have recorded the error
          const minimalErrors = minimalRecorder.getErrors();
          const verboseErrors = verboseRecorder.getErrors();

          expect(minimalErrors).toHaveLength(1);
          expect(verboseErrors).toHaveLength(1);

          // Both should have the same error data
          expect(minimalErrors[0].type).toBe('error');
          expect(verboseErrors[0].type).toBe('error');
          expect((minimalErrors[0].data as { error: Error }).error.message).toBe(
            errorEvent.error.message
          );
          expect((verboseErrors[0].data as { error: Error }).error.message).toBe(
            errorEvent.error.message
          );
        }),
        { numRuns: 100 }
      );
    });

    test('multiple errors are recorded in order', () => {
      fc.assert(
        fc.property(arbErrorEventSequence, (errorEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

          // Act - record all errors
          for (const event of errorEvents) {
            debugRecorder.onError(event);
          }

          // Assert - errors should be in the same order as recorded
          const errors = debugRecorder.getErrors();
          expect(errors).toHaveLength(errorEvents.length);

          for (let i = 0; i < errorEvents.length; i++) {
            const recorded = errors[i];
            const original = errorEvents[i];

            expect(recorded.stageName).toBe(original.stageName);
            expect(recorded.timestamp).toBe(original.timestamp);
            expect((recorded.data as { error: Error }).error.message).toBe(
              original.error.message
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    test('errors are included in getEntries() results', () => {
      fc.assert(
        fc.property(arbVerbosity, arbErrorEventSequence, (verbosity, errorEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity });

          // Act - record all errors
          for (const event of errorEvents) {
            debugRecorder.onError(event);
          }

          // Assert - errors should appear in both getErrors() and getEntries()
          const errors = debugRecorder.getErrors();
          const entries = debugRecorder.getEntries();

          // All errors should be in entries
          expect(entries.filter((e) => e.type === 'error')).toHaveLength(errorEvents.length);

          // getErrors() should return the same error entries
          expect(errors).toHaveLength(errorEvents.length);
          for (const error of errors) {
            expect(entries).toContainEqual(error);
          }
        }),
        { numRuns: 100 }
      );
    });

    test('errors are filterable by stage name', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 5 }),
          arbErrorMessage,
          arbPipelineId,
          (stageNames, errorMessage, pipelineId) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

            // Act - record one error per stage
            for (let i = 0; i < stageNames.length; i++) {
              debugRecorder.onError({
                stageName: stageNames[i],
                pipelineId,
                timestamp: 1000 + i,
                error: new Error(`${errorMessage}-${i}`),
                operation: 'read',
              });
            }

            // Assert - filtering by stage should return only that stage's errors
            for (const stageName of stageNames) {
              const stageEntries = debugRecorder.getEntriesForStage(stageName);
              expect(stageEntries).toHaveLength(1);
              expect(stageEntries[0].stageName).toBe(stageName);
              expect(stageEntries[0].type).toBe('error');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('error recording persists after verbosity change', () => {
      fc.assert(
        fc.property(arbErrorEvent, arbErrorEvent, (errorBefore, errorAfter) => {
          // Arrange - start in minimal mode
          const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

          // Act - record error, change verbosity, record another error
          debugRecorder.onError(errorBefore);
          debugRecorder.setVerbosity('verbose');
          debugRecorder.onError(errorAfter);

          // Assert - both errors should be recorded
          const errors = debugRecorder.getErrors();
          expect(errors).toHaveLength(2);

          // First error should have the data from errorBefore
          expect((errors[0].data as { error: Error }).error.message).toBe(
            errorBefore.error.message
          );

          // Second error should have the data from errorAfter
          expect((errors[1].data as { error: Error }).error.message).toBe(
            errorAfter.error.message
          );
        }),
        { numRuns: 100 }
      );
    });

    test('clear removes all errors', () => {
      fc.assert(
        fc.property(arbVerbosity, arbErrorEventSequence, (verbosity, errorEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity });

          // Act - record errors, then clear
          for (const event of errorEvents) {
            debugRecorder.onError(event);
          }

          // Verify errors were recorded
          expect(debugRecorder.getErrors()).toHaveLength(errorEvents.length);

          // Clear
          debugRecorder.clear();

          // Assert - no errors should remain
          expect(debugRecorder.getErrors()).toHaveLength(0);
          expect(debugRecorder.getEntries()).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    test('all error operation types are recorded correctly', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbPipelineId,
          arbTimestamp,
          arbErrorMessage,
          arbPath,
          arbKey,
          (stageName, pipelineId, timestamp, errorMessage, path, key) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });
            const operations: Array<'read' | 'write' | 'commit'> = ['read', 'write', 'commit'];

            // Act - record one error for each operation type
            for (const operation of operations) {
              debugRecorder.onError({
                stageName,
                pipelineId,
                timestamp,
                error: new Error(`${errorMessage}-${operation}`),
                operation,
                path,
                key,
              });
            }

            // Assert - all operation types should be recorded
            const errors = debugRecorder.getErrors();
            expect(errors).toHaveLength(3);

            const recordedOperations = errors.map(
              (e) => (e.data as { operation: string }).operation
            );
            expect(recordedOperations).toContain('read');
            expect(recordedOperations).toContain('write');
            expect(recordedOperations).toContain('commit');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('errors with optional path and key are handled correctly', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbPipelineId,
          arbTimestamp,
          arbErrorMessage,
          arbErrorOperation,
          fc.boolean(), // include path
          fc.boolean(), // include key
          arbPath,
          arbKey,
          (stageName, pipelineId, timestamp, errorMessage, operation, includePath, includeKey, path, key) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

            const errorEvent: ErrorEvent = {
              stageName,
              pipelineId,
              timestamp,
              error: new Error(errorMessage),
              operation,
              ...(includePath ? { path } : {}),
              ...(includeKey ? { key } : {}),
            };

            // Act
            debugRecorder.onError(errorEvent);

            // Assert
            const errors = debugRecorder.getErrors();
            expect(errors).toHaveLength(1);

            const data = errors[0].data as {
              error: Error;
              operation: string;
              path?: string[];
              key?: string;
            };

            // Path should be present only if included
            if (includePath) {
              expect(data.path).toEqual(path);
            }

            // Key should be present only if included
            if (includeKey) {
              expect(data.key).toBe(key);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 17: DebugRecorder Mutation Recording', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 17: DebugRecorder Mutation Recording
     * **Validates: Requirements 6.2, 6.3**
     *
     * For any DebugRecorder (verbosity verbose) attached to a Scope, all setValue
     * and updateValue operations SHALL appear in getEntries() with correct path,
     * key, and value.
     */

    /**
     * Arbitrary for write operation types.
     */
    const arbWriteOperation: fc.Arbitrary<'set' | 'update'> = fc.constantFrom('set', 'update');

    /**
     * Arbitrary for simple JSON-serializable values.
     */
    const arbValue = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 5 }),
      fc.dictionary(arbKey, fc.integer(), { maxKeys: 3 })
    );

    /**
     * Arbitrary for generating a WriteEvent.
     */
    const arbWriteEvent: fc.Arbitrary<WriteEvent> = fc.record({
      stageName: arbStageName,
      pipelineId: arbPipelineId,
      timestamp: arbTimestamp,
      path: arbPath,
      key: arbKey,
      value: arbValue,
      operation: arbWriteOperation,
    });

    /**
     * Arbitrary for generating a sequence of WriteEvents.
     */
    const arbWriteEventSequence = fc.array(arbWriteEvent, { minLength: 1, maxLength: 20 });

    test('all mutations are recorded in verbose mode', () => {
      fc.assert(
        fc.property(arbWriteEventSequence, (writeEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - record all writes
          for (const event of writeEvents) {
            debugRecorder.onWrite(event);
          }

          // Assert - all writes should be recorded
          const entries = debugRecorder.getEntries();
          const writeEntries = entries.filter((e) => e.type === 'write');
          expect(writeEntries).toHaveLength(writeEvents.length);
        }),
        { numRuns: 100 }
      );
    });

    test('mutation data includes path, key, value, and operation type', () => {
      fc.assert(
        fc.property(arbWriteEvent, (writeEvent) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act
          debugRecorder.onWrite(writeEvent);

          // Assert - write should be recorded with correct data
          const entries = debugRecorder.getEntries();
          expect(entries).toHaveLength(1);

          const recordedWrite = entries[0];
          expect(recordedWrite.type).toBe('write');
          expect(recordedWrite.stageName).toBe(writeEvent.stageName);
          expect(recordedWrite.timestamp).toBe(writeEvent.timestamp);

          const data = recordedWrite.data as {
            path: string[];
            key: string;
            value: unknown;
            operation: 'set' | 'update';
            pipelineId: string;
          };

          // Verify path is captured correctly
          expect(data.path).toEqual(writeEvent.path);

          // Verify key is captured correctly
          expect(data.key).toBe(writeEvent.key);

          // Verify value is captured correctly
          expect(data.value).toEqual(writeEvent.value);

          // Verify operation type is captured correctly
          expect(data.operation).toBe(writeEvent.operation);

          // Verify pipelineId is captured
          expect(data.pipelineId).toBe(writeEvent.pipelineId);
        }),
        { numRuns: 100 }
      );
    });

    test('mutations are NOT recorded in minimal mode', () => {
      fc.assert(
        fc.property(arbWriteEventSequence, (writeEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

          // Act - attempt to record all writes
          for (const event of writeEvents) {
            debugRecorder.onWrite(event);
          }

          // Assert - no writes should be recorded in minimal mode
          const entries = debugRecorder.getEntries();
          const writeEntries = entries.filter((e) => e.type === 'write');
          expect(writeEntries).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    test('both set and update operations are recorded correctly', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbPipelineId,
          arbTimestamp,
          arbPath,
          arbKey,
          arbValue,
          arbValue,
          (stageName, pipelineId, timestamp, path, key, setValue, updateValue) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - record one 'set' and one 'update' operation
            debugRecorder.onWrite({
              stageName,
              pipelineId,
              timestamp,
              path,
              key,
              value: setValue,
              operation: 'set',
            });

            debugRecorder.onWrite({
              stageName,
              pipelineId,
              timestamp: timestamp + 1,
              path,
              key,
              value: updateValue,
              operation: 'update',
            });

            // Assert - both operations should be recorded
            const entries = debugRecorder.getEntries();
            expect(entries).toHaveLength(2);

            const setEntry = entries.find(
              (e) => (e.data as { operation: string }).operation === 'set'
            );
            const updateEntry = entries.find(
              (e) => (e.data as { operation: string }).operation === 'update'
            );

            expect(setEntry).toBeDefined();
            expect(updateEntry).toBeDefined();

            // Verify set operation data
            expect((setEntry!.data as { value: unknown }).value).toEqual(setValue);
            expect((setEntry!.data as { operation: string }).operation).toBe('set');

            // Verify update operation data
            expect((updateEntry!.data as { value: unknown }).value).toEqual(updateValue);
            expect((updateEntry!.data as { operation: string }).operation).toBe('update');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('mutations are recorded in order', () => {
      fc.assert(
        fc.property(arbWriteEventSequence, (writeEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - record all writes
          for (const event of writeEvents) {
            debugRecorder.onWrite(event);
          }

          // Assert - writes should be in the same order as recorded
          const entries = debugRecorder.getEntries();
          expect(entries).toHaveLength(writeEvents.length);

          for (let i = 0; i < writeEvents.length; i++) {
            const recorded = entries[i];
            const original = writeEvents[i];

            expect(recorded.stageName).toBe(original.stageName);
            expect(recorded.timestamp).toBe(original.timestamp);
            expect((recorded.data as { key: string }).key).toBe(original.key);
            expect((recorded.data as { value: unknown }).value).toEqual(original.value);
          }
        }),
        { numRuns: 100 }
      );
    });

    test('mutations are filterable by stage name', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 5 }),
          arbPipelineId,
          arbPath,
          arbKey,
          arbValue,
          (stageNames, pipelineId, path, key, value) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - record one write per stage
            for (let i = 0; i < stageNames.length; i++) {
              debugRecorder.onWrite({
                stageName: stageNames[i],
                pipelineId,
                timestamp: 1000 + i,
                path,
                key: `${key}_${i}`,
                value,
                operation: 'set',
              });
            }

            // Assert - filtering by stage should return only that stage's writes
            for (const stageName of stageNames) {
              const stageEntries = debugRecorder.getEntriesForStage(stageName);
              expect(stageEntries).toHaveLength(1);
              expect(stageEntries[0].stageName).toBe(stageName);
              expect(stageEntries[0].type).toBe('write');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('mutation recording starts after switching from minimal to verbose', () => {
      fc.assert(
        fc.property(arbWriteEvent, arbWriteEvent, (writeBefore, writeAfter) => {
          // Arrange - start in minimal mode
          const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

          // Act - write in minimal mode, switch to verbose, write again
          debugRecorder.onWrite(writeBefore);
          debugRecorder.setVerbosity('verbose');
          debugRecorder.onWrite(writeAfter);

          // Assert - only the second write should be recorded
          const entries = debugRecorder.getEntries();
          const writeEntries = entries.filter((e) => e.type === 'write');
          expect(writeEntries).toHaveLength(1);

          // The recorded write should be the one after verbosity change
          expect((writeEntries[0].data as { key: string }).key).toBe(writeAfter.key);
          expect((writeEntries[0].data as { value: unknown }).value).toEqual(writeAfter.value);
        }),
        { numRuns: 100 }
      );
    });

    test('mutation recording stops after switching from verbose to minimal', () => {
      fc.assert(
        fc.property(arbWriteEvent, arbWriteEvent, (writeBefore, writeAfter) => {
          // Arrange - start in verbose mode
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - write in verbose mode, switch to minimal, write again
          debugRecorder.onWrite(writeBefore);
          debugRecorder.setVerbosity('minimal');
          debugRecorder.onWrite(writeAfter);

          // Assert - only the first write should be recorded
          const entries = debugRecorder.getEntries();
          const writeEntries = entries.filter((e) => e.type === 'write');
          expect(writeEntries).toHaveLength(1);

          // The recorded write should be the one before verbosity change
          expect((writeEntries[0].data as { key: string }).key).toBe(writeBefore.key);
          expect((writeEntries[0].data as { value: unknown }).value).toEqual(writeBefore.value);
        }),
        { numRuns: 100 }
      );
    });

    test('clear removes all mutations', () => {
      fc.assert(
        fc.property(arbWriteEventSequence, (writeEvents) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - record writes, then clear
          for (const event of writeEvents) {
            debugRecorder.onWrite(event);
          }

          // Verify writes were recorded
          expect(debugRecorder.getEntries().filter((e) => e.type === 'write')).toHaveLength(
            writeEvents.length
          );

          // Clear
          debugRecorder.clear();

          // Assert - no writes should remain
          expect(debugRecorder.getEntries()).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    test('mutations with various value types are recorded correctly', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbPipelineId,
          arbTimestamp,
          arbPath,
          arbKey,
          arbWriteOperation,
          (stageName, pipelineId, timestamp, path, key, operation) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Test various value types
            const testValues: unknown[] = [
              'string value',
              42,
              true,
              false,
              null,
              [1, 2, 3],
              { nested: 'object', count: 5 },
              '',
              0,
              [],
              {},
            ];

            // Act - record writes with different value types
            for (let i = 0; i < testValues.length; i++) {
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: timestamp + i,
                path,
                key: `${key}_${i}`,
                value: testValues[i],
                operation,
              });
            }

            // Assert - all writes should be recorded with correct values
            const entries = debugRecorder.getEntries();
            expect(entries).toHaveLength(testValues.length);

            for (let i = 0; i < testValues.length; i++) {
              const recordedValue = (entries[i].data as { value: unknown }).value;
              expect(recordedValue).toEqual(testValues[i]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('mutations and errors can coexist in entries', () => {
      fc.assert(
        fc.property(arbWriteEvent, arbErrorEvent, (writeEvent, errorEvent) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - record both a write and an error
          debugRecorder.onWrite(writeEvent);
          debugRecorder.onError(errorEvent);

          // Assert - both should be in entries
          const entries = debugRecorder.getEntries();
          expect(entries).toHaveLength(2);

          const writeEntries = entries.filter((e) => e.type === 'write');
          const errorEntries = entries.filter((e) => e.type === 'error');

          expect(writeEntries).toHaveLength(1);
          expect(errorEntries).toHaveLength(1);

          // Verify write data
          expect((writeEntries[0].data as { key: string }).key).toBe(writeEvent.key);

          // Verify error data
          expect((errorEntries[0].data as { error: Error }).error.message).toBe(
            errorEvent.error.message
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 18: DebugRecorder Verbosity Levels', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 18: DebugRecorder Verbosity Levels
     * **Validates: Requirements 6.4, 6.7**
     *
     * For any DebugRecorder, when verbosity is 'minimal', only errors SHALL be
     * recorded; when 'verbose', errors, mutations, and reads SHALL be recorded.
     * Verbosity can be changed at runtime and affects subsequent operations.
     */

    /**
     * Arbitrary for write operation types.
     */
    const arbWriteOperation: fc.Arbitrary<'set' | 'update'> = fc.constantFrom('set', 'update');

    /**
     * Arbitrary for simple JSON-serializable values.
     */
    const arbValue = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 5 }),
      fc.dictionary(arbKey, fc.integer(), { maxKeys: 3 })
    );

    /**
     * Arbitrary for generating a WriteEvent.
     */
    const arbWriteEvent: fc.Arbitrary<WriteEvent> = fc.record({
      stageName: arbStageName,
      pipelineId: arbPipelineId,
      timestamp: arbTimestamp,
      path: arbPath,
      key: arbKey,
      value: arbValue,
      operation: arbWriteOperation,
    });

    /**
     * Arbitrary for generating a ReadEvent.
     */
    const arbReadEvent: fc.Arbitrary<ReadEvent> = fc.record({
      stageName: arbStageName,
      pipelineId: arbPipelineId,
      timestamp: arbTimestamp,
      path: arbPath,
      key: fc.option(arbKey, { nil: undefined }),
      value: arbValue,
    });

    /**
     * Arbitrary for generating a sequence of mixed operations.
     */
    const arbMixedOperationSequence = fc.array(
      fc.oneof(
        arbReadEvent.map((e) => ({ type: 'read' as const, event: e })),
        arbWriteEvent.map((e) => ({ type: 'write' as const, event: e })),
        arbErrorEvent.map((e) => ({ type: 'error' as const, event: e }))
      ),
      { minLength: 1, maxLength: 30 }
    );

    test('minimal verbosity records only errors (no reads, no writes)', () => {
      fc.assert(
        fc.property(arbMixedOperationSequence, (operations) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

          // Act - perform all operations
          for (const op of operations) {
            if (op.type === 'read') {
              debugRecorder.onRead(op.event as ReadEvent);
            } else if (op.type === 'write') {
              debugRecorder.onWrite(op.event as WriteEvent);
            } else {
              debugRecorder.onError(op.event as ErrorEvent);
            }
          }

          // Assert - only errors should be recorded
          const entries = debugRecorder.getEntries();
          const errorCount = operations.filter((op) => op.type === 'error').length;

          // All entries should be errors
          expect(entries.every((e) => e.type === 'error')).toBe(true);
          expect(entries).toHaveLength(errorCount);

          // No reads should be recorded
          expect(entries.filter((e) => e.type === 'read')).toHaveLength(0);

          // No writes should be recorded
          expect(entries.filter((e) => e.type === 'write')).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    test('verbose verbosity records errors, writes, AND reads', () => {
      fc.assert(
        fc.property(arbMixedOperationSequence, (operations) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - perform all operations
          for (const op of operations) {
            if (op.type === 'read') {
              debugRecorder.onRead(op.event as ReadEvent);
            } else if (op.type === 'write') {
              debugRecorder.onWrite(op.event as WriteEvent);
            } else {
              debugRecorder.onError(op.event as ErrorEvent);
            }
          }

          // Assert - all operations should be recorded
          const entries = debugRecorder.getEntries();
          const errorCount = operations.filter((op) => op.type === 'error').length;
          const writeCount = operations.filter((op) => op.type === 'write').length;
          const readCount = operations.filter((op) => op.type === 'read').length;

          // Total entries should match total operations
          expect(entries).toHaveLength(operations.length);

          // Each type should have correct count
          expect(entries.filter((e) => e.type === 'error')).toHaveLength(errorCount);
          expect(entries.filter((e) => e.type === 'write')).toHaveLength(writeCount);
          expect(entries.filter((e) => e.type === 'read')).toHaveLength(readCount);
        }),
        { numRuns: 100 }
      );
    });

    test('verbosity change at runtime affects subsequent operations only', () => {
      fc.assert(
        fc.property(
          arbReadEvent,
          arbWriteEvent,
          arbErrorEvent,
          arbReadEvent,
          arbWriteEvent,
          arbErrorEvent,
          (readBefore, writeBefore, errorBefore, readAfter, writeAfter, errorAfter) => {
            // Arrange - start in minimal mode
            const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

            // Act - perform operations in minimal mode
            debugRecorder.onRead(readBefore);
            debugRecorder.onWrite(writeBefore);
            debugRecorder.onError(errorBefore);

            // Change to verbose mode
            debugRecorder.setVerbosity('verbose');

            // Perform operations in verbose mode
            debugRecorder.onRead(readAfter);
            debugRecorder.onWrite(writeAfter);
            debugRecorder.onError(errorAfter);

            // Assert
            const entries = debugRecorder.getEntries();

            // Should have: 1 error (before) + 1 read + 1 write + 1 error (after) = 4 entries
            expect(entries).toHaveLength(4);

            // First entry should be the error from minimal mode
            expect(entries[0].type).toBe('error');
            expect((entries[0].data as { error: Error }).error.message).toBe(
              errorBefore.error.message
            );

            // Subsequent entries should be from verbose mode (in order: read, write, error)
            expect(entries[1].type).toBe('read');
            expect(entries[2].type).toBe('write');
            expect(entries[3].type).toBe('error');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('switching from verbose to minimal stops recording reads and writes', () => {
      fc.assert(
        fc.property(
          arbReadEvent,
          arbWriteEvent,
          arbErrorEvent,
          arbReadEvent,
          arbWriteEvent,
          arbErrorEvent,
          (readBefore, writeBefore, errorBefore, readAfter, writeAfter, errorAfter) => {
            // Arrange - start in verbose mode
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - perform operations in verbose mode
            debugRecorder.onRead(readBefore);
            debugRecorder.onWrite(writeBefore);
            debugRecorder.onError(errorBefore);

            // Change to minimal mode
            debugRecorder.setVerbosity('minimal');

            // Perform operations in minimal mode
            debugRecorder.onRead(readAfter);
            debugRecorder.onWrite(writeAfter);
            debugRecorder.onError(errorAfter);

            // Assert
            const entries = debugRecorder.getEntries();

            // Should have: 1 read + 1 write + 1 error (before) + 1 error (after) = 4 entries
            expect(entries).toHaveLength(4);

            // First three entries should be from verbose mode
            expect(entries[0].type).toBe('read');
            expect(entries[1].type).toBe('write');
            expect(entries[2].type).toBe('error');

            // Last entry should be error from minimal mode
            expect(entries[3].type).toBe('error');
            expect((entries[3].data as { error: Error }).error.message).toBe(
              errorAfter.error.message
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple verbosity changes at runtime work correctly', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              verbosity: arbVerbosity,
              operations: arbMixedOperationSequence,
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (phases) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'minimal' });

            // Track expected counts
            let expectedErrors = 0;
            let expectedWrites = 0;
            let expectedReads = 0;

            // Act - execute each phase with its verbosity
            for (const phase of phases) {
              debugRecorder.setVerbosity(phase.verbosity);

              for (const op of phase.operations) {
                if (op.type === 'read') {
                  debugRecorder.onRead(op.event as ReadEvent);
                  if (phase.verbosity === 'verbose') {
                    expectedReads++;
                  }
                } else if (op.type === 'write') {
                  debugRecorder.onWrite(op.event as WriteEvent);
                  if (phase.verbosity === 'verbose') {
                    expectedWrites++;
                  }
                } else {
                  debugRecorder.onError(op.event as ErrorEvent);
                  expectedErrors++; // Errors always recorded
                }
              }
            }

            // Assert
            const entries = debugRecorder.getEntries();
            const actualErrors = entries.filter((e) => e.type === 'error').length;
            const actualWrites = entries.filter((e) => e.type === 'write').length;
            const actualReads = entries.filter((e) => e.type === 'read').length;

            expect(actualErrors).toBe(expectedErrors);
            expect(actualWrites).toBe(expectedWrites);
            expect(actualReads).toBe(expectedReads);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('getVerbosity returns current verbosity level', () => {
      fc.assert(
        fc.property(arbVerbosity, arbVerbosity, (initial, changed) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: initial });

          // Assert initial verbosity
          expect(debugRecorder.getVerbosity()).toBe(initial);

          // Act - change verbosity
          debugRecorder.setVerbosity(changed);

          // Assert changed verbosity
          expect(debugRecorder.getVerbosity()).toBe(changed);
        }),
        { numRuns: 100 }
      );
    });

    test('reads are only recorded in verbose mode', () => {
      fc.assert(
        fc.property(
          fc.array(arbReadEvent, { minLength: 1, maxLength: 20 }),
          (readEvents) => {
            // Arrange - two recorders with different verbosity
            const minimalRecorder = new DebugRecorder({ verbosity: 'minimal' });
            const verboseRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - record same reads in both
            for (const event of readEvents) {
              minimalRecorder.onRead(event);
              verboseRecorder.onRead(event);
            }

            // Assert
            const minimalEntries = minimalRecorder.getEntries();
            const verboseEntries = verboseRecorder.getEntries();

            // Minimal should have no reads
            expect(minimalEntries.filter((e) => e.type === 'read')).toHaveLength(0);

            // Verbose should have all reads
            expect(verboseEntries.filter((e) => e.type === 'read')).toHaveLength(
              readEvents.length
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    test('read data is captured correctly in verbose mode', () => {
      fc.assert(
        fc.property(arbReadEvent, (readEvent) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act
          debugRecorder.onRead(readEvent);

          // Assert
          const entries = debugRecorder.getEntries();
          expect(entries).toHaveLength(1);

          const recordedRead = entries[0];
          expect(recordedRead.type).toBe('read');
          expect(recordedRead.stageName).toBe(readEvent.stageName);
          expect(recordedRead.timestamp).toBe(readEvent.timestamp);

          const data = recordedRead.data as {
            path: string[];
            key?: string;
            value: unknown;
            pipelineId: string;
          };

          // Verify path is captured
          expect(data.path).toEqual(readEvent.path);

          // Verify key is captured (if provided)
          if (readEvent.key !== undefined) {
            expect(data.key).toBe(readEvent.key);
          }

          // Verify value is captured
          expect(data.value).toEqual(readEvent.value);

          // Verify pipelineId is captured
          expect(data.pipelineId).toBe(readEvent.pipelineId);
        }),
        { numRuns: 100 }
      );
    });

    test('errors are always recorded regardless of verbosity', () => {
      fc.assert(
        fc.property(
          arbVerbosity,
          fc.array(arbErrorEvent, { minLength: 1, maxLength: 10 }),
          (verbosity, errorEvents) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity });

            // Act
            for (const event of errorEvents) {
              debugRecorder.onError(event);
            }

            // Assert - errors should always be recorded
            const errors = debugRecorder.getErrors();
            expect(errors).toHaveLength(errorEvents.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('verbosity affects stage lifecycle events', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbPipelineId,
          arbTimestamp,
          fc.integer({ min: 1, max: 1000 }),
          (stageName, pipelineId, timestamp, duration) => {
            // Arrange
            const minimalRecorder = new DebugRecorder({ verbosity: 'minimal' });
            const verboseRecorder = new DebugRecorder({ verbosity: 'verbose' });

            const stageStartEvent: StageEvent = {
              stageName,
              pipelineId,
              timestamp,
            };

            const stageEndEvent: StageEvent = {
              stageName,
              pipelineId,
              timestamp: timestamp + duration,
              duration,
            };

            // Act
            minimalRecorder.onStageStart(stageStartEvent);
            minimalRecorder.onStageEnd(stageEndEvent);
            verboseRecorder.onStageStart(stageStartEvent);
            verboseRecorder.onStageEnd(stageEndEvent);

            // Assert
            const minimalEntries = minimalRecorder.getEntries();
            const verboseEntries = verboseRecorder.getEntries();

            // Minimal should have no stage events
            expect(minimalEntries.filter((e) => e.type === 'stageStart')).toHaveLength(0);
            expect(minimalEntries.filter((e) => e.type === 'stageEnd')).toHaveLength(0);

            // Verbose should have stage events
            expect(verboseEntries.filter((e) => e.type === 'stageStart')).toHaveLength(1);
            expect(verboseEntries.filter((e) => e.type === 'stageEnd')).toHaveLength(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('default verbosity is verbose', () => {
      // Arrange - create recorder without specifying verbosity
      const debugRecorder = new DebugRecorder();

      // Assert - default should be verbose
      expect(debugRecorder.getVerbosity()).toBe('verbose');
    });
  });

  describe('Property 19: DebugRecorder Stage Filtering', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 19: DebugRecorder Stage Filtering
     * **Validates: Requirements 6.6**
     *
     * For any DebugRecorder with entries from multiple stages,
     * getEntriesForStage(S) SHALL return only entries where stageName equals S.
     * Entries from other stages are NOT included.
     * Works correctly with mixed operations (reads, writes, errors) across multiple stages.
     */

    /**
     * Arbitrary for write operation types.
     */
    const arbWriteOperation: fc.Arbitrary<'set' | 'update'> = fc.constantFrom('set', 'update');

    /**
     * Arbitrary for simple JSON-serializable values.
     */
    const arbValue = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 5 }),
      fc.dictionary(arbKey, fc.integer(), { maxKeys: 3 })
    );

    /**
     * Arbitrary for generating a WriteEvent with a specific stage name.
     */
    const arbWriteEventForStage = (stageName: string): fc.Arbitrary<WriteEvent> =>
      fc.record({
        stageName: fc.constant(stageName),
        pipelineId: arbPipelineId,
        timestamp: arbTimestamp,
        path: arbPath,
        key: arbKey,
        value: arbValue,
        operation: arbWriteOperation,
      });

    /**
     * Arbitrary for generating a ReadEvent with a specific stage name.
     */
    const arbReadEventForStage = (stageName: string): fc.Arbitrary<ReadEvent> =>
      fc.record({
        stageName: fc.constant(stageName),
        pipelineId: arbPipelineId,
        timestamp: arbTimestamp,
        path: arbPath,
        key: fc.option(arbKey, { nil: undefined }),
        value: arbValue,
      });

    /**
     * Arbitrary for generating an ErrorEvent with a specific stage name.
     */
    const arbErrorEventForStage = (stageName: string): fc.Arbitrary<ErrorEvent> =>
      fc.record({
        stageName: fc.constant(stageName),
        pipelineId: arbPipelineId,
        timestamp: arbTimestamp,
        error: arbErrorMessage.map((msg) => new Error(msg)),
        operation: arbErrorOperation,
        path: fc.option(arbPath, { nil: undefined }),
        key: fc.option(arbKey, { nil: undefined }),
      });

    test('getEntriesForStage returns ONLY entries with matching stageName', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 5 }),
          arbPipelineId,
          fc.integer({ min: 1, max: 5 }),
          (stageNames, pipelineId, entriesPerStage) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - record multiple entries for each stage
            for (const stageName of stageNames) {
              for (let i = 0; i < entriesPerStage; i++) {
                // Record a write for each stage
                debugRecorder.onWrite({
                  stageName,
                  pipelineId,
                  timestamp: Date.now() + i,
                  path: ['test'],
                  key: `key_${i}`,
                  value: `value_${i}`,
                  operation: 'set',
                });
              }
            }

            // Assert - filtering by each stage should return ONLY that stage's entries
            for (const stageName of stageNames) {
              const stageEntries = debugRecorder.getEntriesForStage(stageName);

              // Should have exactly entriesPerStage entries
              expect(stageEntries).toHaveLength(entriesPerStage);

              // ALL entries should have the matching stageName
              for (const entry of stageEntries) {
                expect(entry.stageName).toBe(stageName);
              }

              // No entries from other stages should be included
              const otherStages = stageNames.filter((s) => s !== stageName);
              for (const entry of stageEntries) {
                expect(otherStages).not.toContain(entry.stageName);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('entries from other stages are NOT included in filtered results', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 5 }),
          arbPipelineId,
          (stageNames, pipelineId) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
            const targetStage = stageNames[0];
            const otherStages = stageNames.slice(1);

            // Act - record entries for all stages
            for (const stageName of stageNames) {
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: Date.now(),
                path: ['test'],
                key: `key_${stageName}`,
                value: `value_${stageName}`,
                operation: 'set',
              });
            }

            // Assert - filtering by target stage should NOT include other stages
            const targetEntries = debugRecorder.getEntriesForStage(targetStage);

            // Should have exactly 1 entry (the one we recorded for target stage)
            expect(targetEntries).toHaveLength(1);
            expect(targetEntries[0].stageName).toBe(targetStage);

            // Verify no entries from other stages are included
            for (const entry of targetEntries) {
              for (const otherStage of otherStages) {
                expect(entry.stageName).not.toBe(otherStage);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stage filtering works correctly with mixed operations (reads, writes, errors)', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 4 }),
          arbPipelineId,
          (stageNames, pipelineId) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Track expected counts per stage
            const expectedCounts = new Map<string, { reads: number; writes: number; errors: number }>();

            // Act - record mixed operations for each stage
            for (const stageName of stageNames) {
              const counts = { reads: 0, writes: 0, errors: 0 };

              // Record a read
              debugRecorder.onRead({
                stageName,
                pipelineId,
                timestamp: Date.now(),
                path: ['test'],
                key: 'readKey',
                value: 'readValue',
              });
              counts.reads++;

              // Record a write (set)
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: Date.now() + 1,
                path: ['test'],
                key: 'writeKey',
                value: 'writeValue',
                operation: 'set',
              });
              counts.writes++;

              // Record a write (update)
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: Date.now() + 2,
                path: ['test'],
                key: 'updateKey',
                value: 'updateValue',
                operation: 'update',
              });
              counts.writes++;

              // Record an error
              debugRecorder.onError({
                stageName,
                pipelineId,
                timestamp: Date.now() + 3,
                error: new Error(`Error in ${stageName}`),
                operation: 'read',
              });
              counts.errors++;

              expectedCounts.set(stageName, counts);
            }

            // Assert - filtering by each stage should return correct mixed entries
            for (const stageName of stageNames) {
              const stageEntries = debugRecorder.getEntriesForStage(stageName);
              const expected = expectedCounts.get(stageName)!;

              // Total entries should match expected
              const expectedTotal = expected.reads + expected.writes + expected.errors;
              expect(stageEntries).toHaveLength(expectedTotal);

              // All entries should have matching stageName
              for (const entry of stageEntries) {
                expect(entry.stageName).toBe(stageName);
              }

              // Verify counts by type
              const actualReads = stageEntries.filter((e) => e.type === 'read').length;
              const actualWrites = stageEntries.filter((e) => e.type === 'write').length;
              const actualErrors = stageEntries.filter((e) => e.type === 'error').length;

              expect(actualReads).toBe(expected.reads);
              expect(actualWrites).toBe(expected.writes);
              expect(actualErrors).toBe(expected.errors);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('filtering non-existent stage returns empty array', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 5 }),
          arbStageName,
          arbPipelineId,
          (existingStages, nonExistentStage, pipelineId) => {
            // Skip if nonExistentStage happens to be in existingStages
            fc.pre(!existingStages.includes(nonExistentStage));

            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - record entries for existing stages only
            for (const stageName of existingStages) {
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: Date.now(),
                path: ['test'],
                key: 'key',
                value: 'value',
                operation: 'set',
              });
            }

            // Assert - filtering by non-existent stage should return empty array
            const nonExistentEntries = debugRecorder.getEntriesForStage(nonExistentStage);
            expect(nonExistentEntries).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stage filtering preserves entry order within stage', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbPipelineId,
          fc.array(arbValue, { minLength: 2, maxLength: 10 }),
          (stageName, pipelineId, values) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

            // Act - record entries with incrementing timestamps
            for (let i = 0; i < values.length; i++) {
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: 1000 + i, // Incrementing timestamps
                path: ['test'],
                key: `key_${i}`,
                value: values[i],
                operation: 'set',
              });
            }

            // Assert - entries should be in the same order as recorded
            const stageEntries = debugRecorder.getEntriesForStage(stageName);
            expect(stageEntries).toHaveLength(values.length);

            for (let i = 0; i < values.length; i++) {
              expect(stageEntries[i].timestamp).toBe(1000 + i);
              expect((stageEntries[i].data as { key: string }).key).toBe(`key_${i}`);
              expect((stageEntries[i].data as { value: unknown }).value).toEqual(values[i]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stage filtering works with interleaved entries from multiple stages', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 4 }),
          arbPipelineId,
          fc.integer({ min: 2, max: 5 }),
          (stageNames, pipelineId, roundsPerStage) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
            const entriesPerStage = new Map<string, number>();

            // Initialize counts
            for (const stageName of stageNames) {
              entriesPerStage.set(stageName, 0);
            }

            // Act - interleave entries from different stages
            let timestamp = 1000;
            for (let round = 0; round < roundsPerStage; round++) {
              for (const stageName of stageNames) {
                debugRecorder.onWrite({
                  stageName,
                  pipelineId,
                  timestamp: timestamp++,
                  path: ['test'],
                  key: `key_${round}`,
                  value: `value_${round}`,
                  operation: 'set',
                });
                entriesPerStage.set(stageName, entriesPerStage.get(stageName)! + 1);
              }
            }

            // Assert - each stage should have correct entries despite interleaving
            for (const stageName of stageNames) {
              const stageEntries = debugRecorder.getEntriesForStage(stageName);
              const expectedCount = entriesPerStage.get(stageName)!;

              expect(stageEntries).toHaveLength(expectedCount);

              // All entries should belong to this stage
              for (const entry of stageEntries) {
                expect(entry.stageName).toBe(stageName);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stage filtering returns independent copy of entries', () => {
      fc.assert(
        fc.property(arbStageName, arbPipelineId, (stageName, pipelineId) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          debugRecorder.onWrite({
            stageName,
            pipelineId,
            timestamp: Date.now(),
            path: ['test'],
            key: 'key',
            value: 'value',
            operation: 'set',
          });

          // Act - get entries twice
          const entries1 = debugRecorder.getEntriesForStage(stageName);
          const entries2 = debugRecorder.getEntriesForStage(stageName);

          // Assert - should be equal but not the same array reference
          expect(entries1).toEqual(entries2);
          expect(entries1).not.toBe(entries2);
        }),
        { numRuns: 100 }
      );
    });

    test('stage filtering works correctly after clear and re-recording', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 3 }),
          arbPipelineId,
          (stageNames, pipelineId) => {
            // Arrange
            const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
            const targetStage = stageNames[0];

            // Act - record entries, clear, then record again
            for (const stageName of stageNames) {
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: Date.now(),
                path: ['test'],
                key: 'beforeClear',
                value: 'beforeClear',
                operation: 'set',
              });
            }

            // Clear all entries
            debugRecorder.clear();

            // Record new entries
            for (const stageName of stageNames) {
              debugRecorder.onWrite({
                stageName,
                pipelineId,
                timestamp: Date.now(),
                path: ['test'],
                key: 'afterClear',
                value: 'afterClear',
                operation: 'set',
              });
            }

            // Assert - should only see entries recorded after clear
            const targetEntries = debugRecorder.getEntriesForStage(targetStage);
            expect(targetEntries).toHaveLength(1);
            expect((targetEntries[0].data as { key: string }).key).toBe('afterClear');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stage filtering includes all entry types for the stage', () => {
      fc.assert(
        fc.property(arbStageName, arbPipelineId, (stageName, pipelineId) => {
          // Arrange
          const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });

          // Act - record all types of entries for the same stage
          debugRecorder.onRead({
            stageName,
            pipelineId,
            timestamp: 1000,
            path: ['test'],
            key: 'readKey',
            value: 'readValue',
          });

          debugRecorder.onWrite({
            stageName,
            pipelineId,
            timestamp: 1001,
            path: ['test'],
            key: 'writeKey',
            value: 'writeValue',
            operation: 'set',
          });

          debugRecorder.onError({
            stageName,
            pipelineId,
            timestamp: 1002,
            error: new Error('test error'),
            operation: 'read',
          });

          debugRecorder.onStageStart({
            stageName,
            pipelineId,
            timestamp: 1003,
          });

          debugRecorder.onStageEnd({
            stageName,
            pipelineId,
            timestamp: 1004,
            duration: 100,
          });

          // Assert - all entry types should be included
          const stageEntries = debugRecorder.getEntriesForStage(stageName);
          expect(stageEntries).toHaveLength(5);

          const entryTypes = stageEntries.map((e) => e.type);
          expect(entryTypes).toContain('read');
          expect(entryTypes).toContain('write');
          expect(entryTypes).toContain('error');
          expect(entryTypes).toContain('stageStart');
          expect(entryTypes).toContain('stageEnd');
        }),
        { numRuns: 100 }
      );
    });
  });
});
