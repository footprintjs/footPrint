/**
 * Property-based tests for scope access protection.
 * Uses fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import { createProtectedScope, createErrorMessage } from '../../src/scope/protection/createProtectedScope';

/**
 * **Feature: scope-access-protection, Property 1: Direct Assignment Interception**
 *
 * *For any* property name and any value, when a direct property assignment is
 * attempted on a protected scope in 'error' mode, the assignment SHALL be
 * intercepted and an error SHALL be thrown.
 *
 * **Validates: Requirements 1.1, 1.2**
 */
describe('Scope Access Protection Property Tests', () => {
  // Built-in property names that exist on all objects and should be excluded
  const builtInProps = new Set([
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'constructor',
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ]);

  // Arbitrary for valid property names (non-empty strings, valid JS identifiers, excluding built-ins)
  const propertyNameArb = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
    .filter((s) => !builtInProps.has(s));

  // Arbitrary for stage names
  const stageNameArb = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => s.trim().length > 0);

  // Arbitrary for any assignable value
  const valueArb = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.integer()),
    fc.dictionary(fc.string(), fc.integer()),
  );

  describe('Property 1: Direct Assignment Interception', () => {
    it('should throw an error when assigning any property in error mode', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = { existingProp: 'test' };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorThrown = false;
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorThrown = true;
          }

          return errorThrown;
        }),
        { numRuns: 100 },
      );
    });

    it('should intercept assignment to existing properties', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, valueArb, stageNameArb, (propName, initialValue, newValue, stageName) => {
          const rawScope = { [propName]: initialValue };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorThrown = false;
          try {
            (protectedScope as any)[propName] = newValue;
          } catch (e) {
            errorThrown = true;
          }

          // Should throw AND original value should be unchanged
          return errorThrown && rawScope[propName] === initialValue;
        }),
        { numRuns: 100 },
      );
    });

    it('should intercept assignment to new properties', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorThrown = false;
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorThrown = true;
          }

          // Should throw AND property should not exist on raw scope
          return errorThrown && !(propName in rawScope);
        }),
        { numRuns: 100 },
      );
    });

    it('should use error mode by default when mode is not specified', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, (propName, value) => {
          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            stageName: 'testStage',
            // mode not specified - should default to 'error'
          });

          let errorThrown = false;
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorThrown = true;
          }

          return errorThrown;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: scope-access-protection, Property 2: Error Message Contains Property Name**
   *
   * *For any* property name that triggers an assignment error, the error message
   * SHALL contain that property name.
   *
   * **Validates: Requirements 1.3, 4.1**
   */
  describe('Property 2: Error Message Contains Property Name', () => {
    it('should include property name in error message', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorMessage = '';
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorMessage = (e as Error).message;
          }

          return errorMessage.includes(propName);
        }),
        { numRuns: 100 },
      );
    });

    it('should include stage name in error message', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorMessage = '';
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorMessage = (e as Error).message;
          }

          return errorMessage.includes(stageName);
        }),
        { numRuns: 100 },
      );
    });

    it('should include correct usage guidance in error message', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorMessage = '';
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorMessage = (e as Error).message;
          }

          // Should include guidance about correct methods
          const hasSetObject = errorMessage.includes('setObject');
          const hasSetValue = errorMessage.includes('setValue');

          return hasSetObject && hasSetValue;
        }),
        { numRuns: 100 },
      );
    });

    it('should produce consistent error messages via createErrorMessage helper', () => {
      fc.assert(
        fc.property(propertyNameArb, stageNameArb, (propName, stageName) => {
          const expectedMessage = createErrorMessage(propName, stageName);

          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let actualMessage = '';
          try {
            (protectedScope as any)[propName] = 'test';
          } catch (e) {
            actualMessage = (e as Error).message;
          }

          return actualMessage === expectedMessage;
        }),
        { numRuns: 100 },
      );
    });
  });


  /**
   * **Feature: scope-access-protection, Property 3: Read Operations Pass Through**
   *
   * *For any* property that exists on the underlying scope object, reading that
   * property through the protected proxy SHALL return the same value as reading
   * it directly from the underlying object.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  describe('Property 3: Read Operations Pass Through', () => {
    it('should return same value when reading existing properties', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = { [propName]: value };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          const readValue = (protectedScope as any)[propName];
          return readValue === value;
        }),
        { numRuns: 100 },
      );
    });

    it('should return undefined for non-existent properties', () => {
      fc.assert(
        fc.property(propertyNameArb, stageNameArb, (propName, stageName) => {
          const rawScope = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          const readValue = (protectedScope as any)[propName];
          return readValue === undefined;
        }),
        { numRuns: 100 },
      );
    });

    it('should allow reading multiple properties without errors', () => {
      fc.assert(
        fc.property(
          fc.dictionary(propertyNameArb, valueArb, { minKeys: 1, maxKeys: 10 }),
          stageNameArb,
          (props, stageName) => {
            const rawScope = { ...props };
            const protectedScope = createProtectedScope(rawScope, {
              mode: 'error',
              stageName,
            });

            // Read all properties and verify they match
            for (const [key, expectedValue] of Object.entries(props)) {
              const readValue = (protectedScope as any)[key];
              if (readValue !== expectedValue) {
                return false;
              }
            }
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: scope-access-protection, Property 4: Method Calls Work Normally**
   *
   * *For any* method on the underlying scope object, calling that method through
   * the protected proxy SHALL produce the same result as calling it directly on
   * the underlying object.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  describe('Property 4: Method Calls Work Normally', () => {
    it('should allow calling methods on the scope', () => {
      fc.assert(
        fc.property(fc.integer(), fc.integer(), stageNameArb, (a, b, stageName) => {
          const rawScope = {
            add: (x: number, y: number) => x + y,
            multiply: (x: number, y: number) => x * y,
          };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          const addResult = protectedScope.add(a, b);
          const multiplyResult = protectedScope.multiply(a, b);

          return addResult === a + b && multiplyResult === a * b;
        }),
        { numRuns: 100 },
      );
    });

    it('should preserve method context (this binding)', () => {
      fc.assert(
        fc.property(valueArb, stageNameArb, (value, stageName) => {
          const rawScope = {
            data: value,
            getData() {
              return this.data;
            },
          };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          const result = protectedScope.getData();
          return result === value;
        }),
        { numRuns: 100 },
      );
    });

    it('should allow calling setObject and setValue methods', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          // Mock scope with setObject and setValue methods
          const store: Record<string, any> = {};
          const rawScope = {
            setObject: (path: string[], key: string, val: any) => {
              store[key] = val;
            },
            setValue: (key: string, val: any) => {
              store[key] = val;
            },
            getValue: (key: string) => store[key],
          };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          // These should work without throwing
          protectedScope.setObject([], propName, value);
          const retrieved = protectedScope.getValue(propName);

          return retrieved === value;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: scope-access-protection, Property 6: Warn Mode Allows Assignment**
   *
   * *For any* property assignment in 'warn' mode, the assignment SHALL succeed
   * (value is set) AND a warning SHALL be logged.
   *
   * **Validates: Requirements 5.1**
   */
  describe('Property 6: Warn Mode Allows Assignment', () => {
    it('should allow assignment and log warning in warn mode', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const warnings: string[] = [];
          const rawScope: Record<string, any> = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'warn',
            stageName,
            logger: (msg) => warnings.push(msg),
          });

          // Should not throw
          let errorThrown = false;
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorThrown = true;
          }

          // Assignment should succeed
          const valueSet = rawScope[propName] === value;
          // Warning should be logged
          const warningLogged = warnings.length === 1;
          // Warning should contain property name
          const warningContainsPropName = warnings[0]?.includes(propName) ?? false;

          return !errorThrown && valueSet && warningLogged && warningContainsPropName;
        }),
        { numRuns: 100 },
      );
    });

    it('should log warning with stage name in warn mode', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const warnings: string[] = [];
          const rawScope: Record<string, any> = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'warn',
            stageName,
            logger: (msg) => warnings.push(msg),
          });

          (protectedScope as any)[propName] = value;

          return warnings[0]?.includes(stageName) ?? false;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: scope-access-protection, Property 7: Off Mode No Interception**
   *
   * *For any* property assignment in 'off' mode, the assignment SHALL succeed
   * without any interception, warning, or error.
   *
   * **Validates: Requirements 5.2**
   */
  describe('Property 7: Off Mode No Interception', () => {
    it('should allow assignment without any interception in off mode', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const warnings: string[] = [];
          const rawScope: Record<string, any> = {};
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'off',
            stageName,
            logger: (msg) => warnings.push(msg),
          });

          // Should not throw
          let errorThrown = false;
          try {
            (protectedScope as any)[propName] = value;
          } catch (e) {
            errorThrown = true;
          }

          // Assignment should succeed
          const valueSet = rawScope[propName] === value;
          // No warning should be logged
          const noWarning = warnings.length === 0;

          return !errorThrown && valueSet && noWarning;
        }),
        { numRuns: 100 },
      );
    });

    it('should return the original scope object in off mode', () => {
      fc.assert(
        fc.property(stageNameArb, (stageName) => {
          const rawScope = { existingProp: 'test' };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'off',
            stageName,
          });

          // In off mode, should return the exact same object
          return protectedScope === rawScope;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: scope-access-protection, Property 8: Class Property Interception**
   *
   * *For any* scope object that is a class instance with writable properties,
   * direct assignment to those properties SHALL still be intercepted in 'error' mode.
   *
   * **Validates: Requirements 6.1**
   */
  describe('Property 8: Class Property Interception', () => {
    // Test class with writable properties - uses internal store to avoid proxy interception
    class TestScope {
      public data: any;
      public config: Record<string, any> = {};
      private _store: Map<string, any> = new Map();

      constructor(initialData?: any) {
        this.data = initialData;
      }

      // Methods that use internal storage (not direct property assignment)
      setStoreValue(key: string, value: any) {
        this._store.set(key, value);
      }

      getStoreValue(key: string) {
        return this._store.get(key);
      }

      getData() {
        return this.data;
      }
    }

    it('should intercept assignment to class instance properties', () => {
      fc.assert(
        fc.property(valueArb, stageNameArb, (value, stageName) => {
          const rawScope = new TestScope('initial');
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorThrown = false;
          try {
            protectedScope.data = value;
          } catch (e) {
            errorThrown = true;
          }

          // Should throw AND original value should be unchanged
          return errorThrown && rawScope.data === 'initial';
        }),
        { numRuns: 100 },
      );
    });

    it('should allow method calls on class instances that use internal storage', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (key, value, stageName) => {
          const rawScope = new TestScope('initial');
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          // Method calls that use internal storage should work
          protectedScope.setStoreValue(key, value);
          const retrieved = protectedScope.getStoreValue(key);

          return retrieved === value;
        }),
        { numRuns: 100 },
      );
    });

    it('should allow reading class instance properties', () => {
      fc.assert(
        fc.property(valueArb, stageNameArb, (initialValue, stageName) => {
          const rawScope = new TestScope(initialValue);
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          // Reading should work
          const retrieved = protectedScope.getData();
          return retrieved === initialValue;
        }),
        { numRuns: 100 },
      );
    });

    it('should intercept assignment to nested object properties on class', () => {
      fc.assert(
        fc.property(propertyNameArb, valueArb, stageNameArb, (propName, value, stageName) => {
          const rawScope = new TestScope();
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          let errorThrown = false;
          try {
            protectedScope.config = { [propName]: value };
          } catch (e) {
            errorThrown = true;
          }

          return errorThrown;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: scope-access-protection, Property 5: Transparent Wrapping**
   *
   * *For any* scope object and any sequence of read operations and method calls
   * (no direct assignments), the protected proxy SHALL behave identically to
   * the unwrapped scope.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  describe('Property 5: Transparent Wrapping', () => {
    it('should behave identically for read-only operations', () => {
      fc.assert(
        fc.property(
          fc.dictionary(propertyNameArb, valueArb, { minKeys: 1, maxKeys: 5 }),
          stageNameArb,
          (props, stageName) => {
            const rawScope = {
              ...props,
              getKeys: function () {
                return Object.keys(this).filter((k) => k !== 'getKeys');
              },
            };
            const protectedScope = createProtectedScope(rawScope, {
              mode: 'error',
              stageName,
            });

            // Compare read operations
            for (const key of Object.keys(props)) {
              if ((protectedScope as any)[key] !== (rawScope as any)[key]) {
                return false;
              }
            }

            // Compare method call results
            const rawKeys = rawScope.getKeys();
            const protectedKeys = protectedScope.getKeys();
            if (rawKeys.length !== protectedKeys.length) {
              return false;
            }

            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should preserve object identity checks for methods', () => {
      fc.assert(
        fc.property(stageNameArb, (stageName) => {
          const rawScope = {
            getSelf: function () {
              return this;
            },
          };
          const protectedScope = createProtectedScope(rawScope, {
            mode: 'error',
            stageName,
          });

          // When calling getSelf through proxy, 'this' should be the proxy
          const selfFromProxy = protectedScope.getSelf();
          return selfFromProxy === protectedScope;
        }),
        { numRuns: 100 },
      );
    });
  });
});
