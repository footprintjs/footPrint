/**
 * Tests for decide/evidence -- EvidenceCollector temp recorder.
 */
import { describe, expect, it } from 'vitest';

import { EvidenceCollector } from '../../../../src/lib/decide/evidence';

describe('EvidenceCollector', () => {
  it('has a unique id', () => {
    const a = new EvidenceCollector();
    const b = new EvidenceCollector();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toContain('evidence-');
  });

  it('captures reads with key and summarized value', () => {
    const collector = new EvidenceCollector();
    collector.onRead({
      key: 'creditScore',
      value: 750,
      stageName: 'test',
      pipelineId: 'p1',
      timestamp: Date.now(),
    });
    const inputs = collector.getInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      key: 'creditScore',
      valueSummary: '750',
      redacted: false,
    });
  });

  it('captures multiple reads in order', () => {
    const collector = new EvidenceCollector();
    collector.onRead({ key: 'a', value: 1, stageName: 's', pipelineId: 'p', timestamp: 0 });
    collector.onRead({ key: 'b', value: 'hello', stageName: 's', pipelineId: 'p', timestamp: 0 });
    collector.onRead({ key: 'c', value: true, stageName: 's', pipelineId: 'p', timestamp: 0 });
    const inputs = collector.getInputs();
    expect(inputs).toHaveLength(3);
    expect(inputs[0].key).toBe('a');
    expect(inputs[1].key).toBe('b');
    expect(inputs[2].key).toBe('c');
  });

  it('skips reads with undefined key', () => {
    const collector = new EvidenceCollector();
    collector.onRead({ key: undefined, value: 42, stageName: 's', pipelineId: 'p', timestamp: 0 });
    expect(collector.getInputs()).toHaveLength(0);
  });

  it('summarizes large objects (not raw references)', () => {
    const collector = new EvidenceCollector();
    const bigObj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    collector.onRead({ key: 'data', value: bigObj, stageName: 's', pipelineId: 'p', timestamp: 0 });
    const inputs = collector.getInputs();
    expect(typeof inputs[0].valueSummary).toBe('string');
    expect(inputs[0].valueSummary).toContain('5 keys');
  });

  it('shows [REDACTED] for redacted reads', () => {
    const collector = new EvidenceCollector();
    collector.onRead({
      key: 'ssn',
      value: '123-45-6789',
      redacted: true,
      stageName: 's',
      pipelineId: 'p',
      timestamp: 0,
    });
    const inputs = collector.getInputs();
    expect(inputs[0].valueSummary).toBe('[REDACTED]');
    expect(inputs[0].redacted).toBe(true);
  });

  it('does not implement other Recorder hooks (onWrite, onCommit, etc.)', () => {
    const collector = new EvidenceCollector();
    expect(collector.onWrite).toBeUndefined();
    expect(collector.onCommit).toBeUndefined();
    expect(collector.onError).toBeUndefined();
  });

  it('arrays summarized as item count', () => {
    const collector = new EvidenceCollector();
    collector.onRead({ key: 'items', value: [1, 2, 3], stageName: 's', pipelineId: 'p', timestamp: 0 });
    expect(collector.getInputs()[0].valueSummary).toBe('(3 items)');
  });

  it('null and undefined values summarized correctly', () => {
    const collector = new EvidenceCollector();
    collector.onRead({ key: 'a', value: null, stageName: 's', pipelineId: 'p', timestamp: 0 });
    collector.onRead({ key: 'b', value: undefined, stageName: 's', pipelineId: 'p', timestamp: 0 });
    const inputs = collector.getInputs();
    expect(inputs[0].valueSummary).toBe('null');
    expect(inputs[1].valueSummary).toBe('undefined');
  });
});
