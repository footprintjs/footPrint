/**
 * Enable exact run evidence.
 *
 * @module footprintjs/explain
 */
import type { FlowChartExecutorOptions } from './lib/runner/options.js';
import { subflowCapture } from './subflow-capture.js';

const evidenceDefaults = {
  readTracking: 'full',
  writeProvenance: 'reads-prefix',
  nestedReadTracking: true,
  captureOutputHandoff: true,
  readSources: true,
  captureCoverage: true,
} as const satisfies FlowChartExecutorOptions;

const handoffOptions = [
  ['input', 'captureInputHandoff'],
  ['fanout', 'captureFanoutHandoff'],
] as const;

/**
 * Leave the host's options alone when disabled. When enabled, fill the missing bounded
 * evidence settings. Explicit host modes, limits and local capabilities take precedence.
 * Set redaction and storage as usual. The handoff capability stays in this engine instance.
 */
export function explain<TScope = any>(
  on: boolean,
  hostOptions: FlowChartExecutorOptions<TScope> = {},
): FlowChartExecutorOptions<TScope> {
  if (!on) return hostOptions;
  if (hostOptions.captureCoverage === false) throw new TypeError('explain(true) requires captureCoverage: true');

  // Preserve the executor's normal admission rules, including its checks for accessors
  // and non-enumerable settings. A spread could read a getter or erase an option.
  const slots: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(hostOptions);
  for (const [key, value] of Object.entries(evidenceDefaults)) {
    const slot = slots[key];
    if (slot ? Object.hasOwn(slot, 'value') && slot.value === undefined : !Reflect.has(hostOptions, key)) {
      slots[key] = { value, enumerable: true, configurable: true, writable: true };
    }
  }

  const token = slots.subflowCapture;
  if (
    !Reflect.has(hostOptions, 'subflowCapture') ||
    (token && Object.hasOwn(token, 'value') && token.value === undefined)
  ) {
    const selection = { input: true, fanout: true };
    for (const [kind, key] of handoffOptions) {
      if (!Reflect.has(hostOptions, key)) continue;
      const slot = slots[key];
      if (!slot || !Object.hasOwn(slot, 'value') || (slot.value !== undefined && typeof slot.value !== 'boolean')) {
        throw new TypeError('Invalid subflow capture configuration');
      }
      selection[kind] = slot.value ?? true;
    }
    const capability = subflowCapture(selection);
    for (const [key, value] of Object.entries(capability)) {
      // An input or fanout mode can be explicit even when the token is supplied here.
      if (slots[key]?.value === undefined) {
        slots[key] = { value, enumerable: true, configurable: true, writable: true };
      }
    }
  }

  return Object.create(Object.getPrototypeOf(hostOptions), slots);
}
