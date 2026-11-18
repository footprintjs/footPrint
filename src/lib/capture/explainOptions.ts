import type { ExplainCaptureFactory } from './explainCoverage.js';

/** Same-instance opt-in to an optional backend. Ordinary executor imports never load it. */
const enabled = new WeakMap<object, ExplainCaptureFactory>();

export function markExplainOptions<T extends object>(options: T, factory: ExplainCaptureFactory): T {
  enabled.set(options, factory);
  return options;
}

export function explainOptionsFor(options: object): ExplainCaptureFactory | undefined {
  return enabled.get(options);
}
