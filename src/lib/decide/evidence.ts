/**
 * decide/evidence -- Lightweight temp recorder for auto-capturing reads
 * during a when() function call.
 *
 * Attached to scope before calling when(scope), detached after.
 * Captures ReadEvent key + summarized value + redaction flag.
 * Uses summarizeValue() at capture time (no raw object references held).
 */

import { summarizeValue } from '../scope/recorders/summarizeValue.js';
import type { ReadEvent, Recorder } from '../scope/types.js';
import type { ReadInput } from './types.js';

const MAX_VALUE_LEN = 80;

let evidenceCounter = 0;

/**
 * Minimal Recorder that captures reads for decision evidence.
 * Attach before when(), detach after. Collect via getInputs().
 */
export class EvidenceCollector implements Recorder {
  readonly id: string;
  private inputs: ReadInput[] = [];

  constructor() {
    this.id = `evidence-${++evidenceCounter}`;
  }

  onRead(event: ReadEvent): void {
    if (!event.key) return;
    this.inputs.push({
      key: event.key,
      valueSummary: event.redacted ? '[REDACTED]' : summarizeValue(event.value, MAX_VALUE_LEN),
      redacted: event.redacted === true,
    });
  }

  /** Returns collected read inputs. */
  getInputs(): ReadInput[] {
    return this.inputs;
  }
}
