/**
 * Error Samples — Input Safety
 *
 * Demonstrates the three layers of input protection in footPrint:
 *
 * A. Schema validation  — invalid input caught BEFORE any stage runs
 * B. Readonly guards     — stages cannot overwrite input keys
 * C. Frozen args         — getArgs() returns deeply frozen objects
 * D. Before/After        — why the old mutable pattern was dangerous
 *
 * Run:  npx tsx examples/errors/input-safety.ts
 * Try it: https://footprintjs.github.io/footprint-playground/samples/input-safety
 */

import { z } from 'zod';
import { flowChart,  FlowChartExecutor } from 'footprintjs';

// ─────────────────────────────────────────────────────────────────────────────
// A. Schema Validation — fail-fast at the boundary
// ─────────────────────────────────────────────────────────────────────────────

interface SchemaState {
  validated?: boolean;
}

async function demoSchemaValidation() {
  console.log('\n=== A. Schema Validation (fail-fast) ===\n');

  const chart = flowChart<SchemaState>('Process', async () => {
    // This stage should NEVER execute with invalid input
    console.log('  Stage executed — this should not happen!');
  }, 'process')
    .contract({
      input: z.object({
        amount: z.number().positive(),
        email: z.string().email(),
      }),
    })
    .build();

  const executor = new FlowChartExecutor(chart);

  // Valid input — pipeline runs normally
  try {
    await executor.run({ input: { amount: 100, email: 'alice@example.com' } });
    console.log('  Valid input accepted');
  } catch (e) {
    console.log('  Unexpected error:', (e as Error).message);
  }

  // Invalid input — caught BEFORE any stage executes
  try {
    await executor.run({ input: { amount: -50, email: 'not-an-email' } as any });
    console.log('  Should not reach here');
  } catch (e: any) {
    console.log('  Caught before execution:', e.message);
    // InputValidationError has .issues for field-level details
    if (e.issues) {
      for (const issue of e.issues) {
        console.log(`     Field "${issue.path.join('.')}": ${issue.message}`);
      }
    }
  }

  // Wrong type — caught at the boundary
  try {
    await executor.run({ input: { amount: 'not-a-number', email: 'alice@example.com' } as any });
  } catch (e: any) {
    console.log('  Type mismatch caught:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Readonly Guards — stages cannot overwrite input keys
// ─────────────────────────────────────────────────────────────────────────────

interface ReadonlyState {
  greeting?: string;
}

async function demoReadonlyGuards() {
  console.log('\n=== B. Readonly Guards (write protection) ===\n');

  const chart = flowChart<ReadonlyState>('Process', async (scope) => {
    // Read input — works fine
    const { name } = scope.$getArgs<{ name: string }>();
    console.log(`  Read input: name = "${name}"`);

    // Write to a NEW key — works fine
    scope.greeting = `Hello, ${name}!`;
    console.log(`  Write new key: greeting = "Hello, ${name}!"`);

    // Try to overwrite an INPUT key — blocked!
    try {
      scope.$setValue('name', 'HACKED');
    } catch (e: any) {
      console.log(`  Write blocked: ${e.message}`);
    }

    // Try to update an INPUT key — also blocked!
    try {
      (scope as any).$updateValue('name', 'HACKED');
    } catch (e: any) {
      console.log(`  Update blocked: ${e.message}`);
    }

    // Try to delete an INPUT key — also blocked!
    try {
      (scope as any).$deleteValue('name');
    } catch (e: any) {
      console.log(`  Delete blocked: ${e.message}`);
    }
  }, 'process').build();

  const executor = new FlowChartExecutor(chart);
  await executor.run({ input: { name: 'Alice' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Frozen Args — getArgs() returns deeply immutable objects
// ─────────────────────────────────────────────────────────────────────────────

interface FrozenState {
  checked?: boolean;
}

async function demoFrozenArgs() {
  console.log('\n=== C. Frozen Args (deep immutability) ===\n');

  const chart = flowChart<FrozenState>('Process', async (scope) => {
    const args = scope.$getArgs<{ user: { name: string; address: { city: string } } }>();

    // Reading nested values — works fine
    console.log(`  Read: user.name = "${args.user.name}"`);
    console.log(`  Read: user.address.city = "${args.user.address.city}"`);

    // Mutating top-level — throws TypeError
    try {
      (args as any).user = { name: 'HACKED' };
    } catch (e: any) {
      console.log(`  Top-level mutation blocked: ${e.message}`);
    }

    // Mutating nested — also throws (deep freeze!)
    try {
      (args.user as any).name = 'HACKED';
    } catch (e: any) {
      console.log(`  Nested mutation blocked: ${e.message}`);
    }

    // Mutating deeply nested — also throws
    try {
      (args.user.address as any).city = 'HACKED';
    } catch (e: any) {
      console.log(`  Deep nested mutation blocked: ${e.message}`);
    }

    // Same cached reference every time (zero-allocation)
    const args2 = scope.$getArgs();
    console.log(`  Cached: getArgs() === getArgs() -> ${args === args2}`);
  }, 'process').build();

  const executor = new FlowChartExecutor(chart);
  await executor.run({
    input: { user: { name: 'Alice', address: { city: 'Portland' } } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Before/After — why the old mutable pattern was dangerous
// ─────────────────────────────────────────────────────────────────────────────

interface OldState {
  done1?: boolean;
  done2?: boolean;
}

interface NewState {
  computedScore?: number;
}

async function demoBeforeAfter() {
  console.log('\n=== D. Before/After — Mutable vs Immutable Input ===\n');

  // OLD PATTERN: closure-captured mutable data
  // Each stage shares the SAME object reference — mutations leak silently
  console.log('  OLD PATTERN (dangerous):');
  const sharedData = { score: 0, name: 'Alice' };

  const oldChart = flowChart<OldState>('Stage1', async (scope) => {
    // Stage1 mutates the shared closure variable
    sharedData.score = 999;
    scope.done1 = true;
  }, 'stage-1')
    .addFunction('Stage2', async (scope) => {
      // Stage2 sees Stage1's mutation — silent data corruption!
      console.log(`    Stage2 sees score = ${sharedData.score} (corrupted by Stage1!)`);
      scope.done2 = true;
    }, 'stage-2')
    .build();

  const oldExecutor = new FlowChartExecutor(oldChart);
  await oldExecutor.run();

  // NEW PATTERN: immutable input via run({ input })
  // Each stage gets a frozen copy — mutations are impossible
  console.log('\n  NEW PATTERN (safe):');

  const newChart = flowChart<NewState>('Stage1', async (scope) => {
    const { score } = scope.$getArgs<{ score: number; name: string }>();
    console.log(`    Stage1 reads score = ${score}`);
    // Cannot mutate input — write to a SEPARATE key instead
    scope.computedScore = score + 100;
  }, 'stage-1')
    .addFunction('Stage2', async (scope) => {
      const { score } = scope.$getArgs<{ score: number; name: string }>();
      console.log(`    Stage2 reads score = ${score} (untouched — safe!)`);
      const computedScore = scope.computedScore;
      console.log(`    Stage2 reads computedScore = ${computedScore} (from Stage1)`);
    }, 'stage-2')
    .build();

  const newExecutor = new FlowChartExecutor(newChart);
  await newExecutor.run({ input: { score: 0, name: 'Alice' } });
}

// ── Run all demos ────────────────────────────────────────────────────────────

(async () => {
  await demoSchemaValidation();
  await demoReadonlyGuards();
  await demoFrozenArgs();
  await demoBeforeAfter();
  console.log('\nAll error demos complete.\n');
})();
