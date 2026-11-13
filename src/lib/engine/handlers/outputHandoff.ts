/**
 * The output mapper observes one child's state and stages writes in another log.
 * Keep that boundary explicit: child key names never enter the parent's readKeys.
 * This is an observed access prefix, not semantic dataflow. No history is walked
 * to guess a source; readers resolve the saved child keys at the saved cutoff.
 */
import type { CommitBundle, LogAddress } from 'foottrace';
import { normaliseStateKey, pathSegments } from 'foottrace/paths';

import type { RedactionRule } from '../../memory/redaction.js';
import type { StageContext } from '../../memory/StageContext.js';
import { rememberHandle } from '../../reactive/handles.js';
import type { SubflowResult } from '../types.js';

type Handoff = NonNullable<SubflowResult['outputHandoff']>;
type Limitation = Handoff['limitations'][number];
const MAX_ITEMS = 4096;
const MAX_CHARS = 64 * 1024;
const MAX_WRITES = 256;

function frozenAddress(address: LogAddress): LogAddress {
  return Object.freeze({ logRunId: address.logRunId, drillPath: Object.freeze([...address.drillPath]) });
}

/** One mount's bounded, value-free hand-back observation. Never shared between visits. */
export class OutputHandoff {
  private open = true;
  private committing = false;
  private readonly reads = new Set<string>();
  private readonly staged = new Map<string, readonly string[]>();
  private readonly limitations = new Set<Limitation>();
  private items = 0;
  private chars = 0;
  private writeChars = 0;
  private stopWrites?: () => void;

  constructor(
    private readonly parent: LogAddress,
    private readonly child: LogAddress,
    private readonly runtimeStageId: string,
    private readonly cutoff: number,
    private readonly rule: RedactionRule | undefined,
  ) {}

  /** Observe ordinary root gets on the fallback state copy, never arbitrary returned values. */
  view(state: Record<string, unknown>, explicitOutput: boolean): Record<string, unknown> {
    if (explicitOutput) {
      this.limitations.add('explicit-output');
      return state;
    }
    const changed = new Set<string | symbol>();
    const mutation = (key: string | symbol, act: () => boolean): boolean => {
      const done = act();
      if (done && this.open) {
        changed.add(key);
        this.limitations.add('output-mutated');
      }
      return done;
    };
    const view = new Proxy(state, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (this.open && typeof key === 'string' && Object.hasOwn(target, key) && !changed.has(key)) this.read(key);
        return value;
      },
      set: (target, key, value) => mutation(key, () => Reflect.set(target, key, value, target)),
      defineProperty: (target, key, descriptor) => mutation(key, () => Reflect.defineProperty(target, key, descriptor)),
      deleteProperty: (target, key) => mutation(key, () => Reflect.deleteProperty(target, key)),
    });
    // A mapper can hand on the whole view, nested in another value. Take all
    // its values now, while observation is open, instead of retaining a proxy.
    rememberHandle(view, () => ({ ...view }));
    return view;
  }

  watchWrites(context: StageContext): void {
    this.stopWrites = context.observeStagedWrites(
      (segments) => {
        const path = normaliseStateKey(segments);
        if (!this.staged.has(path)) {
          if (this.staged.size >= MAX_WRITES || this.writeChars + path.length > MAX_CHARS) {
            this.limitations.add('budget-exhausted');
            return;
          }
          this.writeChars += path.length;
        }
        const prefix = [...this.reads];
        const kept = this.spend(
          prefix.reduce((n, key) => n + key.length, 0),
          prefix.length,
        )
          ? prefix
          : [];
        this.staged.set(path, Object.freeze(kept));
      },
      (phase) => {
        if (phase === 'committing') this.committing = true;
        else this.close();
      },
    );
  }

  private read(key: string): void {
    if (this.committing) this.limitations.add('commit-time-read');
    // With an active privacy rule the whole reference channel is withheld.
    // Do not run another policy matcher merely to decide provenance precision.
    if (this.rule && !this.rule.isInert()) {
      this.limitations.add('privacy-active');
      return;
    }
    if (!this.reads.has(key) && this.spend(key.length, 1)) this.reads.add(key);
  }

  private spend(chars: number, items: number): boolean {
    if (this.items + items > MAX_ITEMS || this.chars + chars > MAX_CHARS) {
      this.limitations.add('budget-exhausted');
      return false;
    }
    this.items += items;
    this.chars += chars;
    return true;
  }

  /** Called immediately after the one merge-back commit, never after a failed commit. */
  finish(bundle: CommitBundle | undefined, commitIdx: number): Handoff | undefined {
    if (!bundle || bundle.runtimeStageId !== this.runtimeStageId || !bundle.trace.length) return undefined;
    if (this.rule && !this.rule.isInert()) this.limitations.add('privacy-active');
    const hidden = this.limitations.has('privacy-active');
    const writes: Array<Handoff['writes'][number]> = [];
    const seen = new Set<string>();
    for (const row of bundle.trace) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      let prefix = this.staged.get(row.path);
      // Record admission may replace several nested writes with one root set.
      // Keep the actual admitted path and union only overlapping staged prefixes.
      if (prefix === undefined) {
        const parts = pathSegments(row.path);
        const related = new Set<string>();
        for (const [path, reads] of this.staged) {
          const other = pathSegments(path);
          if (parts.slice(0, Math.min(parts.length, other.length)).every((p, i) => p === other[i]))
            for (const key of reads) related.add(key);
        }
        if (related.size === 0) continue;
        prefix = [...related];
      }
      if (writes.length >= MAX_WRITES) {
        this.limitations.add('budget-exhausted');
        break;
      }
      writes.push(Object.freeze({ path: row.path, reads: Object.freeze(hidden ? [] : [...prefix]) }));
    }
    if (writes.length === 0 && !this.limitations.size) return undefined;
    return Object.freeze({
      version: 1,
      attribution: 'observed-read-prefix',
      parent: Object.freeze({ address: frozenAddress(this.parent), runtimeStageId: this.runtimeStageId, commitIdx }),
      child: Object.freeze({ address: frozenAddress(this.child), beforeCommitIdx: this.cutoff }),
      writes: Object.freeze(writes),
      status: this.limitations.size === 0 ? 'captured' : 'partial',
      limitations: Object.freeze([...this.limitations]),
    });
  }

  close(): void {
    this.open = false;
    this.stopWrites?.();
    this.stopWrites = undefined;
  }
}
