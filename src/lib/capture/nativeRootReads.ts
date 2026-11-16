/** Execution-local read observation at the native read funnel; never a replacement scope/proxy. */
type Observer = (root: string | undefined) => void;
const observers = new WeakMap<object, Observer>();
export function observeRootReads(context: object, observer: Observer): () => void {
  const previous = observers.get(context);
  observers.set(context, (root) => {
    previous?.(root);
    observer(root);
  });
  return () => {
    if (previous) observers.set(context, previous);
    else observers.delete(context);
  };
}
/** Key names remain literal. Keyless reads cannot claim a finite observed root prefix. */
export function noteRootRead(context: object, path: readonly string[], key: string | undefined): void {
  observers.get(context)?.(path[0] ?? key);
}
