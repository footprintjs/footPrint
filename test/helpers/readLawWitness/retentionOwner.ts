/** Original last-owner rule for retained stage slots, shared by binding and earlier windows. */
import type { NativeFact, Receipt } from '../readWitness.js';
import { equal } from './types.js';

export const stageReads = (native: Receipt) =>
  native.events.filter(
    (event) =>
      event.tier === 'stage-call' &&
      ['getValue', 'getValueDirect'].includes(event.method) &&
      event.phase === 'read' &&
      event.outcome === 'returned',
  );

export function ownsFinalSlot(native: Receipt, read: NativeFact): boolean {
  const owner = (event: NativeFact) => {
    const retained = event.retention;
    if (
      !retained ||
      event.leg !== native.leg ||
      native.events.filter((actual) => actual.id === event.id).length !== 1 ||
      !native.events.includes(event) ||
      retained.frame !== event.frame ||
      retained.nativeId !== event.id ||
      typeof retained.key !== 'string' ||
      !retained.eligibility ||
      !['full', 'summary'].includes(retained.eligibility.mode) ||
      !['baseline-own-readTracking', 'build-own-policy'].includes(retained.eligibility.layout)
    )
      throw new Error('Missing or ambiguous actual retained owner.');
    return retained;
  };
  const retained = owner(read);
  let final = true;
  for (const later of stageReads(native)) {
    if (later.frame !== read.frame || later.end <= read.end) continue;
    if (later.method !== 'getValue') continue;
    const captured = owner(later); // Validate ALL later provenance; a valid shadow must not hide a still-later ambiguity.
    if (!equal(later.header, read.header)) throw new Error('Later retained read has ambiguous native stage identity.');
    if (captured.key !== retained.key) continue;
    if (!(read.end < later.start && later.start < later.end))
      throw new Error('Later retained owner is not an unambiguous ordered read.');
    final = false; // Same run/frame/key, own nativeId: this earlier read no longer owns a final stage slot.
  }
  return final;
}
