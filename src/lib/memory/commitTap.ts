/**
 * Observe the last landed commit through the record's public sink port. The tap
 * retains one bundle, not a second history, and confers no storage receipt.
 * Only the explicit output-handoff option installs it.
 */
import type { CommitBundle } from 'foottrace';
import type { RecordSink } from 'foottrace/write';

export interface CommitTap {
  readonly sink: RecordSink;
  last(): CommitBundle | undefined;
}

/** Forward the app's exact calls and return values; the native log owns failure isolation. */
export function createCommitTap(delegate?: RecordSink): CommitTap {
  let last: CommitBundle | undefined;
  const sink: RecordSink = {
    opened: (entry) => delegate?.opened(entry),
    commit: (entry) => {
      last = entry.bundle;
      return delegate?.commit(entry);
    },
    note: (entry) => delegate?.note(entry),
    closed: (entry) => delegate?.closed(entry),
    ...(delegate?.flush && { flush: () => delegate.flush!() }),
    ...(delegate?.onFailure && { onFailure: (failure) => delegate.onFailure!(failure) }),
  };
  return { sink, last: () => last };
}
