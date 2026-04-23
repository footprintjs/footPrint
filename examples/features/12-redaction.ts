/**
 * Feature: PII Redaction
 *
 * RedactionPolicy — declarative, config-driven PII protection.
 * Define once at the executor level; covers keys, regex patterns,
 * and field-level scrubbing. Recorders see [REDACTED], runtime gets real values.
 *
 * Run:  npm run feature:redaction
 * Try it: https://footprintjs.github.io/footprint-playground/samples/redaction
 */

import {
  flowChart,
  FlowChartExecutor,
} from 'footprintjs';

// ── State ──────────────────────────────────────────────────────────────

interface RegistrationState {
  ssn: string;
  email: string;
  dbPassword: string;
  authToken: string;
  patient: {
    name: string;
    ssn: string;
    dob: string;
    bloodType: string;
    address: { street: string; city: string; zip: string };
  };
  verified?: boolean;
}

(async () => {

  console.log('=== RedactionPolicy (Config-Driven) ===\n');

  const chart = flowChart<RegistrationState>('Register', async (scope) => {
    scope.ssn = '999-88-7777';
    scope.email = 'alice@example.com';
    scope.dbPassword = 'hunter2';
    scope.authToken = 'bearer-xyz-789';
    scope.patient = {
      name: 'Alice Johnson',
      ssn: '999-88-7777',
      dob: '1990-05-15',
      bloodType: 'O+',
      address: { street: '123 Main St', city: 'LA', zip: '90210' },
    };
  }, 'register')
    .addFunction('Process', async (scope) => {
      // Runtime gets real values — business logic works normally
      scope.verified = scope.ssn.length > 0 && scope.patient.name !== undefined;
    }, 'process')

    .build();

  const executor = new FlowChartExecutor(chart);

  // One config, three dimensions:
  executor.setRedactionPolicy({
    keys: ['ssn'],                                // exact key match
    patterns: [/password|token|secret/i],          // regex pattern match
    fields: { patient: ['ssn', 'dob', 'address.zip'] }, // nested field scrubbing
  });

  executor.enableNarrative();
  await executor.run();

  console.log('Narrative (policy auto-redacts):');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  // Audit trail — compliance-friendly, never includes values
  const report = executor.getRedactionReport();
  console.log('\nRedaction Report (audit trail):');
  console.log(`  Redacted keys: ${report.redactedKeys.join(', ')}`);
  console.log(`  Field redactions: ${JSON.stringify(report.fieldRedactions)}`);
  console.log(`  Patterns: ${report.patterns.join(', ')}`);

  console.log('\n  Key insight: zero per-call flags. One policy config');
  console.log('  covers exact keys, regex patterns, and field-level scrubbing.');

})().catch(console.error);
