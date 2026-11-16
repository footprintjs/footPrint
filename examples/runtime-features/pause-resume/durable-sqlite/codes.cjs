'use strict';

// Fixed, value-free error data. An error author's chosen text is never public.
const CODES = Object.freeze([
  'EXAMPLE_OPERATION_FAILED', 'UNEXPECTED_ARTIFACT_SYMLINK', 'UNSUPPORTED_EXAMPLE_MODE',
  'LOCKED_RUNTIME_MISSING', 'LOCKED_RUNTIME_MISMATCH', 'SDK_ARTIFACT_MISSING',
  'INVALID_PRIVATE_PATH', 'PRIVATE_DATABASE_MISSING', 'CHECKPOINT_BOUNDS', 'CHECKPOINT_JSON',
  'CHECKPOINT_DIGEST', 'CHECKPOINT_BINDING', 'INPUT_BOUNDS', 'INPUT_JSON', 'INPUT_SHAPE',
  'EFFECT_BOUNDS', 'OWNED_GATE_TIMEOUT', 'TAMPER_FIXTURE_MISSING', 'TAMPER_CASE_UNSUPPORTED',
  'EFFECT_BEFORE_PUBLICATION', 'NATIVE_PAUSE_MISSING', 'NATIVE_PAUSE_REFERENCE_MISSING',
  'NATIVE_RESUME_FAILED', 'NATIVE_RUN_ID_REUSED', 'NATIVE_PAUSE_LINK_MISSING',
  'CONTINUATION_MISSING', 'NATIVE_FAILURE_REFERENCE_MISSING', 'OPERATION_UNSUPPORTED',
  'NATIVE_OUTCOME_UNSUPPORTED', 'NATIVE_REFERENCE_UNSUPPORTED', 'BUILT_ENTRY_MISMATCH',
  'PUBLIC_OUTPUT_REFUSED', 'SCENARIO_BUDGET_EXPIRED', 'OWNED_CHILD_TIMEOUT',
  'CHILD_OUTPUT_BOUNDS', 'OWNED_CHILD_START_FAILED', 'OWNED_CHILD_EXIT_MISMATCH',
  'PRIVATE_OUTPUT_REFUSED', 'CHILD_RESULT_JSON', 'CHILD_RESULT_SHAPE',
]);

const isSafeCode = (value) => typeof value === 'string' && CODES.includes(value);

function safeFailure(error) {
  try {
    const descriptor = error && Object.getOwnPropertyDescriptor(error, 'safeCode');
    if (descriptor && Object.hasOwn(descriptor, 'value') && isSafeCode(descriptor.value)) return descriptor.value;
  } catch { /* Proxy traps are author work, not a sandbox; no trapped value is served. */ }
  return 'EXAMPLE_OPERATION_FAILED';
}

module.exports = { isSafeCode, safeFailure };
