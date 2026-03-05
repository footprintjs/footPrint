/**
 * Property-Based Tests for Demo 1: Linear Flow (Payment Domain)
 *
 * PROPERTY: Scope State Round-Trip
 * For any key-value pair written to scope in stage N, reading that key
 * in any subsequent stage M (where M > N) SHALL return the same value.
 *
 * **Validates: Requirements 1.2**
 *
 * WHY: This property ensures the fundamental contract of scope operations:
 * data written by one stage is reliably available to subsequent stages.
 * If this property fails, the entire pipeline state-sharing model is broken.
 *
 * COUNTEREXAMPLE MEANING: If this test fails, it means scope values are
 * being lost, corrupted, or overwritten unexpectedly between stages.
 */

import * as fc from 'fast-check';
import { FlowChartBuilder, BaseState, StageContext } from 'footprint';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a scope factory for property testing.
 */
function createPropertyTestScopeFactory() {
  return (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    return new BaseState(ctx, stageName, readOnly);
  };
}

/**
 * Generates valid scope keys (non-empty strings without special characters).
 *
 * WHY: Scope keys should be simple identifiers. We constrain the generator
 * to produce realistic keys that would be used in production.
 */
const scopeKeyArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => {
  // Filter out keys with special characters that might cause issues
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s);
});

/**
 * Generates valid scope values (JSON-serializable primitives and objects).
 *
 * WHY: Scope values must be serializable. We test with various types
 * to ensure the round-trip works for all supported value types.
 */
const scopeValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string(), { maxLength: 10 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string(), { maxKeys: 5 }),
);

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 1: Scope State Round-Trip', () => {
  /**
   * PROPERTY: Single value round-trip
   *
   * For any key K and value V, if stage 1 writes V to K,
   * then stage 2 reading K should return V.
   *
   * **Validates: Requirements 1.2**
   */
  it('should preserve value written in stage 1 when read in stage 2', async () => {
    await fc.assert(
      fc.asyncProperty(scopeKeyArb, scopeValueArb, async (key, value) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        let readValue: unknown;

        const writeStage = async (scope: BaseState) => {
          scope.setValue(key, value);
          return { written: true };
        };

        const readStage = async (scope: BaseState) => {
          readValue = scope.getValue(key);
          return { read: true };
        };

        const builder = new FlowChartBuilder()
          .start('WriteStage', writeStage)
          .addFunction('ReadStage', readStage);

        // Act
        await builder.execute(scopeFactory);

        // Assert - values should be equal (deep equality for objects)
        return JSON.stringify(readValue) === JSON.stringify(value);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Multiple values round-trip
   *
   * For any set of key-value pairs written in stage 1,
   * all values should be readable in stage 2.
   *
   * **Validates: Requirements 1.2**
   */
  it('should preserve multiple values written in stage 1 when read in stage 2', async () => {
    // Generate 1-5 unique key-value pairs
    const keyValuePairsArb = fc
      .array(fc.tuple(scopeKeyArb, scopeValueArb), { minLength: 1, maxLength: 5 })
      .map((pairs) => {
        // Ensure unique keys
        const seen = new Set<string>();
        return pairs.filter(([key]) => {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })
      .filter((pairs) => pairs.length > 0);

    await fc.assert(
      fc.asyncProperty(keyValuePairsArb, async (pairs) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const readValues: Map<string, unknown> = new Map();

        const writeStage = async (scope: BaseState) => {
          for (const [key, value] of pairs) {
            scope.setValue(key, value);
          }
          return { written: pairs.length };
        };

        const readStage = async (scope: BaseState) => {
          for (const [key] of pairs) {
            readValues.set(key, scope.getValue(key));
          }
          return { read: pairs.length };
        };

        const builder = new FlowChartBuilder()
          .start('WriteStage', writeStage)
          .addFunction('ReadStage', readStage);

        // Act
        await builder.execute(scopeFactory);

        // Assert - all values should match
        for (const [key, expectedValue] of pairs) {
          const actualValue = readValues.get(key);
          if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Value persistence across multiple stages
   *
   * For any value V written in stage 1, reading V in stages 2, 3, and 4
   * should all return the same value.
   *
   * **Validates: Requirements 1.2**
   */
  it('should preserve value across multiple subsequent stages', async () => {
    await fc.assert(
      fc.asyncProperty(scopeKeyArb, scopeValueArb, async (key, value) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        const readValues: unknown[] = [];

        const writeStage = async (scope: BaseState) => {
          scope.setValue(key, value);
          return { written: true };
        };

        const readStage = (stageNum: number) => async (scope: BaseState) => {
          readValues.push(scope.getValue(key));
          return { stage: stageNum };
        };

        const builder = new FlowChartBuilder()
          .start('WriteStage', writeStage)
          .addFunction('ReadStage2', readStage(2))
          .addFunction('ReadStage3', readStage(3))
          .addFunction('ReadStage4', readStage(4));

        // Act
        await builder.execute(scopeFactory);

        // Assert - all reads should return the same value
        const expectedJson = JSON.stringify(value);
        return readValues.every((v) => JSON.stringify(v) === expectedJson);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Later writes override earlier writes
   *
   * If stage 1 writes V1 to key K, and stage 2 writes V2 to key K,
   * then stage 3 reading K should return V2.
   *
   * **Validates: Requirements 1.2**
   */
  it('should return latest value when key is overwritten', async () => {
    await fc.assert(
      fc.asyncProperty(scopeKeyArb, scopeValueArb, scopeValueArb, async (key, value1, value2) => {
        // Skip if values are the same (can't distinguish override)
        if (JSON.stringify(value1) === JSON.stringify(value2)) {
          return true;
        }

        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        let readValue: unknown;

        const writeStage1 = async (scope: BaseState) => {
          scope.setValue(key, value1);
          return { written: 1 };
        };

        const writeStage2 = async (scope: BaseState) => {
          scope.setValue(key, value2);
          return { written: 2 };
        };

        const readStage = async (scope: BaseState) => {
          readValue = scope.getValue(key);
          return { read: true };
        };

        const builder = new FlowChartBuilder()
          .start('WriteStage1', writeStage1)
          .addFunction('WriteStage2', writeStage2)
          .addFunction('ReadStage', readStage);

        // Act
        await builder.execute(scopeFactory);

        // Assert - should return the later value (value2)
        return JSON.stringify(readValue) === JSON.stringify(value2);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Independent keys don't interfere
   *
   * Writing to key K1 should not affect the value at key K2.
   *
   * **Validates: Requirements 1.2**
   */
  it('should not interfere between independent keys', async () => {
    // Generate two different keys
    const twoKeysArb = fc
      .tuple(scopeKeyArb, scopeKeyArb)
      .filter(([k1, k2]) => k1 !== k2);

    await fc.assert(
      fc.asyncProperty(twoKeysArb, scopeValueArb, scopeValueArb, async ([key1, key2], value1, value2) => {
        // Arrange
        const scopeFactory = createPropertyTestScopeFactory();
        let readValue1: unknown;
        let readValue2: unknown;

        const writeStage = async (scope: BaseState) => {
          scope.setValue(key1, value1);
          scope.setValue(key2, value2);
          return { written: 2 };
        };

        const readStage = async (scope: BaseState) => {
          readValue1 = scope.getValue(key1);
          readValue2 = scope.getValue(key2);
          return { read: 2 };
        };

        const builder = new FlowChartBuilder()
          .start('WriteStage', writeStage)
          .addFunction('ReadStage', readStage);

        // Act
        await builder.execute(scopeFactory);

        // Assert - each key should have its own value
        return (
          JSON.stringify(readValue1) === JSON.stringify(value1) &&
          JSON.stringify(readValue2) === JSON.stringify(value2)
        );
      }),
      { numRuns: 100 },
    );
  });
});
