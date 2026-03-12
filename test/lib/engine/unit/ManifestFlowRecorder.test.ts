import type { ManifestEntry } from '../../../../src/lib/engine/narrative/recorders/ManifestFlowRecorder';
import { ManifestFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ManifestFlowRecorder';

describe('ManifestFlowRecorder', () => {
  let recorder: ManifestFlowRecorder;

  beforeEach(() => {
    recorder = new ManifestFlowRecorder();
  });

  it('has default id "manifest"', () => {
    expect(recorder.id).toBe('manifest');
  });

  it('accepts custom id', () => {
    const custom = new ManifestFlowRecorder('custom-manifest');
    expect(custom.id).toBe('custom-manifest');
  });

  it('returns empty manifest before any events', () => {
    expect(recorder.getManifest()).toEqual([]);
  });

  it('builds manifest entry from subflow entry/exit', () => {
    recorder.onSubflowEntry({ name: 'CreditCheck', subflowId: 'sf-credit', description: 'Pull credit report' });
    recorder.onSubflowExit({ name: 'CreditCheck', subflowId: 'sf-credit' });

    const manifest = recorder.getManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toEqual({
      subflowId: 'sf-credit',
      name: 'CreditCheck',
      description: 'Pull credit report',
      children: [],
    });
  });

  it('builds nested manifest for subflows within subflows', () => {
    recorder.onSubflowEntry({ name: 'Employment', subflowId: 'sf-emp', description: 'Verify employment' });
    recorder.onSubflowEntry({ name: 'EmployerAPI', subflowId: 'sf-emp-api', description: 'Call employer service' });
    recorder.onSubflowExit({ name: 'EmployerAPI', subflowId: 'sf-emp-api' });
    recorder.onSubflowExit({ name: 'Employment', subflowId: 'sf-emp' });

    const manifest = recorder.getManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].subflowId).toBe('sf-emp');
    expect(manifest[0].children).toHaveLength(1);
    expect(manifest[0].children[0].subflowId).toBe('sf-emp-api');
    expect(manifest[0].children[0].description).toBe('Call employer service');
  });

  it('handles multiple root-level subflows', () => {
    recorder.onSubflowEntry({ name: 'A', subflowId: 'sf-a' });
    recorder.onSubflowExit({ name: 'A', subflowId: 'sf-a' });
    recorder.onSubflowEntry({ name: 'B', subflowId: 'sf-b' });
    recorder.onSubflowExit({ name: 'B', subflowId: 'sf-b' });

    const manifest = recorder.getManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[0].subflowId).toBe('sf-a');
    expect(manifest[1].subflowId).toBe('sf-b');
  });

  it('falls back to name as subflowId when subflowId is missing', () => {
    recorder.onSubflowEntry({ name: 'LegacyFlow' });
    recorder.onSubflowExit({ name: 'LegacyFlow' });

    expect(recorder.getManifest()[0].subflowId).toBe('LegacyFlow');
  });

  it('stores specs from onSubflowRegistered', () => {
    const spec = { name: 'DynFlow', type: 'stage', children: [] };
    recorder.onSubflowRegistered({ subflowId: 'dyn-1', name: 'DynFlow', specStructure: spec });

    expect(recorder.getSpec('dyn-1')).toBe(spec);
    expect(recorder.getSpec('nonexistent')).toBeUndefined();
    expect(recorder.getSpecIds()).toEqual(['dyn-1']);
  });

  it('does not store spec when specStructure is undefined', () => {
    recorder.onSubflowRegistered({ subflowId: 'dyn-2', name: 'NoSpec' });
    expect(recorder.getSpec('dyn-2')).toBeUndefined();
  });

  it('clear() resets all state', () => {
    recorder.onSubflowEntry({ name: 'X', subflowId: 'sf-x' });
    recorder.onSubflowExit({ name: 'X', subflowId: 'sf-x' });
    recorder.onSubflowRegistered({ subflowId: 'dyn', name: 'Dyn', specStructure: {} });

    recorder.clear();
    expect(recorder.getManifest()).toEqual([]);
    expect(recorder.getSpec('dyn')).toBeUndefined();
    expect(recorder.getSpecIds()).toEqual([]);
  });

  it('handles onSubflowExit without matching entry gracefully', () => {
    // Edge case: exit without entry should not throw
    expect(() => recorder.onSubflowExit({ name: 'Phantom' })).not.toThrow();
    expect(recorder.getManifest()).toEqual([]);
  });
});
