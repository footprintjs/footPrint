/**
 * Feature: Typed Property Access
 *
 * Demonstrates storing and reading values with TypedScope<T>:
 * - Primitives (string, number, boolean)
 * - Objects and nested objects
 * - Arrays
 * - No casts needed — everything is typed
 *
 * Run:  npm run feature:values
 * Try it: https://footprintjs.github.io/footprint-playground/samples/values
 */

import {
  flowChart,
  FlowChartExecutor,
} from 'footprintjs';

// Define state shape — one interface, used everywhere
interface AppState {
  name: string;
  age: number;
  active: boolean;
  profile: {
    email: string;
    address: { city: string; state: string };
  };
  tags: string[];
}

(async () => {

const chart = flowChart<AppState>('SetValues', async (scope) => {
  // Primitives — typed, no casts
  scope.name = 'Alice';
  scope.age = 30;
  scope.active = true;

  // Object
  scope.profile = {
    email: 'alice@example.com',
    address: { city: 'Portland', state: 'OR' },
  };

  // Array
  scope.tags = ['admin', 'verified'];
}, 'set-values')
  .addFunction('ReadValues', async (scope) => {
    // All reads are typed — no `as string` needed
    console.log('Primitives:', { name: scope.name, age: scope.age, active: scope.active });
    console.log('Object:', scope.profile);
    console.log('Nested:', scope.profile.address.city);
    console.log('Array:', scope.tags);
  }, 'read-values')
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run();

console.log('\nAll value types work with typed property access.');
})().catch(console.error);
