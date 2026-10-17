/** Inspect only already collected, synchronous quality rows; never recompute a score or walk the trace. */
import type { StageContext } from '../../memory/StageContext.js';
import { CompositeRecorder } from '../../recorder/CompositeRecorder.js';
import type { QualityEntry } from '../../recorder/QualityRecorder.js';
import { QualityRecorder } from '../../recorder/QualityRecorder.js';
import { FlowRecorderDispatcher } from '../narrative/FlowRecorderDispatcher.js';
import type { IControlFlowNarrative } from '../narrative/types.js';

const MAX_RECORDER_SLOTS = 128;
const NO_QUALITY = () => undefined;

/** Capture before delivery; only a real row replaced by THIS event can project a quality fact afterward. */
export function inlineQualityAttention(
  narrative: IControlFlowNarrative,
  context: StageContext,
  series: string,
  evidenceId?: string,
): () => void {
  if (evidenceId === undefined || !(narrative instanceof FlowRecorderDispatcher)) return NO_QUALITY;
  const pending: Array<Iterator<unknown>> = [];
  const seen = new Set<unknown>();
  const before = new Map<QualityRecorder, QualityEntry | undefined>();
  let slots = 0;
  try {
    // One extra slot detects overflow without making a copy of an unbounded attachment list.
    pending.push(narrative.getScopeRecorders(MAX_RECORDER_SLOTS + 1)[Symbol.iterator]());
    while (pending.length) {
      const next = pending[pending.length - 1]!.next();
      if (next.done) {
        pending.pop();
        continue;
      }
      if (++slots > MAX_RECORDER_SLOTS) {
        context.markQualityDrop();
        break;
      }
      const recorder = next.value;
      if (seen.has(recorder)) continue;
      seen.add(recorder);
      if (recorder instanceof QualityRecorder) {
        before.set(recorder, QualityRecorder.prototype.getByKey.call(recorder, series));
      } else if (recorder instanceof CompositeRecorder) {
        pending.push(CompositeRecorder.prototype.getChildren.call(recorder)[Symbol.iterator]());
      }
    }
  } catch {
    context.markQualityDrop();
  }
  return () => {
    try {
      for (const [recorder, previous] of before) {
        const row = QualityRecorder.prototype.getByKey.call(recorder, series);
        if (row !== previous && row?.drop === 'attempts') {
          context.markQualityDrop(evidenceId);
          return;
        }
      }
    } catch {
      // Observation must not change the business result or manufacture a drop from missing evidence.
      context.markQualityDrop();
    }
  };
}
