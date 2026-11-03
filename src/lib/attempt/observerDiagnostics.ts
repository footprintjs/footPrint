/** Standalone observer delivery: diagnostics never replace supplied work. */
import { isDevMode } from '../devMode.js';

type Observer = 'onAttempt' | 'onEnd';
const MESSAGES: Readonly<Record<Observer, string>> = Object.freeze({
  onAttempt: '[footprint] attempt(): onAttempt observer failed; operation outcome unchanged',
  onEnd: '[footprint] attempt(): onEnd observer failed; operation outcome unchanged',
});

/** Observe ordinary native Promises without awaiting or probing a foreign then getter. */
function observeNativeFailure(value: unknown, failed: () => void): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  try {
    Promise.prototype.then.call(value, () => undefined, failed);
  } catch {
    // Non-native thenables/Promise proxies are outside the observer contract.
  }
}

function warn(observer: Observer): void {
  if (!isDevMode()) return;
  try {
    // eslint-disable-next-line no-console
    const returned: unknown = console.warn(MESSAGES[observer]);
    observeNativeFailure(returned, () => undefined);
  } catch {
    // A failing diagnostic sink cannot replace the operation or observer reports.
  }
}

export function notifyStandaloneObserver<T>(
  observer: Observer,
  notify: ((value: T) => void) | undefined,
  value: T,
): void {
  if (!notify) return;
  try {
    const returned: unknown = notify(value);
    observeNativeFailure(returned, () => warn(observer));
  } catch {
    warn(observer);
  }
}
