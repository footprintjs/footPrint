/**
 * Error Samples — Structured Error Flow
 *
 * Demonstrates how InputValidationError preserves field-level details
 * through the FlowRecorder pipeline — no string flattening.
 *
 * Shows three patterns:
 * A. Custom FlowRecorder receiving structuredError with field-level issues
 * B. Narrative enrichment — error sentences include validation details
 * C. Using extractErrorInfo/formatErrorInfo utilities directly
 *
 * Run:  npx tsx examples/errors/structured-error-flow.ts
 * Try it: https://footprintjs.github.io/footprint-playground/samples/structured-errors
 */

import { z } from 'zod';
import {
  flowChart,
  
  FlowChartExecutor,
  InputValidationError,
  extractErrorInfo,
  formatErrorInfo,
} from 'footprintjs';
import type { FlowRecorder, FlowErrorEvent } from 'footprintjs';

// ─────────────────────────────────────────────────────────────────────────────
// A. Custom FlowRecorder with structured error observation
// ─────────────────────────────────────────────────────────────────────────────

interface OrderState {
  rawOrder: { customerId: string; items: string[]; total: number };
}

async function demoStructuredErrorRecorder() {
  console.log('\n=== A. Custom FlowRecorder — Structured Error Observation ===\n');

  // Build a pipeline that validates user input
  const chart = flowChart<OrderState>('ReceiveOrder', async (scope) => {
    scope.rawOrder = { customerId: 'C1', items: ['laptop'], total: -50 };
  }, 'receive-order')
    .addFunction('ValidateOrder', async (scope) => {
      const order = scope.rawOrder;

      // Simulate a Zod-like validation producing an InputValidationError
      const issues = [];
      if (order.total < 0) {
        issues.push({ path: ['total'], message: 'Must be a positive number', code: 'too_small' });
      }
      if (!(order as any).email) {
        issues.push({
          path: ['email'],
          message: 'Required',
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
        });
      }
      if (issues.length > 0) {
        throw new InputValidationError('Order validation failed', issues);
      }
    }, 'validate-order')
    .addFunction('ProcessPayment', async () => 'paid', 'process-payment')
    .build();

  // Custom recorder that extracts structured error details
  const errorLog: { stage: string; fields: string[] }[] = [];

  const errorObserver: FlowRecorder = {
    id: 'error-observer',
    onError(event: FlowErrorEvent) {
      console.log(`  Error at stage: ${event.stageName}`);
      console.log(`  Message: ${event.message}`);

      console.log(`  Error type: ${event.structuredError.name}`);
      console.log(`  Error code: ${event.structuredError.code}`);

      if (event.structuredError.issues) {
        console.log(`  Field-level issues (${event.structuredError.issues.length}):`);
        const fields: string[] = [];
        for (const issue of event.structuredError.issues) {
          const path = issue.path.join('.');
          console.log(`    - ${path}: ${issue.message} [${issue.code}]`);
          fields.push(path);
        }
        errorLog.push({ stage: event.traversalContext?.stageId ?? event.stageName, fields });
      }
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(errorObserver);

  try {
    await executor.run();
  } catch {
    // Expected — validation fails
  }

  console.log('\n  Programmatic access to error log:');
  console.log(`  ${JSON.stringify(errorLog, null, 2)}`);
  // Output: [{ stage: "ValidateOrder", fields: ["total", "email"] }]
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Narrative enrichment — validation issues in the story
// ─────────────────────────────────────────────────────────────────────────────

interface NarrativeState {
  payload: { name: string; age: number; email: string };
}

async function demoNarrativeEnrichment() {
  console.log('\n=== B. Narrative Enrichment — Validation Issues in the Story ===\n');

  const chart = flowChart<NarrativeState>('FetchData', async (scope) => {
    scope.payload = { name: 'Bob', age: -5, email: '' };
  }, 'fetch-data')
    .addFunction('Validate', async (scope) => {
      const payload = scope.payload;
      throw new InputValidationError('Validation failed', [
        { path: ['age'], message: 'Must be positive', code: 'too_small' },
        { path: ['email'], message: 'Cannot be empty', code: 'too_small' },
      ]);
    }, 'validate')
    .addFunction('Transform', async () => 'transformed', 'transform')

    .build();

  const executor = new FlowChartExecutor(chart);

  try {
    await executor.run();
  } catch {
    // Expected
  }

  // getNarrative() automatically includes field-level validation details
  console.log('  Combined narrative:');
  for (const line of executor.getNarrativeEntries().map(e => e.text)) {
    console.log(`    ${line}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Using extractErrorInfo / formatErrorInfo directly
// ─────────────────────────────────────────────────────────────────────────────

async function demoUtilities() {
  console.log('\n=== C. extractErrorInfo / formatErrorInfo Utilities ===\n');

  // InputValidationError
  const validationError = new InputValidationError('Form invalid', [
    { path: ['email'], message: 'Required', code: 'invalid_type' },
    { path: ['password'], message: 'Must be at least 8 characters', code: 'too_small' },
  ]);

  const info1 = extractErrorInfo(validationError);
  console.log('  InputValidationError:');
  console.log(`    name: ${info1.name}`);
  console.log(`    code: ${info1.code}`);
  console.log(`    issues: ${info1.issues?.length}`);
  console.log(`    formatted:\n${formatErrorInfo(info1).split('\n').map(l => `      ${l}`).join('\n')}`);

  // Standard Error
  const standardError = new TypeError('Cannot read property of undefined');
  const info2 = extractErrorInfo(standardError);
  console.log('\n  TypeError:');
  console.log(`    name: ${info2.name}`);
  console.log(`    formatted: ${formatErrorInfo(info2)}`);

  // Node.js-style error with .code
  const nodeError = new Error('File not found') as Error & { code: string };
  nodeError.code = 'ENOENT';
  const info3 = extractErrorInfo(nodeError);
  console.log('\n  Node.js Error:');
  console.log(`    name: ${info3.name}`);
  console.log(`    code: ${info3.code}`);
  console.log(`    formatted: ${formatErrorInfo(info3)}`);

  // Non-Error thrown value
  const info4 = extractErrorInfo('raw string error');
  console.log('\n  String thrown:');
  console.log(`    message: ${info4.message}`);
  console.log(`    name: ${info4.name ?? '(none)'}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all demos
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Structured Error Flow — Preserving field-level details');
  console.log('═══════════════════════════════════════════════════════════');

  await demoStructuredErrorRecorder();
  await demoNarrativeEnrichment();
  await demoUtilities();

  console.log('\nAll demos complete.\n');
}

main().catch(console.error);
