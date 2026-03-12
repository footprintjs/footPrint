/**
 * Boundary: ManifestFlowRecorder edge cases.
 *
 * Tests unusual/extreme inputs: deeply nested subflows, rapid entry/exit,
 * mixed dynamic/static subflows, empty descriptions, many concurrent subflows.
 */

import { ManifestFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ManifestFlowRecorder';

describe('Boundary: ManifestFlowRecorder edge cases', () => {
  let recorder: ManifestFlowRecorder;

  beforeEach(() => {
    recorder = new ManifestFlowRecorder();
  });

  it('handles 10 levels of nesting', () => {
    for (let i = 0; i < 10; i++) {
      recorder.onSubflowEntry({ name: `Level${i}`, subflowId: `sf-${i}` });
    }
    for (let i = 9; i >= 0; i--) {
      recorder.onSubflowExit({ name: `Level${i}`, subflowId: `sf-${i}` });
    }

    const manifest = recorder.getManifest();
    expect(manifest).toHaveLength(1);

    // Walk to the deepest level
    let current = manifest[0];
    for (let i = 1; i < 10; i++) {
      expect(current.children).toHaveLength(1);
      current = current.children[0];
      expect(current.subflowId).toBe(`sf-${i}`);
    }
    expect(current.children).toEqual([]);
  });

  it('handles 100 sequential root-level subflows', () => {
    for (let i = 0; i < 100; i++) {
      recorder.onSubflowEntry({ name: `Flow${i}`, subflowId: `sf-${i}` });
      recorder.onSubflowExit({ name: `Flow${i}`, subflowId: `sf-${i}` });
    }

    expect(recorder.getManifest()).toHaveLength(100);
  });

  it('handles empty string description', () => {
    recorder.onSubflowEntry({ name: 'X', subflowId: 'sf-x', description: '' });
    recorder.onSubflowExit({ name: 'X' });

    expect(recorder.getManifest()[0].description).toBe('');
  });

  it('handles undefined description and subflowId', () => {
    recorder.onSubflowEntry({ name: 'Legacy' });
    recorder.onSubflowExit({ name: 'Legacy' });

    const entry = recorder.getManifest()[0];
    expect(entry.subflowId).toBe('Legacy'); // falls back to name
    expect(entry.description).toBeUndefined();
  });

  it('stores multiple specs from registration events', () => {
    for (let i = 0; i < 50; i++) {
      recorder.onSubflowRegistered({
        subflowId: `dyn-${i}`,
        name: `Dynamic${i}`,
        specStructure: { id: i },
      });
    }

    expect(recorder.getSpecIds()).toHaveLength(50);
    expect(recorder.getSpec('dyn-25')).toEqual({ id: 25 });
  });

  it('mixed entry/exit and registration events', () => {
    recorder.onSubflowEntry({ name: 'A', subflowId: 'sf-a' });
    recorder.onSubflowRegistered({ subflowId: 'dyn-1', name: 'DynA', specStructure: { x: 1 } });
    recorder.onSubflowEntry({ name: 'B', subflowId: 'sf-b' });
    recorder.onSubflowRegistered({ subflowId: 'dyn-2', name: 'DynB', specStructure: { x: 2 } });
    recorder.onSubflowExit({ name: 'B' });
    recorder.onSubflowExit({ name: 'A' });

    expect(recorder.getManifest()).toHaveLength(1);
    expect(recorder.getManifest()[0].children).toHaveLength(1);
    expect(recorder.getSpecIds()).toEqual(['dyn-1', 'dyn-2']);
  });

  it('reuse after clear', () => {
    recorder.onSubflowEntry({ name: 'Old', subflowId: 'sf-old' });
    recorder.onSubflowExit({ name: 'Old' });
    recorder.clear();

    recorder.onSubflowEntry({ name: 'New', subflowId: 'sf-new' });
    recorder.onSubflowExit({ name: 'New' });

    expect(recorder.getManifest()).toHaveLength(1);
    expect(recorder.getManifest()[0].name).toBe('New');
  });
});
