/**
 * Native input/fanout observations. This is an optional public door; import it explicitly.
 * Default engine doors do not load its backend.
 *
 * Spread the returned options into a same-module-instance FlowChartExecutor. CJS/ESM instance mixes,
 * forged/serialized tokens and capture configuration on detach transports refuse before setup effects.
 * Released captureOutputHandoff remains independent and needs no factory.
 * These bounded value-free observations never attest complete capture or semantic causation.
 *
 * @module footprintjs/subflow-capture
 */
import { registerSubflowCapture } from './lib/capture/subflowCapability.js';
import { createSubflowCaptureBackend } from './lib/engine/handlers/handoff.js';

/** Configure only input/fanout booleans as own plain data; no user callbacks or accessors are accepted. */
export function subflowCapture(options: { readonly input?: boolean; readonly fanout?: boolean } = {}): Readonly<{
  captureInputHandoff: boolean;
  captureFanoutHandoff: boolean;
  subflowCapture: object;
}> {
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
    throw new TypeError('Invalid subflow capture configuration');
  const selected = { input: false, fanout: false };
  for (const key of Reflect.ownKeys(options)) {
    const slot = Object.getOwnPropertyDescriptor(options, key)!;
    if ((key !== 'input' && key !== 'fanout') || !Object.hasOwn(slot, 'value') || typeof slot.value !== 'boolean')
      throw new TypeError('Invalid subflow capture configuration');
    selected[key] = slot.value;
  }
  for (const key of ['input', 'fanout'])
    if (Reflect.has(options, key) && !Object.hasOwn(options, key))
      throw new TypeError('Invalid subflow capture configuration');
  return registerSubflowCapture(createSubflowCaptureBackend(selected));
}
