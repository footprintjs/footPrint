/**
 * Property-based tests for Scope class
 *
 * These tests verify universal properties that should hold across all valid inputs.
 *
 * Feature: scope-recorder-pattern
 */

import * as fc from 'fast-check';
import { GlobalStore } from '../../src/core/memory/GlobalStore';
import { Scope } from '../../src/scope/Scope';
import type { Recorder } from '../../src/scope/types';

// ============================================================================
// Arbitraries (Generators)
// ============================================================================

/**
 * Reserved JavaScript property names that should not be used as keys.
 * These can cause issues when used as object property names.
 */
const RESERVED_PROPERTY_NAMES = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'constructor',
  '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
  'caller', 'callee', 'arguments',
]);

/**
 * Arbitrary for valid path segments (non-empty strings without special chars).
 * Paths are arrays of strings used to namespace values in the scope.
 * Excludes reserved JavaScript property names to avoid prototype issues.
 */
const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
  .filter(s => !RESERVED_PROPERTY_NAMES.has(s));

/**
 * Arbitrary for valid paths (arrays of path segments).
 * Paths should have at least one segment.
 */
const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

/**
 * Arbitrary for valid keys (non-empty strings).
 * Excludes reserved JavaScript property names to avoid prototype issues.
 */
const arbKey = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
  .filter(s => !RESERVED_PROPERTY_NAMES.has(s))
  .filter(s => !RESERVED_PROPERTY_NAMES.has(s));

/**
 * Arbitrary for JSON-serializable primitive values.
 */
const arbPrimitive = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null)
);

/**
 * Arbitrary for JSON-serializable values (primitives, arrays, objects).
 * Limited depth to avoid extremely deep structures.
 */
const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
  primitive: arbPrimitive,
  array: fc.array(tie('value'), { maxLength: 5 }),
  object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
  value: fc.oneof(
    { weight: 3, arbitrary: tie('primitive') },
    { weight: 1, arbitrary: tie('array') },
    { weight: 1, arbitrary: tie('object') }
  )
})).value;

/**
 * Arbitrary for pipeline IDs.
 */
const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/**
 * Arbitrary for stage names.
 */
const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

// ============================================================================
// Property Tests
// ============================================================================

describe('Scope Property Tests', () => {
  describe('Property 1: Read-After-Write Consistency', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 1: Read-After-Write Consistency
     * **Validates: Requirements 1.1, 1.2, 1.5**
     *
     * For any Scope instance, key, and value, if setValue is called with
     * that value, an immediate getValue with the same path and key SHALL return
     * that exact value.
     */
    test('setValue followed by getValue returns exact value (before commit)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act
            scope.setValue(key, value);
            const retrievedValue = scope.getValue(key);

            // Assert - value should be immediately available before commit
            expect(retrievedValue).toEqual(value);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Feature: scope-recorder-pattern
     * Property 1: Read-After-Write Consistency
     * **Validates: Requirements 1.1, 1.2, 1.5**
     *
     * After commit, the value should still be retrievable with the same semantics.
     */
    test('setValue followed by commit and getValue returns exact value', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act
            scope.setValue(key, value);
            scope.commit();
            const retrievedValue = scope.getValue(key);

            // Assert - value should be available after commit
            expect(retrievedValue).toEqual(value);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Feature: scope-recorder-pattern
     * Property 1: Read-After-Write Consistency
     * **Validates: Requirements 1.1, 1.2, 1.5**
     *
     * Multiple writes to the same path/key should result in the last value being read.
     */
    test('multiple setValue calls return the last written value', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          fc.array(arbJsonValue, { minLength: 2, maxLength: 5 }),
          (pipelineId, stageName, key, values) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - write multiple values to the same path/key
            for (const value of values) {
              scope.setValue(key, value);
            }
            const retrievedValue = scope.getValue(key);

            // Assert - should return the last written value
            const lastValue = values[values.length - 1];
            expect(retrievedValue).toEqual(lastValue);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Feature: scope-recorder-pattern
     * Property 1: Read-After-Write Consistency
     * **Validates: Requirements 1.1, 1.2, 1.5**
     *
     * Values written to different keys should be independently retrievable.
     */
    test('writes to different keys are independently retrievable', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.uniqueArray(arbKey, { minLength: 2, maxLength: 5 }),
          fc.array(arbJsonValue, { minLength: 2, maxLength: 5 }),
          (pipelineId, stageName, keys, values) => {
            // Ensure we have matching keys and values
            const pairs = keys.slice(0, Math.min(keys.length, values.length))
              .map((key, i) => ({ key, value: values[i] }));

            if (pairs.length < 2) return; // Skip if not enough unique keys

            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - write different values to different keys
            for (const { key, value } of pairs) {
              scope.setValue(key, value);
            }

            // Assert - each key should return its own value
            for (const { key, value } of pairs) {
              const retrievedValue = scope.getValue(key);
              expect(retrievedValue).toEqual(value);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Feature: scope-recorder-pattern
     * Property 1: Read-After-Write Consistency
     * **Validates: Requirements 1.1, 1.2, 1.5**
     *
     * After commit, a new Scope instance with the same pipelineId should be able
     * to read the committed value from GlobalStore.
     */
    test('committed values are readable from a new Scope instance', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          (pipelineId, stageName, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope1 = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - write and commit with first scope
            scope1.setValue(key, value);
            scope1.commit();

            // Create a new scope with the same pipelineId
            const scope2 = new Scope({
              pipelineId,
              stageName: 'another-stage',
              globalStore,
            });

            const retrievedValue = scope2.getValue(key);

            // Assert - new scope should read the committed value
            expect(retrievedValue).toEqual(value);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: Deep Merge Semantics', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 2: Deep Merge Semantics
     * **Validates: Requirements 1.3**
     *
     * For any Scope instance with an existing object at a path/key, and any update
     * object, calling updateValue SHALL result in a deep merge where nested properties
     * from both objects are preserved, with update values taking precedence for conflicts.
     */

    /**
     * Arbitrary for nested objects with controlled depth.
     * Generates objects with string keys and primitive or nested object values.
     */
    const arbNestedObject: fc.Arbitrary<Record<string, unknown>> = fc.letrec(tie => ({
      leaf: fc.oneof(
        fc.string(),
        fc.integer(),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.boolean()
      ),
      nested: fc.dictionary(
        arbKey,
        fc.oneof(
          { weight: 3, arbitrary: tie('leaf') },
          { weight: 1, arbitrary: tie('nested') }
        ),
        { minKeys: 1, maxKeys: 4 }
      )
    })).nested;

    /**
     * Arbitrary for arrays of primitives (for array union testing).
     */
    const arbPrimitiveArray = fc.array(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.integer({ min: -1000, max: 1000 })
      ),
      { minLength: 1, maxLength: 10 }
    );

    test('updateValue preserves nested properties from both objects', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbNestedObject,
          arbNestedObject,
          (pipelineId, stageName, key, existingObj, updateObj) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - set initial value, then update with new object
            scope.setValue(key, existingObj);
            scope.updateValue(key, updateObj);
            const result = scope.getValue(key) as Record<string, unknown>;

            // Assert - all keys from existing object should be present (unless overwritten)
            // and all keys from update object should be present
            for (const existingKey of Object.keys(existingObj)) {
              if (!(existingKey in updateObj)) {
                // Key only in existing - should be preserved
                expect(result).toHaveProperty(existingKey);
                expect(result[existingKey]).toEqual(existingObj[existingKey]);
              }
            }

            for (const updateKey of Object.keys(updateObj)) {
              // All keys from update should be present
              expect(result).toHaveProperty(updateKey);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue gives precedence to update values for conflicts', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbKey, // shared key that will conflict
          arbPrimitive,
          arbPrimitive,
          (pipelineId, stageName, key, sharedKey, existingValue, updateValue) => {
            // Skip if values are the same (no conflict to test)
            fc.pre(existingValue !== updateValue);

            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            const existingObj = { [sharedKey]: existingValue };
            const updateObj = { [sharedKey]: updateValue };

            // Act
            scope.setValue(key, existingObj);
            scope.updateValue(key, updateObj);
            const result = scope.getValue(key) as Record<string, unknown>;

            // Assert - update value should take precedence
            expect(result[sharedKey]).toEqual(updateValue);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue unions arrays without duplicates', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbPrimitiveArray,
          arbPrimitiveArray,
          (pipelineId, stageName, key, existingArray, updateArray) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act
            scope.setValue(key, existingArray);
            scope.updateValue(key, updateArray);
            const result = scope.getValue(key) as unknown[];

            // Assert - result should be an array
            expect(Array.isArray(result)).toBe(true);

            // Assert - all unique elements from both arrays should be present
            const expectedUnique = [...new Set([...existingArray, ...updateArray])];
            expect(result.length).toBe(expectedUnique.length);

            // Assert - no duplicates in result
            const resultSet = new Set(result);
            expect(resultSet.size).toBe(result.length);

            // Assert - all elements from existing array should be in result
            for (const elem of existingArray) {
              expect(result).toContain(elem);
            }

            // Assert - all elements from update array should be in result
            for (const elem of updateArray) {
              expect(result).toContain(elem);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue preserves encounter order for array union', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbPrimitiveArray,
          arbPrimitiveArray,
          (pipelineId, stageName, key, existingArray, updateArray) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act
            scope.setValue(key, existingArray);
            scope.updateValue(key, updateArray);
            const result = scope.getValue(key) as unknown[];

            // Assert - elements from existing array should appear before new elements from update
            // (encounter order preserved means existing elements come first)
            const existingSet = new Set(existingArray);
            const newFromUpdate = updateArray.filter(elem => !existingSet.has(elem));

            // Find indices of elements that were only in existing array
            const existingOnlyElements = existingArray.filter(elem => !updateArray.includes(elem));
            const newFromUpdateElements = newFromUpdate;

            // If there are elements only in existing and new elements from update,
            // existing-only elements should appear before new-from-update elements
            if (existingOnlyElements.length > 0 && newFromUpdateElements.length > 0) {
              const lastExistingOnlyIndex = Math.max(
                ...existingOnlyElements.map(elem => result.indexOf(elem))
              );
              const firstNewFromUpdateIndex = Math.min(
                ...newFromUpdateElements.map(elem => result.indexOf(elem))
              );
              expect(lastExistingOnlyIndex).toBeLessThan(firstNewFromUpdateIndex);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue performs recursive deep merge on nested objects', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbKey, // nested key
          arbKey, // leaf key 1
          arbKey, // leaf key 2
          arbPrimitive,
          arbPrimitive,
          (pipelineId, stageName, key, nestedKey, leafKey1, leafKey2, value1, value2) => {
            // Skip if leaf keys are the same
            fc.pre(leafKey1 !== leafKey2);

            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Create nested objects with different leaf keys
            const existingObj = {
              [nestedKey]: {
                [leafKey1]: value1,
              },
            };
            const updateObj = {
              [nestedKey]: {
                [leafKey2]: value2,
              },
            };

            // Act
            scope.setValue(key, existingObj);
            scope.updateValue(key, updateObj);
            const result = scope.getValue(key) as Record<string, Record<string, unknown>>;

            // Assert - both leaf keys should be present in the nested object
            expect(result[nestedKey]).toHaveProperty(leafKey1);
            expect(result[nestedKey]).toHaveProperty(leafKey2);
            expect(result[nestedKey][leafKey1]).toEqual(value1);
            expect(result[nestedKey][leafKey2]).toEqual(value2);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue with primitive overwrites existing primitive', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbPrimitive,
          arbPrimitive,
          (pipelineId, stageName, key, existingValue, updateValue) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - set primitive, then update with another primitive
            scope.setValue(key, existingValue);
            scope.updateValue(key, updateValue);
            const result = scope.getValue(key);

            // Assert - update value should completely replace existing
            expect(result).toEqual(updateValue);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple updateValue calls accumulate merged properties', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          fc.uniqueArray(arbKey, { minLength: 3, maxLength: 5 }),
          fc.array(arbPrimitive, { minLength: 3, maxLength: 5 }),
          (pipelineId, stageName, key, uniqueKeys, values) => {
            // Ensure we have enough unique keys
            fc.pre(uniqueKeys.length >= 3);

            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Create multiple update objects with different keys
            const updates = uniqueKeys.slice(0, 3).map((k, i) => ({
              [k]: values[i % values.length],
            }));

            // Act - apply multiple updates
            for (const update of updates) {
              scope.updateValue(key, update);
            }
            const result = scope.getValue(key) as Record<string, unknown>;

            // Assert - all keys from all updates should be present
            for (let i = 0; i < 3; i++) {
              const updateKey = uniqueKeys[i];
              expect(result).toHaveProperty(updateKey);
              expect(result[updateKey]).toEqual(values[i % values.length]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('deep merge semantics persist after commit', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbKey,
          arbNestedObject,
          arbNestedObject,
          (pipelineId, stageName, key, existingObj, updateObj) => {
            // Arrange
            const globalStore = new GlobalStore();
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
            });

            // Act - set, update, then commit
            scope.setValue(key, existingObj);
            scope.updateValue(key, updateObj);
            const beforeCommit = scope.getValue(key) as Record<string, unknown>;
            scope.commit();
            const afterCommit = scope.getValue(key) as Record<string, unknown>;

            // Assert - value should be the same before and after commit
            expect(afterCommit).toEqual(beforeCommit);

            // Assert - merged properties should persist
            for (const existingKey of Object.keys(existingObj)) {
              if (!(existingKey in updateObj)) {
                expect(afterCommit).toHaveProperty(existingKey);
              }
            }
            for (const updateKey of Object.keys(updateObj)) {
              expect(afterCommit).toHaveProperty(updateKey);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


  describe('Property 3: Namespace Isolation', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 3: Namespace Isolation
     * **Validates: Requirements 1.6**
     *
     * For any two Scope instances with different pipelineIds, writes to one
     * namespace SHALL NOT affect reads from the other namespace.
     */

    test('writes to one namespace do not affect reads from another namespace (before commit)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          (pipelineId1, pipelineId2, stageName, key, value) => {
            // Ensure different namespaces
            fc.pre(pipelineId1 !== pipelineId2);

            // Arrange - shared GlobalStore, different pipelineIds
            const globalStore = new GlobalStore();
            const scope1 = new Scope({
              pipelineId: pipelineId1,
              stageName,
              globalStore,
            });
            const scope2 = new Scope({
              pipelineId: pipelineId2,
              stageName,
              globalStore,
            });

            // Act - write to scope1
            scope1.setValue(key, value);

            // Assert - scope2 should not see scope1's uncommitted value
            expect(scope2.getValue(key)).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    test('writes to one namespace do not affect reads from another namespace (after commit)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          (pipelineId1, pipelineId2, stageName, key, value) => {
            // Ensure different namespaces
            fc.pre(pipelineId1 !== pipelineId2);

            // Arrange - shared GlobalStore, different pipelineIds
            const globalStore = new GlobalStore();
            const scope1 = new Scope({
              pipelineId: pipelineId1,
              stageName,
              globalStore,
            });
            const scope2 = new Scope({
              pipelineId: pipelineId2,
              stageName,
              globalStore,
            });

            // Act - write and commit to scope1
            scope1.setValue(key, value);
            scope1.commit();

            // Assert - scope2 should not see scope1's committed value
            expect(scope2.getValue(key)).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    test('each namespace maintains independent state', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          arbJsonValue,
          (pipelineId1, pipelineId2, stageName, key, value1, value2) => {
            // Ensure different namespaces and different values
            fc.pre(pipelineId1 !== pipelineId2);

            // Arrange - shared GlobalStore, different pipelineIds
            const globalStore = new GlobalStore();
            const scope1 = new Scope({
              pipelineId: pipelineId1,
              stageName,
              globalStore,
            });
            const scope2 = new Scope({
              pipelineId: pipelineId2,
              stageName,
              globalStore,
            });

            // Act - write different values to same path/key in each namespace
            scope1.setValue(key, value1);
            scope2.setValue(key, value2);
            scope1.commit();
            scope2.commit();

            // Assert - each scope should see its own value
            expect(scope1.getValue(key)).toEqual(value1);
            expect(scope2.getValue(key)).toEqual(value2);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue in one namespace does not affect another namespace', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbPipelineId,
          arbStageName,
          arbKey,
          fc.dictionary(arbKey, arbPrimitive, { minKeys: 1, maxKeys: 3 }),
          fc.dictionary(arbKey, arbPrimitive, { minKeys: 1, maxKeys: 3 }),
          (pipelineId1, pipelineId2, stageName, key, obj1, obj2) => {
            // Ensure different namespaces
            fc.pre(pipelineId1 !== pipelineId2);

            // Arrange - shared GlobalStore, different pipelineIds
            const globalStore = new GlobalStore();
            const scope1 = new Scope({
              pipelineId: pipelineId1,
              stageName,
              globalStore,
            });
            const scope2 = new Scope({
              pipelineId: pipelineId2,
              stageName,
              globalStore,
            });

            // Act - set initial values and update in scope1
            scope1.setValue(key, obj1);
            scope2.setValue(key, obj2);
            scope1.commit();
            scope2.commit();

            // Update scope1 with additional properties
            const updateObj = { additionalProp: 'updated' };
            scope1.updateValue(key, updateObj);
            scope1.commit();

            // Assert - scope2 should not see scope1's update
            const scope2Value = scope2.getValue(key) as Record<string, unknown>;
            expect(scope2Value).toEqual(obj2);
            expect(scope2Value).not.toHaveProperty('additionalProp');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple namespaces can coexist with same paths and keys', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(arbPipelineId, { minLength: 3, maxLength: 5 }),
          arbStageName,
          arbKey,
          fc.array(arbJsonValue, { minLength: 3, maxLength: 5 }),
          (pipelineIds, stageName, key, values) => {
            // Ensure we have enough unique pipelineIds
            fc.pre(pipelineIds.length >= 3);

            // Arrange - shared GlobalStore, multiple pipelineIds
            const globalStore = new GlobalStore();
            const scopes = pipelineIds.slice(0, 3).map(
              (pipelineId) =>
                new Scope({
                  pipelineId,
                  stageName,
                  globalStore,
                })
            );

            // Act - write different values to same path/key in each namespace
            scopes.forEach((scope, i) => {
              scope.setValue(key, values[i % values.length]);
              scope.commit();
            });

            // Assert - each scope should see only its own value
            scopes.forEach((scope, i) => {
              const retrievedValue = scope.getValue(key);
              expect(retrievedValue).toEqual(values[i % values.length]);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    test('new scope instance with same pipelineId sees committed values', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbPipelineId,
          arbStageName,
          arbKey,
          arbJsonValue,
          (pipelineId1, pipelineId2, stageName, key, value) => {
            // Ensure different namespaces
            fc.pre(pipelineId1 !== pipelineId2);

            // Arrange - shared GlobalStore
            const globalStore = new GlobalStore();
            const scope1 = new Scope({
              pipelineId: pipelineId1,
              stageName,
              globalStore,
            });

            // Act - write and commit to scope1
            scope1.setValue(key, value);
            scope1.commit();

            // Create new scope instances
            const scope1New = new Scope({
              pipelineId: pipelineId1,
              stageName: 'new-stage',
              globalStore,
            });
            const scope2New = new Scope({
              pipelineId: pipelineId2,
              stageName: 'new-stage',
              globalStore,
            });

            // Assert - new scope with same pipelineId should see the value
            expect(scope1New.getValue(key)).toEqual(value);
            // Assert - new scope with different pipelineId should not see the value
            expect(scope2New.getValue(key)).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
  });


// Properties 4-7 (History Growth, Time-Travel Retrieval, Time-Travel Immutability,
// Snapshot Metadata) were removed as part of consolidating Scope's duplicate
// time-travel system. Use ExecutionHistory for time-travel instead.

describe('Property 8: Recorder Hook Invocation', () => {
  /**
   * Feature: scope-recorder-pattern
   * Property 8: Recorder Hook Invocation
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**
   *
   * For any Scope with an attached Recorder, each scope operation (getValue,
   * setValue, updateValue, commit, startStage, endStage) SHALL invoke the
   * corresponding Recorder hook (onRead, onWrite, onWrite, onCommit,
   * onStageStart, onStageEnd) exactly once.
   */

  /**
   * Reserved JavaScript property names that cannot be used as path segments.
   * These cause errors when used with lodash.get on certain objects.
   */
  const RESERVED_NAMES = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    'caller', 'callee', 'arguments', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  ]);

  /**
   * Arbitrary for valid path segments (non-empty strings without special chars).
   * Excludes reserved JavaScript property names that cause issues with lodash.get.
   */
  const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !RESERVED_NAMES.has(s));

  /**
   * Arbitrary for valid paths (arrays of path segments).
   */
  const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

  /**
   * Arbitrary for valid keys (non-empty strings).
   */
  const arbKey = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

  /**
   * Arbitrary for pipeline IDs.
   */
  const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for stage names.
   */
  const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for JSON-serializable primitive values.
   */
  const arbPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  );

  /**
   * Arbitrary for JSON-serializable values (primitives, arrays, objects).
   */
  const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    primitive: arbPrimitive,
    array: fc.array(tie('value'), { maxLength: 5 }),
    object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
    value: fc.oneof(
      { weight: 3, arbitrary: tie('primitive') },
      { weight: 1, arbitrary: tie('array') },
      { weight: 1, arbitrary: tie('object') }
    )
  })).value;

  /**
   * Arbitrary for operation types that can be performed on a scope.
   */
  type OperationType = 'read' | 'setValue' | 'updateValue' | 'commit' | 'startStage' | 'endStage';
  const arbOperationType: fc.Arbitrary<OperationType> = fc.constantFrom(
    'read', 'setValue', 'updateValue', 'commit', 'startStage', 'endStage'
  );

  /**
   * Creates a mock recorder that tracks all hook invocations.
   */
  interface HookInvocation {
    hook: string;
    event: unknown;
    timestamp: number;
  }

  function createMockRecorder(id: string): {
    recorder: Recorder;
    invocations: HookInvocation[];
  } {
    const invocations: HookInvocation[] = [];

    const recorder: Recorder = {
      id,
      onRead(event) {
        invocations.push({ hook: 'onRead', event, timestamp: Date.now() });
      },
      onWrite(event) {
        invocations.push({ hook: 'onWrite', event, timestamp: Date.now() });
      },
      onCommit(event) {
        invocations.push({ hook: 'onCommit', event, timestamp: Date.now() });
      },
      onError(event) {
        invocations.push({ hook: 'onError', event, timestamp: Date.now() });
      },
      onStageStart(event) {
        invocations.push({ hook: 'onStageStart', event, timestamp: Date.now() });
      },
      onStageEnd(event) {
        invocations.push({ hook: 'onStageEnd', event, timestamp: Date.now() });
      },
    };

    return { recorder, invocations };
  }

  test('getValue invokes onRead hook exactly once', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        (pipelineId, stageName, key) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act
          scope.getValue(key);

          // Assert - onRead should be invoked exactly once
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(1);

          // Verify event data
          const event = readInvocations[0].event as { key?: string; stageName: string; pipelineId: string };
          expect(event.key).toBe(key);
          expect(event.stageName).toBe(stageName);
          expect(event.pipelineId).toBe(pipelineId);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('setValue invokes onWrite hook exactly once with operation "set"', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act
          scope.setValue(key, value);

          // Assert - onWrite should be invoked exactly once
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(1);

          // Verify event data
          const event = writeInvocations[0].event as {
            key: string;
            value: unknown;
            operation: string;
            stageName: string;
            pipelineId: string;
          };
          expect(event.key).toBe(key);
          expect(event.value).toEqual(value);
          expect(event.operation).toBe('set');
          expect(event.stageName).toBe(stageName);
          expect(event.pipelineId).toBe(pipelineId);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('updateValue invokes onWrite hook exactly once with operation "update"', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act
          scope.updateValue(key, value);

          // Assert - onWrite should be invoked exactly once
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(1);

          // Verify event data
          const event = writeInvocations[0].event as {
            key: string;
            value: unknown;
            operation: string;
            stageName: string;
            pipelineId: string;
          };
          expect(event.key).toBe(key);
          expect(event.value).toEqual(value);
          expect(event.operation).toBe('update');
          expect(event.stageName).toBe(stageName);
          expect(event.pipelineId).toBe(pipelineId);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('commit invokes onCommit hook exactly once', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Stage a write first
          scope.setValue(key, value);

          // Clear invocations to isolate commit behavior
          invocations.length = 0;

          // Act
          scope.commit();

          // Assert - onCommit should be invoked exactly once
          const commitInvocations = invocations.filter(i => i.hook === 'onCommit');
          expect(commitInvocations.length).toBe(1);

          // Verify event data
          const event = commitInvocations[0].event as {
            mutations: Array<{ key: string; value: unknown; operation: string }>;
            stageName: string;
            pipelineId: string;
          };
          expect(event.stageName).toBe(stageName);
          expect(event.pipelineId).toBe(pipelineId);
          expect(event.mutations).toBeDefined();
          expect(Array.isArray(event.mutations)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('startStage invokes onStageStart hook exactly once', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        (pipelineId, initialStageName, newStageName) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName: initialStageName,
            globalStore,
            recorders: [recorder],
          });

          // Act
          scope.startStage(newStageName);

          // Assert - onStageStart should be invoked exactly once
          const stageStartInvocations = invocations.filter(i => i.hook === 'onStageStart');
          expect(stageStartInvocations.length).toBe(1);

          // Verify event data
          const event = stageStartInvocations[0].event as {
            stageName: string;
            pipelineId: string;
            timestamp: number;
          };
          expect(event.stageName).toBe(newStageName);
          expect(event.pipelineId).toBe(pipelineId);
          expect(typeof event.timestamp).toBe('number');
          expect(event.timestamp).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('endStage invokes onStageEnd hook exactly once', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        (pipelineId, stageName) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Start stage first to have a valid start time
          scope.startStage(stageName);

          // Clear invocations to isolate endStage behavior
          invocations.length = 0;

          // Act
          scope.endStage();

          // Assert - onStageEnd should be invoked exactly once
          const stageEndInvocations = invocations.filter(i => i.hook === 'onStageEnd');
          expect(stageEndInvocations.length).toBe(1);

          // Verify event data
          const event = stageEndInvocations[0].event as {
            stageName: string;
            pipelineId: string;
            timestamp: number;
            duration?: number;
          };
          expect(event.stageName).toBe(stageName);
          expect(event.pipelineId).toBe(pipelineId);
          expect(typeof event.timestamp).toBe('number');
          expect(event.timestamp).toBeGreaterThan(0);
          // Duration should be present since we called startStage first
          expect(typeof event.duration).toBe('number');
          expect(event.duration).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('multiple operations invoke corresponding hooks in order', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform a sequence of operations
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - hooks should be invoked in order
          const hookSequence = invocations.map(i => i.hook);
          expect(hookSequence).toEqual([
            'onStageStart',
            'onRead',
            'onWrite',
            'onWrite',
            'onCommit',
            'onStageEnd',
          ]);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('each operation type invokes exactly one corresponding hook', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        fc.array(arbOperationType, { minLength: 1, maxLength: 10 }),
        (pipelineId, stageName, key, value, operations) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Track expected hook counts
          const expectedCounts: Record<string, number> = {
            onRead: 0,
            onWrite: 0,
            onCommit: 0,
            onStageStart: 0,
            onStageEnd: 0,
          };

          // Act - perform each operation and track expected hooks
          for (const op of operations) {
            switch (op) {
              case 'read':
                scope.getValue(key);
                expectedCounts.onRead++;
                break;
              case 'setValue':
                scope.setValue(key, value);
                expectedCounts.onWrite++;
                break;
              case 'updateValue':
                scope.updateValue(key, value);
                expectedCounts.onWrite++;
                break;
              case 'commit':
                scope.commit();
                expectedCounts.onCommit++;
                break;
              case 'startStage':
                scope.startStage(stageName);
                expectedCounts.onStageStart++;
                break;
              case 'endStage':
                scope.endStage();
                expectedCounts.onStageEnd++;
                break;
            }
          }

          // Assert - actual hook counts match expected
          const actualCounts: Record<string, number> = {
            onRead: invocations.filter(i => i.hook === 'onRead').length,
            onWrite: invocations.filter(i => i.hook === 'onWrite').length,
            onCommit: invocations.filter(i => i.hook === 'onCommit').length,
            onStageStart: invocations.filter(i => i.hook === 'onStageStart').length,
            onStageEnd: invocations.filter(i => i.hook === 'onStageEnd').length,
          };

          expect(actualCounts).toEqual(expectedCounts);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('commit event contains all staged mutations', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        fc.array(
          fc.record({
            key: arbKey,
            value: arbPrimitive,
            operation: fc.constantFrom('set', 'update') as fc.Arbitrary<'set' | 'update'>,
          }),
          { minLength: 1, maxLength: 5 }
        ),
        (pipelineId, stageName, writes) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all writes
          for (const write of writes) {
            if (write.operation === 'set') {
              scope.setValue(write.key, write.value);
            } else {
              scope.updateValue(write.key, write.value);
            }
          }

          // Clear invocations to isolate commit
          invocations.length = 0;

          // Commit
          scope.commit();

          // Assert - commit event contains all mutations
          const commitInvocations = invocations.filter(i => i.hook === 'onCommit');
          expect(commitInvocations.length).toBe(1);

          const event = commitInvocations[0].event as {
            mutations: Array<{ key: string; value: unknown; operation: string }>;
          };

          // Verify mutation count matches write count
          expect(event.mutations.length).toBe(writes.length);

          // Verify each mutation has correct data
          for (let i = 0; i < writes.length; i++) {
            expect(event.mutations[i].key).toBe(writes[i].key);
            expect(event.mutations[i].value).toEqual(writes[i].value);
            expect(event.mutations[i].operation).toBe(writes[i].operation);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('event timestamps are valid and monotonically non-decreasing', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Capture time before test
          const timeBefore = Date.now();

          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform operations
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.commit();
          scope.endStage();

          // Capture time after test
          const timeAfter = Date.now();

          // Assert - all event timestamps are within test window
          for (const invocation of invocations) {
            const event = invocation.event as { timestamp: number };
            expect(event.timestamp).toBeGreaterThanOrEqual(timeBefore);
            expect(event.timestamp).toBeLessThanOrEqual(timeAfter);
          }

          // Assert - timestamps are monotonically non-decreasing
          for (let i = 1; i < invocations.length; i++) {
            const prevEvent = invocations[i - 1].event as { timestamp: number };
            const currEvent = invocations[i].event as { timestamp: number };
            expect(currEvent.timestamp).toBeGreaterThanOrEqual(prevEvent.timestamp);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('read event contains the actual value read', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Set a value and commit
          scope.setValue(key, value);
          scope.commit();

          // Clear invocations
          invocations.length = 0;

          // Act - read the value
          const readValue = scope.getValue(key);

          // Assert - read event contains the actual value
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(1);

          const event = readInvocations[0].event as { value: unknown };
          expect(event.value).toEqual(readValue);
          expect(event.value).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('read event for non-existent key contains undefined value', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        (pipelineId, stageName, key) => {
          // Arrange
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createMockRecorder('test-recorder');
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - read a non-existent key
          const readValue = scope.getValue(key);

          // Assert - read event contains undefined
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(1);

          const event = readInvocations[0].event as { value: unknown };
          expect(event.value).toBeUndefined();
          expect(readValue).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});


describe('Property 9: Partial Recorder Graceful Handling', () => {
  /**
   * Feature: scope-recorder-pattern
   * Property 9: Partial Recorder Graceful Handling
   * **Validates: Requirements 3.7**
   *
   * For any Recorder with missing hook implementations, attaching it to Scope
   * and performing operations SHALL NOT throw errors—missing hooks SHALL be
   * silently skipped.
   */

  /**
   * Reserved JavaScript property names that cannot be used as path segments.
   */
  const RESERVED_NAMES = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    'caller', 'callee', 'arguments', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  ]);

  /**
   * Arbitrary for valid path segments (non-empty strings without special chars).
   */
  const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !RESERVED_NAMES.has(s));

  /**
   * Arbitrary for valid paths (arrays of path segments).
   */
  const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

  /**
   * Arbitrary for valid keys (non-empty strings).
   */
  const arbKey = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

  /**
   * Arbitrary for pipeline IDs.
   */
  const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for stage names.
   */
  const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for JSON-serializable primitive values.
   */
  const arbPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  );

  /**
   * Arbitrary for JSON-serializable values (primitives, arrays, objects).
   */
  const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    primitive: arbPrimitive,
    array: fc.array(tie('value'), { maxLength: 5 }),
    object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
    value: fc.oneof(
      { weight: 3, arbitrary: tie('primitive') },
      { weight: 1, arbitrary: tie('array') },
      { weight: 1, arbitrary: tie('object') }
    )
  })).value;

  /**
   * Hook names that can be implemented on a Recorder.
   */
  type HookName = 'onRead' | 'onWrite' | 'onCommit' | 'onError' | 'onStageStart' | 'onStageEnd';
  const ALL_HOOKS: HookName[] = ['onRead', 'onWrite', 'onCommit', 'onError', 'onStageStart', 'onStageEnd'];

  /**
   * Arbitrary for a subset of hooks to implement.
   * Generates a non-empty subset of hook names.
   */
  const arbHookSubset: fc.Arbitrary<HookName[]> = fc.subarray(ALL_HOOKS, { minLength: 0, maxLength: 5 });

  /**
   * Creates a partial recorder that only implements the specified hooks.
   * Returns the recorder and a tracking object for invocations.
   */
  function createPartialRecorder(
    id: string,
    implementedHooks: HookName[]
  ): {
    recorder: Recorder;
    invocations: Array<{ hook: string; event: unknown }>;
  } {
    const invocations: Array<{ hook: string; event: unknown }> = [];
    const hookSet = new Set(implementedHooks);

    // Start with just the id
    const recorder: Recorder = { id };

    // Only add hooks that are in the implemented set
    if (hookSet.has('onRead')) {
      recorder.onRead = (event) => {
        invocations.push({ hook: 'onRead', event });
      };
    }
    if (hookSet.has('onWrite')) {
      recorder.onWrite = (event) => {
        invocations.push({ hook: 'onWrite', event });
      };
    }
    if (hookSet.has('onCommit')) {
      recorder.onCommit = (event) => {
        invocations.push({ hook: 'onCommit', event });
      };
    }
    if (hookSet.has('onError')) {
      recorder.onError = (event) => {
        invocations.push({ hook: 'onError', event });
      };
    }
    if (hookSet.has('onStageStart')) {
      recorder.onStageStart = (event) => {
        invocations.push({ hook: 'onStageStart', event });
      };
    }
    if (hookSet.has('onStageEnd')) {
      recorder.onStageEnd = (event) => {
        invocations.push({ hook: 'onStageEnd', event });
      };
    }

    return { recorder, invocations };
  }

  test('partial recorder with only onRead hook completes all operations without error', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with only onRead
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('read-only-recorder', ['onRead']);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - only onRead should have been invoked
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(1);
          expect(invocations.length).toBe(1); // Only read invocations
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder with only onWrite hook completes all operations without error', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with only onWrite
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('write-only-recorder', ['onWrite']);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - only onWrite should have been invoked (twice: setValue + updateValue)
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(2);
          expect(invocations.length).toBe(2); // Only write invocations
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder with only onCommit hook completes all operations without error', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with only onCommit
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('commit-only-recorder', ['onCommit']);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - only onCommit should have been invoked
          const commitInvocations = invocations.filter(i => i.hook === 'onCommit');
          expect(commitInvocations.length).toBe(1);
          expect(invocations.length).toBe(1); // Only commit invocations
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder with only stage lifecycle hooks completes all operations without error', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with only onStageStart and onStageEnd
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('stage-only-recorder', ['onStageStart', 'onStageEnd']);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - only stage lifecycle hooks should have been invoked
          const stageStartInvocations = invocations.filter(i => i.hook === 'onStageStart');
          const stageEndInvocations = invocations.filter(i => i.hook === 'onStageEnd');
          expect(stageStartInvocations.length).toBe(1);
          expect(stageEndInvocations.length).toBe(1);
          expect(invocations.length).toBe(2); // Only stage lifecycle invocations
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder with only onError hook completes all operations without error', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with only onError
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('error-only-recorder', ['onError']);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - onError should not have been invoked (no errors occurred)
          expect(invocations.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('empty recorder (no hooks) completes all operations without error', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with no hooks at all
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('empty-recorder', []);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - no hooks should have been invoked
          expect(invocations.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder with arbitrary subset of hooks completes operations and invokes only implemented hooks', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbHookSubset,
        (pipelineId, stageName, key, value, implementedHooks) => {
          // Arrange - create recorder with arbitrary subset of hooks
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('partial-recorder', implementedHooks);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          const hookSet = new Set(implementedHooks);

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - only implemented hooks should have been invoked
          for (const invocation of invocations) {
            expect(hookSet.has(invocation.hook as HookName)).toBe(true);
          }

          // Assert - expected invocation counts for implemented hooks
          if (hookSet.has('onRead')) {
            expect(invocations.filter(i => i.hook === 'onRead').length).toBe(1);
          }
          if (hookSet.has('onWrite')) {
            expect(invocations.filter(i => i.hook === 'onWrite').length).toBe(2); // setValue + updateValue
          }
          if (hookSet.has('onCommit')) {
            expect(invocations.filter(i => i.hook === 'onCommit').length).toBe(1);
          }
          if (hookSet.has('onStageStart')) {
            expect(invocations.filter(i => i.hook === 'onStageStart').length).toBe(1);
          }
          if (hookSet.has('onStageEnd')) {
            expect(invocations.filter(i => i.hook === 'onStageEnd').length).toBe(1);
          }
          // onError should not be invoked unless there's an actual error
          if (hookSet.has('onError')) {
            expect(invocations.filter(i => i.hook === 'onError').length).toBe(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('scope operations return correct values regardless of partial recorder', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbHookSubset,
        (pipelineId, stageName, key, value, implementedHooks) => {
          // Arrange - create recorder with arbitrary subset of hooks
          const globalStore = new GlobalStore();
          const { recorder } = createPartialRecorder('partial-recorder', implementedHooks);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act - perform operations
          scope.setValue(key, value);
          const readValue = scope.getValue(key);
          scope.commit();
          const readValueAfterCommit = scope.getValue(key);

          // Assert - values should be correct regardless of partial recorder
          expect(readValue).toEqual(value);
          expect(readValueAfterCommit).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('multiple partial recorders with different hook subsets all work correctly', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbHookSubset,
        arbHookSubset,
        arbHookSubset,
        (pipelineId, stageName, key, value, hooks1, hooks2, hooks3) => {
          // Arrange - create multiple partial recorders with different hook subsets
          const globalStore = new GlobalStore();
          const { recorder: recorder1, invocations: invocations1 } = createPartialRecorder('recorder-1', hooks1);
          const { recorder: recorder2, invocations: invocations2 } = createPartialRecorder('recorder-2', hooks2);
          const { recorder: recorder3, invocations: invocations3 } = createPartialRecorder('recorder-3', hooks3);

          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder1, recorder2, recorder3],
          });

          const hookSet1 = new Set(hooks1);
          const hookSet2 = new Set(hooks2);
          const hookSet3 = new Set(hooks3);

          // Act - perform all operations (should not throw)
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.commit();
          scope.endStage();

          // Assert - each recorder only received invocations for its implemented hooks
          for (const invocation of invocations1) {
            expect(hookSet1.has(invocation.hook as HookName)).toBe(true);
          }
          for (const invocation of invocations2) {
            expect(hookSet2.has(invocation.hook as HookName)).toBe(true);
          }
          for (const invocation of invocations3) {
            expect(hookSet3.has(invocation.hook as HookName)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder attached via attachRecorder works correctly', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbHookSubset,
        (pipelineId, stageName, key, value, implementedHooks) => {
          // Arrange - create scope without recorders, then attach partial recorder
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          const { recorder, invocations } = createPartialRecorder('attached-recorder', implementedHooks);
          scope.attachRecorder(recorder);

          const hookSet = new Set(implementedHooks);

          // Act - perform operations (should not throw)
          scope.getValue(key);
          scope.setValue(key, value);
          scope.commit();

          // Assert - only implemented hooks should have been invoked
          for (const invocation of invocations) {
            expect(hookSet.has(invocation.hook as HookName)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('partial recorder attached as stage recorder works correctly', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbHookSubset,
        (pipelineId, stageName, key, value, implementedHooks) => {
          // Arrange - create scope and attach partial recorder at stage level
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          const { recorder, invocations } = createPartialRecorder('stage-recorder', implementedHooks);
          scope.attachStageRecorder(stageName, recorder);

          const hookSet = new Set(implementedHooks);

          // Act - perform operations (should not throw)
          scope.getValue(key);
          scope.setValue(key, value);
          scope.commit();

          // Assert - only implemented hooks should have been invoked
          for (const invocation of invocations) {
            expect(hookSet.has(invocation.hook as HookName)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('implemented hooks receive correct event data even with partial recorder', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange - create recorder with only onRead and onWrite
          const globalStore = new GlobalStore();
          const { recorder, invocations } = createPartialRecorder('partial-recorder', ['onRead', 'onWrite']);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders: [recorder],
          });

          // Act
          scope.setValue(key, value);
          scope.getValue(key);

          // Assert - events should have correct data
          const writeEvent = invocations.find(i => i.hook === 'onWrite')?.event as {
            key: string;
            value: unknown;
            operation: string;
            stageName: string;
            pipelineId: string;
          };
          expect(writeEvent).toBeDefined();
          expect(writeEvent.key).toBe(key);
          expect(writeEvent.value).toEqual(value);
          expect(writeEvent.operation).toBe('set');
          expect(writeEvent.stageName).toBe(stageName);
          expect(writeEvent.pipelineId).toBe(pipelineId);

          const readEvent = invocations.find(i => i.hook === 'onRead')?.event as {
            key?: string;
            value: unknown;
            stageName: string;
            pipelineId: string;
          };
          expect(readEvent).toBeDefined();
          expect(readEvent.key).toBe(key);
          expect(readEvent.value).toEqual(value);
          expect(readEvent.stageName).toBe(stageName);
          expect(readEvent.pipelineId).toBe(pipelineId);
        }
      ),
      { numRuns: 100 }
    );
  });
});


describe('Property 10: Multiple Recorders Event Distribution', () => {
  /**
   * Feature: scope-recorder-pattern
   * Property 10: Multiple Recorders Event Distribution
   * **Validates: Requirements 4.1, 4.4**
   *
   * For any Scope with N attached Recorders, each scope operation SHALL invoke
   * the corresponding hook on all N Recorders in attachment order.
   */

  /**
   * Reserved JavaScript property names that cannot be used as path segments.
   */
  const RESERVED_NAMES = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    'caller', 'callee', 'arguments', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  ]);

  /**
   * Arbitrary for valid path segments (non-empty strings without special chars).
   */
  const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !RESERVED_NAMES.has(s));

  /**
   * Arbitrary for valid paths (arrays of path segments).
   */
  const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

  /**
   * Arbitrary for valid keys (non-empty strings).
   */
  const arbKey = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

  /**
   * Arbitrary for pipeline IDs.
   */
  const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for stage names.
   */
  const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for JSON-serializable primitive values.
   */
  const arbPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  );

  /**
   * Arbitrary for JSON-serializable values (primitives, arrays, objects).
   */
  const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    primitive: arbPrimitive,
    array: fc.array(tie('value'), { maxLength: 5 }),
    object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
    value: fc.oneof(
      { weight: 3, arbitrary: tie('primitive') },
      { weight: 1, arbitrary: tie('array') },
      { weight: 1, arbitrary: tie('object') }
    )
  })).value;

  /**
   * Arbitrary for number of recorders (2-5 as per task requirements).
   */
  const arbRecorderCount = fc.integer({ min: 2, max: 5 });

  /**
   * Hook invocation record with recorder ID for tracking order.
   */
  interface HookInvocation {
    recorderId: string;
    hook: string;
    event: unknown;
    timestamp: number;
    invocationOrder: number;
  }

  /**
   * Global invocation counter for tracking order across all recorders.
   */
  let globalInvocationCounter = 0;

  /**
   * Creates a mock recorder that tracks all hook invocations with order.
   */
  function createMockRecorderWithOrder(id: string, invocations: HookInvocation[]): Recorder {
    return {
      id,
      onRead(event) {
        invocations.push({
          recorderId: id,
          hook: 'onRead',
          event: JSON.parse(JSON.stringify(event)), // Deep copy to preserve event data
          timestamp: Date.now(),
          invocationOrder: globalInvocationCounter++,
        });
      },
      onWrite(event) {
        invocations.push({
          recorderId: id,
          hook: 'onWrite',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          invocationOrder: globalInvocationCounter++,
        });
      },
      onCommit(event) {
        invocations.push({
          recorderId: id,
          hook: 'onCommit',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          invocationOrder: globalInvocationCounter++,
        });
      },
      onError(event) {
        invocations.push({
          recorderId: id,
          hook: 'onError',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          invocationOrder: globalInvocationCounter++,
        });
      },
      onStageStart(event) {
        invocations.push({
          recorderId: id,
          hook: 'onStageStart',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          invocationOrder: globalInvocationCounter++,
        });
      },
      onStageEnd(event) {
        invocations.push({
          recorderId: id,
          hook: 'onStageEnd',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          invocationOrder: globalInvocationCounter++,
        });
      },
    };
  }

  /**
   * Creates multiple mock recorders that share an invocation tracking array.
   */
  function createMultipleRecorders(count: number): {
    recorders: Recorder[];
    invocations: HookInvocation[];
    recorderIds: string[];
  } {
    const invocations: HookInvocation[] = [];
    const recorderIds: string[] = [];
    const recorders: Recorder[] = [];

    for (let i = 0; i < count; i++) {
      const id = `recorder-${i}`;
      recorderIds.push(id);
      recorders.push(createMockRecorderWithOrder(id, invocations));
    }

    return { recorders, invocations, recorderIds };
  }

  beforeEach(() => {
    // Reset global counter before each test
    globalInvocationCounter = 0;
  });

  test('all recorders receive onRead event for getValue operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbRecorderCount,
        (pipelineId, stageName, key, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act
          scope.getValue(key);

          // Assert - all recorders should receive onRead
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(recorderCount);

          // Assert - each recorder received exactly one onRead
          for (const recorderId of recorderIds) {
            const recorderReads = readInvocations.filter(i => i.recorderId === recorderId);
            expect(recorderReads.length).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('all recorders receive onWrite event for setValue operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act
          scope.setValue(key, value);

          // Assert - all recorders should receive onWrite
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(recorderCount);

          // Assert - each recorder received exactly one onWrite
          for (const recorderId of recorderIds) {
            const recorderWrites = writeInvocations.filter(i => i.recorderId === recorderId);
            expect(recorderWrites.length).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('all recorders receive onCommit event for commit operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Stage a write first
          scope.setValue(key, value);
          invocations.length = 0; // Clear write invocations
          globalInvocationCounter = 0;

          // Act
          scope.commit();

          // Assert - all recorders should receive onCommit
          const commitInvocations = invocations.filter(i => i.hook === 'onCommit');
          expect(commitInvocations.length).toBe(recorderCount);

          // Assert - each recorder received exactly one onCommit
          for (const recorderId of recorderIds) {
            const recorderCommits = commitInvocations.filter(i => i.recorderId === recorderId);
            expect(recorderCommits.length).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('all recorders receive onStageStart event for startStage operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbRecorderCount,
        (pipelineId, stageName, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act
          scope.startStage(stageName);

          // Assert - all recorders should receive onStageStart
          const stageStartInvocations = invocations.filter(i => i.hook === 'onStageStart');
          expect(stageStartInvocations.length).toBe(recorderCount);

          // Assert - each recorder received exactly one onStageStart
          for (const recorderId of recorderIds) {
            const recorderStarts = stageStartInvocations.filter(i => i.recorderId === recorderId);
            expect(recorderStarts.length).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('all recorders receive onStageEnd event for endStage operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbRecorderCount,
        (pipelineId, stageName, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Start stage first
          scope.startStage(stageName);
          invocations.length = 0; // Clear start invocations
          globalInvocationCounter = 0;

          // Act
          scope.endStage();

          // Assert - all recorders should receive onStageEnd
          const stageEndInvocations = invocations.filter(i => i.hook === 'onStageEnd');
          expect(stageEndInvocations.length).toBe(recorderCount);

          // Assert - each recorder received exactly one onStageEnd
          for (const recorderId of recorderIds) {
            const recorderEnds = stageEndInvocations.filter(i => i.recorderId === recorderId);
            expect(recorderEnds.length).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('recorders are invoked in attachment order for each operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act - perform a single operation
          scope.getValue(key);

          // Assert - invocations should be in attachment order
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(recorderCount);

          // Verify order by checking invocationOrder
          for (let i = 0; i < recorderCount; i++) {
            expect(readInvocations[i].recorderId).toBe(recorderIds[i]);
            expect(readInvocations[i].invocationOrder).toBe(i);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('event data is identical across all recorders for same operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act
          scope.setValue(key, value);

          // Assert - all recorders received identical event data
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(recorderCount);

          // Compare event data across all recorders
          const firstEvent = writeInvocations[0].event as {
            key: string;
            value: unknown;
            operation: string;
            stageName: string;
            pipelineId: string;
          };

          for (let i = 1; i < recorderCount; i++) {
            const currentEvent = writeInvocations[i].event as typeof firstEvent;
            expect(currentEvent.key).toEqual(firstEvent.key);
            expect(currentEvent.key).toBe(firstEvent.key);
            expect(currentEvent.value).toEqual(firstEvent.value);
            expect(currentEvent.operation).toBe(firstEvent.operation);
            expect(currentEvent.stageName).toBe(firstEvent.stageName);
            expect(currentEvent.pipelineId).toBe(firstEvent.pipelineId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('event data is identical for onRead across all recorders', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Set a value first so read returns something
          scope.setValue(key, value);
          scope.commit();
          invocations.length = 0;
          globalInvocationCounter = 0;

          // Act
          scope.getValue(key);

          // Assert - all recorders received identical event data
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(recorderCount);

          const firstEvent = readInvocations[0].event as {
            key?: string;
            value: unknown;
            stageName: string;
            pipelineId: string;
          };

          for (let i = 1; i < recorderCount; i++) {
            const currentEvent = readInvocations[i].event as typeof firstEvent;
            expect(currentEvent.key).toEqual(firstEvent.key);
            expect(currentEvent.key).toBe(firstEvent.key);
            expect(currentEvent.value).toEqual(firstEvent.value);
            expect(currentEvent.stageName).toBe(firstEvent.stageName);
            expect(currentEvent.pipelineId).toBe(firstEvent.pipelineId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('event data is identical for onCommit across all recorders', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Stage writes
          scope.setValue(key, value);
          invocations.length = 0;
          globalInvocationCounter = 0;

          // Act
          scope.commit();

          // Assert - all recorders received identical event data
          const commitInvocations = invocations.filter(i => i.hook === 'onCommit');
          expect(commitInvocations.length).toBe(recorderCount);

          const firstEvent = commitInvocations[0].event as {
            mutations: Array<{ key: string; value: unknown; operation: string }>;
            stageName: string;
            pipelineId: string;
          };

          for (let i = 1; i < recorderCount; i++) {
            const currentEvent = commitInvocations[i].event as typeof firstEvent;
            expect(currentEvent.mutations).toEqual(firstEvent.mutations);
            expect(currentEvent.stageName).toBe(firstEvent.stageName);
            expect(currentEvent.pipelineId).toBe(firstEvent.pipelineId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('multiple operations maintain attachment order for all hooks', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act - perform multiple operations
          scope.startStage(stageName);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.commit();
          scope.endStage();

          // Assert - for each hook type, recorders should be invoked in attachment order
          const hookTypes = ['onStageStart', 'onRead', 'onWrite', 'onCommit', 'onStageEnd'];

          for (const hookType of hookTypes) {
            const hookInvocations = invocations.filter(i => i.hook === hookType);
            expect(hookInvocations.length).toBe(recorderCount);

            // Verify order within this hook type
            const sortedByOrder = [...hookInvocations].sort((a, b) => a.invocationOrder - b.invocationOrder);
            for (let i = 0; i < recorderCount; i++) {
              expect(sortedByOrder[i].recorderId).toBe(recorderIds[i]);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('recorders attached via attachRecorder are invoked in attachment order', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange - create scope without recorders
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Create and attach recorders one by one
          const invocations: HookInvocation[] = [];
          const recorderIds: string[] = [];
          for (let i = 0; i < recorderCount; i++) {
            const id = `attached-recorder-${i}`;
            recorderIds.push(id);
            scope.attachRecorder(createMockRecorderWithOrder(id, invocations));
          }

          // Act
          scope.getValue(key);

          // Assert - invocations should be in attachment order
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(recorderCount);

          for (let i = 0; i < recorderCount; i++) {
            expect(readInvocations[i].recorderId).toBe(recorderIds[i]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('all recorders receive events for updateValue operation', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        (pipelineId, stageName, key, value, recorderCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations, recorderIds } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act
          scope.updateValue(key, value);

          // Assert - all recorders should receive onWrite with operation 'update'
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(recorderCount);

          // Assert - each recorder received exactly one onWrite
          for (const recorderId of recorderIds) {
            const recorderWrites = writeInvocations.filter(i => i.recorderId === recorderId);
            expect(recorderWrites.length).toBe(1);
            const event = recorderWrites[0].event as { operation: string };
            expect(event.operation).toBe('update');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('total invocation count equals recorderCount times operationCount', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbRecorderCount,
        fc.integer({ min: 1, max: 5 }), // number of read operations
        fc.integer({ min: 1, max: 5 }), // number of write operations
        (pipelineId, stageName, key, value, recorderCount, readCount, writeCount) => {
          // Reset counter for this property run
          globalInvocationCounter = 0;

          // Arrange
          const globalStore = new GlobalStore();
          const { recorders, invocations } = createMultipleRecorders(recorderCount);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
            recorders,
          });

          // Act - perform multiple operations
          for (let i = 0; i < readCount; i++) {
            scope.getValue(`${key}${i}`);
          }
          for (let i = 0; i < writeCount; i++) {
            scope.setValue(`${key}${i}`, value);
          }

          // Assert - total invocations = recorderCount * (readCount + writeCount)
          const expectedTotal = recorderCount * (readCount + writeCount);
          expect(invocations.length).toBe(expectedTotal);

          // Assert - read invocations = recorderCount * readCount
          const readInvocations = invocations.filter(i => i.hook === 'onRead');
          expect(readInvocations.length).toBe(recorderCount * readCount);

          // Assert - write invocations = recorderCount * writeCount
          const writeInvocations = invocations.filter(i => i.hook === 'onWrite');
          expect(writeInvocations.length).toBe(recorderCount * writeCount);
        }
      ),
      { numRuns: 100 }
    );
  });
});


describe('Property 11: Recorder Detachment', () => {
  /**
   * Feature: scope-recorder-pattern
   * Property 11: Recorder Detachment
   * **Validates: Requirements 4.5**
   *
   * For any Scope with an attached Recorder, after detaching that Recorder,
   * subsequent scope operations SHALL NOT invoke any hooks on the detached Recorder.
   */

  /**
   * Reserved JavaScript property names that cannot be used as path segments.
   */
  const RESERVED_NAMES = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    'caller', 'callee', 'arguments', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  ]);

  /**
   * Arbitrary for valid path segments (non-empty strings without special chars).
   */
  const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !RESERVED_NAMES.has(s));

  /**
   * Arbitrary for valid paths (arrays of path segments).
   */
  const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

  /**
   * Arbitrary for valid keys (non-empty strings).
   */
  const arbKey = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

  /**
   * Arbitrary for pipeline IDs.
   */
  const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for stage names.
   */
  const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for JSON-serializable primitive values.
   */
  const arbPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  );

  /**
   * Arbitrary for JSON-serializable values (primitives, arrays, objects).
   */
  const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    primitive: arbPrimitive,
    array: fc.array(tie('value'), { maxLength: 5 }),
    object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
    value: fc.oneof(
      { weight: 3, arbitrary: tie('primitive') },
      { weight: 1, arbitrary: tie('array') },
      { weight: 1, arbitrary: tie('object') }
    )
  })).value;

  /**
   * Hook invocation record for tracking.
   */
  interface HookInvocation {
    recorderId: string;
    hook: string;
    event: unknown;
    timestamp: number;
  }

  /**
   * Creates a mock recorder that tracks all hook invocations.
   */
  function createMockRecorder(id: string, invocations: HookInvocation[]): Recorder {
    return {
      id,
      onRead(event) {
        invocations.push({
          recorderId: id,
          hook: 'onRead',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
        });
      },
      onWrite(event) {
        invocations.push({
          recorderId: id,
          hook: 'onWrite',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
        });
      },
      onCommit(event) {
        invocations.push({
          recorderId: id,
          hook: 'onCommit',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
        });
      },
      onError(event) {
        invocations.push({
          recorderId: id,
          hook: 'onError',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
        });
      },
      onStageStart(event) {
        invocations.push({
          recorderId: id,
          hook: 'onStageStart',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
        });
      },
      onStageEnd(event) {
        invocations.push({
          recorderId: id,
          hook: 'onStageEnd',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
        });
      },
    };
  }

  test('detached global recorder receives no events after detachment', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbJsonValue,
        (pipelineId, stageName, key, valueBefore, valueAfter) => {
          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const recorder = createMockRecorder('test-recorder', invocations);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach recorder
          scope.attachRecorder(recorder);

          // Act - perform operations before detachment
          scope.getValue(key);
          scope.setValue(key, valueBefore);
          scope.commit();

          // Record count before detachment
          const countBeforeDetach = invocations.length;

          // Verify recorder received events before detachment
          expect(countBeforeDetach).toBeGreaterThan(0);

          // Detach the recorder
          scope.detachRecorder(recorder.id);

          // Act - perform operations after detachment
          scope.getValue(key);
          scope.setValue(key, valueAfter);
          scope.commit();

          // Assert - no new invocations after detachment
          expect(invocations.length).toBe(countBeforeDetach);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('detached stage-level recorder receives no events after detachment', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbJsonValue,
        (pipelineId, stageName, key, valueBefore, valueAfter) => {
          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const recorder = createMockRecorder('stage-recorder', invocations);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach recorder at stage level
          scope.attachStageRecorder(stageName, recorder);

          // Act - perform operations before detachment
          scope.getValue(key);
          scope.setValue(key, valueBefore);
          scope.commit();

          // Record count before detachment
          const countBeforeDetach = invocations.length;

          // Verify recorder received events before detachment
          expect(countBeforeDetach).toBeGreaterThan(0);

          // Detach the recorder
          scope.detachRecorder(recorder.id);

          // Act - perform operations after detachment
          scope.getValue(key);
          scope.setValue(key, valueAfter);
          scope.commit();

          // Assert - no new invocations after detachment
          expect(invocations.length).toBe(countBeforeDetach);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('detachment only affects the detached recorder, not others', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const invocations1: HookInvocation[] = [];
          const invocations2: HookInvocation[] = [];
          const recorder1 = createMockRecorder('recorder-1', invocations1);
          const recorder2 = createMockRecorder('recorder-2', invocations2);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach both recorders
          scope.attachRecorder(recorder1);
          scope.attachRecorder(recorder2);

          // Perform initial operation
          scope.getValue(key);

          // Both should have received the event
          expect(invocations1.length).toBe(1);
          expect(invocations2.length).toBe(1);

          // Detach only recorder1
          scope.detachRecorder(recorder1.id);

          // Perform another operation
          scope.setValue(key, value);

          // Assert - recorder1 should not receive new events
          expect(invocations1.length).toBe(1); // Still 1 from before

          // Assert - recorder2 should continue receiving events
          expect(invocations2.length).toBe(2); // 1 read + 1 write
        }
      ),
      { numRuns: 100 }
    );
  });

  test('detached recorder receives no events for any operation type', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const recorder = createMockRecorder('test-recorder', invocations);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach recorder
          scope.attachRecorder(recorder);

          // Perform one operation to verify attachment works
          scope.getValue(key);
          expect(invocations.length).toBe(1);

          // Detach the recorder
          scope.detachRecorder(recorder.id);
          const countAfterDetach = invocations.length;

          // Act - perform all operation types after detachment
          scope.getValue(key);           // onRead
          scope.setValue(key, value);    // onWrite
          scope.updateValue(key, value); // onWrite (update)
          scope.commit();                      // onCommit
          scope.startStage('newStage');        // onStageStart
          scope.endStage();                    // onStageEnd

          // Assert - no new invocations for any operation type
          expect(invocations.length).toBe(countAfterDetach);

          // Verify no hooks were called after detachment
          const hooksAfterDetach = invocations.slice(countAfterDetach);
          expect(hooksAfterDetach).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('multiple detachments work correctly', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        fc.integer({ min: 2, max: 5 }),
        (pipelineId, stageName, key, value, recorderCount) => {
          // Arrange
          const globalStore = new GlobalStore();
          const allInvocations: Map<string, HookInvocation[]> = new Map();
          const recorders: Recorder[] = [];

          for (let i = 0; i < recorderCount; i++) {
            const invocations: HookInvocation[] = [];
            const recorder = createMockRecorder(`recorder-${i}`, invocations);
            allInvocations.set(recorder.id, invocations);
            recorders.push(recorder);
          }

          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach all recorders
          for (const recorder of recorders) {
            scope.attachRecorder(recorder);
          }

          // Perform initial operation - all should receive
          scope.getValue(key);
          for (const [, invocations] of allInvocations) {
            expect(invocations.length).toBe(1);
          }

          // Detach recorders one by one and verify
          for (let i = 0; i < recorderCount; i++) {
            const recorderToDetach = recorders[i];
            const countBeforeDetach = allInvocations.get(recorderToDetach.id)!.length;

            scope.detachRecorder(recorderToDetach.id);

            // Perform operation
            scope.setValue(`${key}${i}`, value);

            // Detached recorder should not receive new events
            expect(allInvocations.get(recorderToDetach.id)!.length).toBe(countBeforeDetach);

            // Remaining attached recorders should receive events
            for (let j = i + 1; j < recorderCount; j++) {
              const remainingRecorder = recorders[j];
              // Each remaining recorder should have: 1 initial read + (i+1) writes
              expect(allInvocations.get(remainingRecorder.id)!.length).toBe(1 + (i + 1));
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('detaching non-existent recorder is a no-op', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const recorder = createMockRecorder('test-recorder', invocations);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach recorder
          scope.attachRecorder(recorder);

          // Detach a non-existent recorder (should be no-op)
          scope.detachRecorder('non-existent-recorder');

          // Act - perform operation
          scope.getValue(key);

          // Assert - original recorder should still receive events
          expect(invocations.length).toBe(1);
          expect(invocations[0].recorderId).toBe('test-recorder');
        }
      ),
      { numRuns: 100 }
    );
  });

  test('re-attaching a detached recorder allows it to receive events again', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const recorder = createMockRecorder('test-recorder', invocations);
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Attach recorder
          scope.attachRecorder(recorder);

          // Perform operation - should receive
          scope.getValue(key);
          expect(invocations.length).toBe(1);

          // Detach recorder
          scope.detachRecorder(recorder.id);

          // Perform operation - should NOT receive
          scope.getValue(key);
          expect(invocations.length).toBe(1);

          // Re-attach recorder
          scope.attachRecorder(recorder);

          // Perform operation - should receive again
          scope.setValue(key, value);
          expect(invocations.length).toBe(2);
          expect(invocations[1].hook).toBe('onWrite');
        }
      ),
      { numRuns: 100 }
    );
  });
});


describe('Property 12: Stage-Level Recorder Isolation', () => {
  /**
   * Feature: scope-recorder-pattern
   * Property 12: Stage-Level Recorder Isolation
   * **Validates: Requirements 4.7**
   *
   * For any Scope with a stage-level Recorder attached to stage S, operations
   * performed during other stages SHALL NOT invoke hooks on that Recorder.
   *
   * ∀ recorder R attached to stage S:
   *   operations in stage S' ≠ S ⟹ R receives no events
   */

  /**
   * Reserved JavaScript property names that cannot be used as path segments.
   */
  const RESERVED_NAMES = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    'caller', 'callee', 'arguments', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  ]);

  /**
   * Arbitrary for valid path segments (non-empty strings without special chars).
   */
  const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !RESERVED_NAMES.has(s));

  /**
   * Arbitrary for valid paths (arrays of path segments).
   */
  const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

  /**
   * Arbitrary for valid keys (non-empty strings).
   */
  const arbKey = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

  /**
   * Arbitrary for pipeline IDs.
   */
  const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for stage names.
   */
  const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for JSON-serializable primitive values.
   */
  const arbPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  );

  /**
   * Arbitrary for JSON-serializable values (primitives, arrays, objects).
   */
  const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    primitive: arbPrimitive,
    array: fc.array(tie('value'), { maxLength: 5 }),
    object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
    value: fc.oneof(
      { weight: 3, arbitrary: tie('primitive') },
      { weight: 1, arbitrary: tie('array') },
      { weight: 1, arbitrary: tie('object') }
    )
  })).value;

  /**
   * Hook invocation record for tracking.
   */
  interface HookInvocation {
    recorderId: string;
    hook: string;
    event: unknown;
    timestamp: number;
    stageName: string;
  }

  /**
   * Creates a mock recorder that tracks all hook invocations with stage info.
   */
  function createMockRecorder(id: string, invocations: HookInvocation[]): Recorder {
    return {
      id,
      onRead(event) {
        const e = event as { stageName: string };
        invocations.push({
          recorderId: id,
          hook: 'onRead',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          stageName: e.stageName,
        });
      },
      onWrite(event) {
        const e = event as { stageName: string };
        invocations.push({
          recorderId: id,
          hook: 'onWrite',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          stageName: e.stageName,
        });
      },
      onCommit(event) {
        const e = event as { stageName: string };
        invocations.push({
          recorderId: id,
          hook: 'onCommit',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          stageName: e.stageName,
        });
      },
      onError(event) {
        const e = event as { stageName: string };
        invocations.push({
          recorderId: id,
          hook: 'onError',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          stageName: e.stageName,
        });
      },
      onStageStart(event) {
        const e = event as { stageName: string };
        invocations.push({
          recorderId: id,
          hook: 'onStageStart',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          stageName: e.stageName,
        });
      },
      onStageEnd(event) {
        const e = event as { stageName: string };
        invocations.push({
          recorderId: id,
          hook: 'onStageEnd',
          event: JSON.parse(JSON.stringify(event)),
          timestamp: Date.now(),
          stageName: e.stageName,
        });
      },
    };
  }

  test('stage-level recorder receives no events when scope is in a different stage', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, attachedStage, differentStage, key, value) => {
          // Ensure stages are different
          fc.pre(attachedStage !== differentStage);

          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const stageRecorder = createMockRecorder('stage-recorder', invocations);

          // Create scope starting in the different stage (not the attached stage)
          const scope = new Scope({
            pipelineId,
            stageName: differentStage,
            globalStore,
          });

          // Attach recorder to a specific stage (not the current stage)
          scope.attachStageRecorder(attachedStage, stageRecorder);

          // Act - perform operations while in the different stage
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();

          // Assert - stage-level recorder should receive NO events
          // because the scope is in a different stage
          expect(invocations.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('stage-level recorder receives events only when scope switches to its attached stage', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbJsonValue,
        (pipelineId, attachedStage, otherStage, key, value1, value2) => {
          // Ensure stages are different
          fc.pre(attachedStage !== otherStage);

          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const stageRecorder = createMockRecorder('stage-recorder', invocations);

          // Create scope starting in the other stage
          const scope = new Scope({
            pipelineId,
            stageName: otherStage,
            globalStore,
          });

          // Attach recorder to the attached stage
          scope.attachStageRecorder(attachedStage, stageRecorder);

          // Act - perform operations in other stage (should NOT trigger recorder)
          scope.setValue(key, value1);
          scope.commit();
          const countInOtherStage = invocations.length;

          // Switch to the attached stage
          scope.startStage(attachedStage);

          // Perform operations in attached stage (SHOULD trigger recorder)
          scope.getValue(key);
          scope.setValue(key, value2);
          scope.commit();
          scope.endStage();

          // Assert - recorder should have received events only from attached stage
          expect(countInOtherStage).toBe(0);
          expect(invocations.length).toBeGreaterThan(0);

          // All invocations should be from the attached stage
          for (const invocation of invocations) {
            expect(invocation.stageName).toBe(attachedStage);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('stage-level recorder stops receiving events when scope switches away from its stage', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbJsonValue,
        (pipelineId, attachedStage, otherStage, key, value1, value2) => {
          // Ensure stages are different
          fc.pre(attachedStage !== otherStage);

          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const stageRecorder = createMockRecorder('stage-recorder', invocations);

          // Create scope starting in the attached stage
          const scope = new Scope({
            pipelineId,
            stageName: attachedStage,
            globalStore,
          });

          // Attach recorder to the attached stage
          scope.attachStageRecorder(attachedStage, stageRecorder);

          // Act - perform operations in attached stage (SHOULD trigger recorder)
          scope.getValue(key);
          scope.setValue(key, value1);
          scope.commit();
          const countInAttachedStage = invocations.length;

          // Verify recorder received events in attached stage
          expect(countInAttachedStage).toBeGreaterThan(0);

          // Switch to a different stage
          scope.startStage(otherStage);

          // Perform operations in other stage (should NOT trigger recorder)
          scope.getValue(key);
          scope.setValue(key, value2);
          scope.commit();

          // Assert - no new invocations after switching away
          expect(invocations.length).toBe(countInAttachedStage);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('multiple stage-level recorders each receive events only for their attached stage', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stage1, stage2, stage3, key, value) => {
          // Ensure all stages are different
          fc.pre(stage1 !== stage2 && stage2 !== stage3 && stage1 !== stage3);

          // Arrange
          const globalStore = new GlobalStore();
          const invocations1: HookInvocation[] = [];
          const invocations2: HookInvocation[] = [];
          const invocations3: HookInvocation[] = [];
          const recorder1 = createMockRecorder('recorder-stage1', invocations1);
          const recorder2 = createMockRecorder('recorder-stage2', invocations2);
          const recorder3 = createMockRecorder('recorder-stage3', invocations3);

          // Create scope starting in stage1
          const scope = new Scope({
            pipelineId,
            stageName: stage1,
            globalStore,
          });

          // Attach each recorder to its respective stage
          scope.attachStageRecorder(stage1, recorder1);
          scope.attachStageRecorder(stage2, recorder2);
          scope.attachStageRecorder(stage3, recorder3);

          // Act - perform operations in stage1
          scope.setValue(key, value);
          scope.commit();

          // Assert - only recorder1 should have received events
          expect(invocations1.length).toBeGreaterThan(0);
          expect(invocations2.length).toBe(0);
          expect(invocations3.length).toBe(0);

          // Clear and switch to stage2
          const count1AfterStage1 = invocations1.length;
          scope.startStage(stage2);
          scope.setValue(key, value);
          scope.commit();

          // Assert - only recorder2 should have received new events
          expect(invocations1.length).toBe(count1AfterStage1); // No new events
          expect(invocations2.length).toBeGreaterThan(0);
          expect(invocations3.length).toBe(0);

          // Clear and switch to stage3
          const count2AfterStage2 = invocations2.length;
          scope.startStage(stage3);
          scope.setValue(key, value);
          scope.commit();

          // Assert - only recorder3 should have received new events
          expect(invocations1.length).toBe(count1AfterStage1); // No new events
          expect(invocations2.length).toBe(count2AfterStage2); // No new events
          expect(invocations3.length).toBeGreaterThan(0);

          // Verify all invocations are from correct stages
          for (const inv of invocations1) {
            expect(inv.stageName).toBe(stage1);
          }
          for (const inv of invocations2) {
            expect(inv.stageName).toBe(stage2);
          }
          for (const inv of invocations3) {
            expect(inv.stageName).toBe(stage3);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('global recorder receives events from all stages while stage-level recorder is isolated', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, attachedStage, otherStage, key, value) => {
          // Ensure stages are different
          fc.pre(attachedStage !== otherStage);

          // Arrange
          const globalStore = new GlobalStore();
          const globalInvocations: HookInvocation[] = [];
          const stageInvocations: HookInvocation[] = [];
          const globalRecorder = createMockRecorder('global-recorder', globalInvocations);
          const stageRecorder = createMockRecorder('stage-recorder', stageInvocations);

          // Create scope starting in other stage
          const scope = new Scope({
            pipelineId,
            stageName: otherStage,
            globalStore,
          });

          // Attach global recorder and stage-level recorder
          scope.attachRecorder(globalRecorder);
          scope.attachStageRecorder(attachedStage, stageRecorder);

          // Act - perform operations in other stage
          scope.setValue(key, value);
          scope.commit();

          // Assert - global recorder should receive events, stage recorder should not
          expect(globalInvocations.length).toBeGreaterThan(0);
          expect(stageInvocations.length).toBe(0);

          const globalCountAfterOtherStage = globalInvocations.length;

          // Switch to attached stage
          scope.startStage(attachedStage);
          scope.setValue(key, value);
          scope.commit();

          // Assert - both recorders should receive events now
          expect(globalInvocations.length).toBeGreaterThan(globalCountAfterOtherStage);
          expect(stageInvocations.length).toBeGreaterThan(0);

          // Verify stage recorder only has events from attached stage
          for (const inv of stageInvocations) {
            expect(inv.stageName).toBe(attachedStage);
          }

          // Verify global recorder has events from both stages
          const globalStages = new Set(globalInvocations.map(inv => inv.stageName));
          expect(globalStages.has(otherStage)).toBe(true);
          expect(globalStages.has(attachedStage)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('stage-level recorder receives all operation types only in its attached stage', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, attachedStage, otherStage, key, value) => {
          // Ensure stages are different
          fc.pre(attachedStage !== otherStage);

          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const stageRecorder = createMockRecorder('stage-recorder', invocations);

          // Create scope starting in attached stage
          const scope = new Scope({
            pipelineId,
            stageName: attachedStage,
            globalStore,
          });

          // Attach recorder to the attached stage
          scope.attachStageRecorder(attachedStage, stageRecorder);

          // Act - perform all operation types in attached stage
          scope.startStage(attachedStage); // onStageStart
          scope.getValue(key);        // onRead
          scope.setValue(key, value); // onWrite
          scope.updateValue(key, { extra: 'data' }); // onWrite
          scope.commit();                   // onCommit
          scope.endStage();                 // onStageEnd

          // Collect hooks received in attached stage
          const hooksInAttachedStage = new Set(invocations.map(inv => inv.hook));
          const countInAttachedStage = invocations.length;

          // Verify all expected hooks were received
          expect(hooksInAttachedStage.has('onStageStart')).toBe(true);
          expect(hooksInAttachedStage.has('onRead')).toBe(true);
          expect(hooksInAttachedStage.has('onWrite')).toBe(true);
          expect(hooksInAttachedStage.has('onCommit')).toBe(true);
          expect(hooksInAttachedStage.has('onStageEnd')).toBe(true);

          // Switch to other stage and perform same operations
          scope.startStage(otherStage);
          scope.getValue(key);
          scope.setValue(key, value);
          scope.updateValue(key, { extra: 'data' });
          scope.commit();
          scope.endStage();

          // Assert - no new invocations in other stage
          expect(invocations.length).toBe(countInAttachedStage);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('switching back to attached stage resumes event delivery to stage-level recorder', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, attachedStage, otherStage, key, value) => {
          // Ensure stages are different
          fc.pre(attachedStage !== otherStage);

          // Arrange
          const globalStore = new GlobalStore();
          const invocations: HookInvocation[] = [];
          const stageRecorder = createMockRecorder('stage-recorder', invocations);

          // Create scope starting in attached stage
          const scope = new Scope({
            pipelineId,
            stageName: attachedStage,
            globalStore,
          });

          // Attach recorder to the attached stage
          scope.attachStageRecorder(attachedStage, stageRecorder);

          // Phase 1: Operations in attached stage
          scope.setValue(key, value);
          scope.commit();
          const countPhase1 = invocations.length;
          expect(countPhase1).toBeGreaterThan(0);

          // Phase 2: Switch away - no events
          scope.startStage(otherStage);
          scope.setValue(key, value);
          scope.commit();
          expect(invocations.length).toBe(countPhase1);

          // Phase 3: Switch back - events resume
          scope.startStage(attachedStage);
          scope.setValue(key, value);
          scope.commit();
          expect(invocations.length).toBeGreaterThan(countPhase1);

          // Verify all invocations are from attached stage
          for (const inv of invocations) {
            expect(inv.stageName).toBe(attachedStage);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


describe('Property 22: GlobalStore Delegation', () => {
  /**
   * Feature: scope-recorder-pattern
   * Property 22: GlobalStore Delegation
   * **Validates: Requirements 8.2, 8.5**
   *
   * For any Scope instance, after setValue and commit, the value SHALL be
   * retrievable from the underlying GlobalStore using the same namespace
   * and path conventions.
   */

  /**
   * Reserved JavaScript property names that can cause issues with lodash.get
   */
  const reservedNames = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'constructor',
    'caller', 'callee', 'arguments', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
  ]);

  /**
   * Arbitrary for valid path segments (non-empty strings without special chars).
   * Excludes reserved JavaScript property names.
   */
  const arbPathSegment = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !reservedNames.has(s));

  /**
   * Arbitrary for valid paths (arrays of path segments).
   */
  const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 });

  /**
   * Arbitrary for valid keys (non-empty strings).
   * Excludes reserved JavaScript property names.
   */
  const arbKey = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
    .filter(s => !reservedNames.has(s));

  /**
   * Arbitrary for pipeline IDs.
   */
  const arbPipelineId = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for stage names.
   */
  const arbStageName = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

  /**
   * Arbitrary for JSON-serializable primitive values.
   */
  const arbPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  );

  /**
   * Arbitrary for JSON-serializable values (primitives, arrays, objects).
   */
  const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    primitive: arbPrimitive,
    array: fc.array(tie('value'), { maxLength: 5 }),
    object: fc.dictionary(arbKey, tie('value'), { maxKeys: 5 }),
    value: fc.oneof(
      { weight: 3, arbitrary: tie('primitive') },
      { weight: 1, arbitrary: tie('array') },
      { weight: 1, arbitrary: tie('object') }
    )
  })).value;

  test('after commit, values are persisted to GlobalStore', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Act - write and commit
          scope.setValue(key, value);
          scope.commit();

          // Assert - value should be retrievable directly from GlobalStore
          const retrievedFromGlobalStore = globalStore.getValue(pipelineId, [], key);
          expect(retrievedFromGlobalStore).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('values can be read from GlobalStore directly using the same pipelineId', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Act - write and commit through Scope
          scope.setValue(key, value);
          scope.commit();

          // Assert - reading from GlobalStore with same pipelineId returns same value
          const fromGlobalStore = globalStore.getValue(pipelineId, [], key);
          const fromScope = scope.getValue(key);

          expect(fromGlobalStore).toEqual(fromScope);
          expect(fromGlobalStore).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('different pipelineIds have isolated namespaces (no cross-contamination)', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        arbJsonValue,
        (pipelineId1, pipelineId2, stageName, key, value1, value2) => {
          // Ensure different pipelineIds and different values to test isolation
          fc.pre(pipelineId1 !== pipelineId2);
          fc.pre(JSON.stringify(value1) !== JSON.stringify(value2));

          // Arrange - shared GlobalStore
          const globalStore = new GlobalStore();
          const scope1 = new Scope({
            pipelineId: pipelineId1,
            stageName,
            globalStore,
          });
          const scope2 = new Scope({
            pipelineId: pipelineId2,
            stageName,
            globalStore,
          });

          // Act - write different values to same path/key in different namespaces
          scope1.setValue(key, value1);
          scope1.commit();
          scope2.setValue(key, value2);
          scope2.commit();

          // Assert - GlobalStore maintains namespace isolation
          // Each pipelineId should have its own value, not affected by the other
          const fromGlobalStore1 = globalStore.getValue(pipelineId1, [], key);
          const fromGlobalStore2 = globalStore.getValue(pipelineId2, [], key);

          expect(fromGlobalStore1).toEqual(value1);
          expect(fromGlobalStore2).toEqual(value2);

          // Since we ensured values are different, they should not be equal
          // This proves namespace isolation - writing to pipelineId2 didn't overwrite pipelineId1
          expect(fromGlobalStore1).not.toEqual(fromGlobalStore2);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('namespace path construction is correct (values stored under correct path in GlobalStore)', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Act - write and commit
          scope.setValue(key, value);
          scope.commit();

          // Assert - verify the value is stored in the correct namespace structure
          // GlobalStore stores values under pipelines.<pipelineId>.<path>.<key>
          const state = globalStore.getState() as Record<string, unknown>;
          const pipelines = state.pipelines as Record<string, unknown> | undefined;

          // Verify pipelines namespace exists
          expect(pipelines).toBeDefined();

          // Verify pipelineId namespace exists
          const pipelineNamespace = pipelines?.[pipelineId] as Record<string, unknown> | undefined;
          expect(pipelineNamespace).toBeDefined();

          // Verify value is retrievable via GlobalStore API
          const retrievedValue = globalStore.getValue(pipelineId, [], key);
          expect(retrievedValue).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('multiple commits accumulate values in GlobalStore', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        fc.uniqueArray(arbKey, { minLength: 2, maxLength: 5 }),
        fc.array(arbJsonValue, { minLength: 2, maxLength: 5 }),
        (pipelineId, stageName, keys, values) => {
          // Ensure we have matching keys and values
          const pairs = keys.slice(0, Math.min(keys.length, values.length))
            .map((key, i) => ({ key, value: values[i] }));

          if (pairs.length < 2) return; // Skip if not enough unique keys

          // Arrange
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Act - write and commit multiple values
          for (const { key, value } of pairs) {
            scope.setValue(key, value);
            scope.commit();
          }

          // Assert - all values should be persisted in GlobalStore
          for (const { key, value } of pairs) {
            const fromGlobalStore = globalStore.getValue(pipelineId, [], key);
            expect(fromGlobalStore).toEqual(value);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('updateValue with commit persists merged values to GlobalStore', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        fc.dictionary(arbKey, arbPrimitive, { minKeys: 1, maxKeys: 3 }),
        fc.dictionary(arbKey, arbPrimitive, { minKeys: 1, maxKeys: 3 }),
        (pipelineId, stageName, key, obj1, obj2) => {
          // Arrange
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Act - set initial value, update with merge, then commit
          scope.setValue(key, obj1);
          scope.updateValue(key, obj2);
          scope.commit();

          // Assert - GlobalStore should have the merged value
          const fromGlobalStore = globalStore.getValue(pipelineId, [], key) as Record<string, unknown>;

          // All keys from obj1 should be present (unless overwritten by obj2)
          for (const k of Object.keys(obj1)) {
            if (!(k in obj2)) {
              expect(fromGlobalStore).toHaveProperty(k);
              expect(fromGlobalStore[k]).toEqual(obj1[k]);
            }
          }

          // All keys from obj2 should be present (with obj2 values taking precedence)
          for (const k of Object.keys(obj2)) {
            expect(fromGlobalStore).toHaveProperty(k);
            expect(fromGlobalStore[k]).toEqual(obj2[k]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('uncommitted values are NOT persisted to GlobalStore', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const scope = new Scope({
            pipelineId,
            stageName,
            globalStore,
          });

          // Act - write but do NOT commit
          scope.setValue(key, value);

          // Assert - value should NOT be in GlobalStore yet
          const fromGlobalStore = globalStore.getValue(pipelineId, [], key);
          expect(fromGlobalStore).toBeUndefined();

          // But should be readable from Scope (read-after-write consistency)
          const fromScope = scope.getValue(key);
          expect(fromScope).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('new Scope instance with same pipelineId reads committed values from GlobalStore', () => {
    fc.assert(
      fc.property(
        arbPipelineId,
        arbStageName,
        arbStageName,
        arbKey,
        arbJsonValue,
        (pipelineId, stageName1, stageName2, key, value) => {
          // Arrange
          const globalStore = new GlobalStore();
          const scope1 = new Scope({
            pipelineId,
            stageName: stageName1,
            globalStore,
          });

          // Act - write and commit with first scope
          scope1.setValue(key, value);
          scope1.commit();

          // Create a new scope with the same pipelineId but different stage
          const scope2 = new Scope({
            pipelineId,
            stageName: stageName2,
            globalStore,
          });

          // Assert - new scope should read the committed value from GlobalStore
          const fromScope2 = scope2.getValue(key);
          expect(fromScope2).toEqual(value);

          // And it should match what's in GlobalStore
          const fromGlobalStore = globalStore.getValue(pipelineId, [], key);
          expect(fromScope2).toEqual(fromGlobalStore);
        }
      ),
      { numRuns: 100 }
    );
  });
});
