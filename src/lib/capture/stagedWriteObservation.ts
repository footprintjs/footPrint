/** The native staged-write observer stack, independent of record encoding and retained values. */
type Phase = 'committing' | 'landed';
type Watch = { write: (path: readonly string[]) => void; boundary?: (phase: Phase) => void };
const watchers = new WeakMap<object, Watch>();
export function observeStageWrites(context: object, write: Watch['write'], boundary?: Watch['boundary']): () => void {
  const previous = watchers.get(context);
  watchers.set(context, { write, boundary });
  return () => {
    if (previous) watchers.set(context, previous);
    else watchers.delete(context);
  };
}
export function noteStageWrite(context: object, path: readonly string[]): void {
  watchers.get(context)?.write(path);
}
export function noteWriteBoundary(context: object, phase: Phase): void {
  watchers.get(context)?.boundary?.(phase);
}
