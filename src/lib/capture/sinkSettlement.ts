/**
 * `value`, settled ONCE into `onValue` / `onError` — never through the value's own `then`: a native promise is
 * watched through the real `Promise.prototype.then` (an own `then` on it is not trusted, so its rejection is always
 * handled), any other thenable adopted into a fresh promise. A plain value is a fulfilment.
 */
export function settleOnce<T>(value: unknown, onValue: () => T, onError: (error: unknown) => T): Promise<T> {
  const adopted: Promise<unknown> = value instanceof Promise ? value : new Promise((resolve) => resolve(value));
  return Promise.prototype.then.call(adopted, onValue, onError) as Promise<T>;
}
