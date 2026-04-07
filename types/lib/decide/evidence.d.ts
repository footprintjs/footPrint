/**
 * decide/evidence -- Lightweight temp recorder for auto-capturing reads
 * during a when() function call.
 *
 * Attached to scope before calling when(scope), detached after.
 * Captures ReadEvent key + summarized value + redaction flag.
 * Uses summarizeValue() at capture time (no raw object references held).
 */
import type { ReadEvent, Recorder } from '../scope/types.js';
import type { ReadInput } from './types.js';
/**
 * Minimal Recorder that captures reads for decision evidence.
 * Attach before when(), detach after. Collect via getInputs().
 */
export declare class EvidenceCollector implements Recorder {
    readonly id: string;
    private inputs;
    constructor();
    onRead(event: ReadEvent): void;
    /** Returns collected read inputs. */
    getInputs(): ReadInput[];
}
