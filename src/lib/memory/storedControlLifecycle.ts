import type { Meta } from 'foottrace';
import type { CommitAbout, EventLog } from 'foottrace/write';

import type { StageContext } from './StageContext.js';

/** The stage lifecycle seam. The optional producer owns all evidence storage and validation. */
export interface StoredControlLifecycle {
  begin(frame: { readonly parent?: { readonly runtimeStageId: string } }, id: string, parentLog?: EventLog): void;
  about(frame: object): CommitAbout | undefined;
  landed(frame: object): void;
  dynamic(): void;
  seal?(runId: string): Promise<{ readonly skippedChart: Meta } | undefined>;
  decision(
    frame: StageContext,
    children: readonly { readonly name: string }[],
    chosen: string,
    fellBack: boolean,
    fromRules: boolean,
  ): void;
  selection(frame: StageContext, children: readonly { readonly name: string }[], chosen: readonly string[]): void;
  loop(
    frame: StageContext,
    source: { readonly next?: { readonly isLoopRef?: boolean } },
    reference: object | string,
    target: string,
  ): void;
}

let lifecycles: WeakMap<object, StoredControlLifecycle> | undefined;

export function registerStoredControl(owner: object, lifecycle: StoredControlLifecycle): void {
  (lifecycles ??= new WeakMap()).set(owner, lifecycle);
}

export function storedControlFor(owner: object | undefined): StoredControlLifecycle | undefined {
  return owner && lifecycles?.get(owner);
}
