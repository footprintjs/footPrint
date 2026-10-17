/** Boundary/load contracts for future attention producers: bounded marks, honest proof omissions, detached snapshots. */
import type { Attention } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { StageAttention } from '../../../src/lib/memory/attention.js';

function mark(kind = 'error', evidence: readonly string[] = ['proof:0']): Attention {
  return { kind, reason: 'BUSINESS_RULE_MATCHED', evidence };
}

describe('bounded attention collector', () => {
  it('keeps the total cap when typed producers emit distinct not-collected reasons', () => {
    const collector = new StageAttention();
    for (let i = 0; i < 31; i++) collector.append(mark('domain-' + i, ['proof:' + i]));
    const reasons = ['EVIDENCE_NOT_COLLECTED', 'ERROR_RECORDED', 'BUSINESS_RULE_MATCHED'] as const;
    for (const reason of reasons) collector.append({ kind: 'not-collected', reason, evidence: ['proof:' + reason] });
    const snapshot = collector.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(32);
    expect(snapshot.some((entry) => entry.kind === 'not-collected')).toBe(true);
  });

  it('caps distinct future producer marks and reserves visible omission evidence', () => {
    const collector = new StageAttention();
    for (let i = 0; i < 80; i++) collector.append(mark('domain-' + i, ['proof:' + i]));
    const snapshot = collector.snapshot();
    expect(snapshot).toHaveLength(32);
    expect(snapshot.filter((entry) => entry.kind === 'not-collected')).toEqual([
      { kind: 'not-collected', reason: 'EVIDENCE_NOT_COLLECTED', evidence: [] },
    ]);
    expect(snapshot.some((entry) => entry.kind === 'domain-79')).toBe(false);
    // A full distinct-mark table still accepts another proof of an already retained fact.
    collector.append(mark('domain-0', ['proof:updated']));
    expect(collector.snapshot().find((entry) => entry.kind === 'domain-0')?.evidence).toEqual([
      'proof:0',
      'proof:updated',
    ]);
    expect(collector.snapshot()).toHaveLength(32);
  });

  it('deduplicates proof without disclosing false loss and discloses the first real reference overflow', () => {
    const collector = new StageAttention();
    const references = Array.from({ length: 16 }, (_, i) => 'proof:' + i);
    collector.append(mark('error', references));
    collector.append(mark('error', references));
    expect(collector.snapshot()).toEqual([mark('error', references)]);
    collector.append(mark('error', ['proof:17']));
    const snapshot = collector.snapshot();
    expect(snapshot.find((entry) => entry.kind === 'error')?.evidence).toEqual(references);
    expect(snapshot.map((entry) => entry.kind)).toContain('not-collected');
    expect(JSON.stringify(snapshot)).not.toContain('proof:17');
  });

  it('keeps exact accepted proof names but omits invalid and oversized names without truncating them', () => {
    const collector = new StageAttention();
    const exact = 'p'.repeat(512);
    const privateLong = 'PRIVATE_REF_' + 'x'.repeat(600);
    collector.append(mark('error', [exact, '', 'bad\u0000proof', privateLong]));
    const snapshot = collector.snapshot();
    expect(snapshot.find((entry) => entry.kind === 'error')?.evidence).toEqual([exact]);
    expect(snapshot.map((entry) => entry.kind)).toContain('not-collected');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_REF_');
    expect(JSON.stringify(snapshot)).not.toContain('bad');
    const unsupported = new StageAttention();
    unsupported.append(mark('error', ['', privateLong]));
    expect(unsupported.snapshot()).toEqual([{ kind: 'not-collected', reason: 'EVIDENCE_NOT_COLLECTED', evidence: [] }]);
  });

  it('detaches and freezes snapshots and never aliases a producer reference list', () => {
    const collector = new StageAttention();
    const producerRefs = ['proof:0'];
    collector.append(mark('error', producerRefs));
    const first = collector.snapshot();
    const bytes = JSON.stringify(first);
    producerRefs.push('PRIVATE_LATE_PRODUCER_MUTATION');
    collector.append(mark('error', ['proof:1']));
    collector.missing();
    expect(JSON.stringify(first)).toBe(bytes);
    expect(first).toEqual([mark('error', ['proof:0'])]);
    expect(collector.snapshot().find((entry) => entry.kind === 'error')?.evidence).toEqual(['proof:0', 'proof:1']);
    expect(JSON.stringify(collector.snapshot())).not.toContain('PRIVATE_LATE_');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].evidence)).toBe(true);
  });
});
