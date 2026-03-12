/**
 * Property: ManifestFlowRecorder invariants.
 *
 * Verifies structural invariants hold for arbitrary sequences of events.
 */

import { ManifestFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ManifestFlowRecorder';

describe('Property: ManifestFlowRecorder invariants', () => {
  it('every entry has a matched exit → manifest has no orphans in stack', () => {
    const recorder = new ManifestFlowRecorder();
    const names = ['A', 'B', 'C', 'D', 'E'];

    // All matched: each entry has an exit
    for (const name of names) {
      recorder.onSubflowEntry({ name, subflowId: `sf-${name}` });
      recorder.onSubflowExit({ name });
    }

    // All sequential → 5 root entries, each with 0 children
    const manifest = recorder.getManifest();
    expect(manifest).toHaveLength(5);
    for (const entry of manifest) {
      expect(entry.children).toEqual([]);
    }
  });

  it('nested entries produce correct parent-child relationships', () => {
    const recorder = new ManifestFlowRecorder();

    // A contains B, B contains C (linear nesting)
    recorder.onSubflowEntry({ name: 'A', subflowId: 'sf-A' });
    recorder.onSubflowEntry({ name: 'B', subflowId: 'sf-B' });
    recorder.onSubflowEntry({ name: 'C', subflowId: 'sf-C' });
    recorder.onSubflowExit({ name: 'C' });
    recorder.onSubflowExit({ name: 'B' });
    recorder.onSubflowExit({ name: 'A' });

    const manifest = recorder.getManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].subflowId).toBe('sf-A');
    expect(manifest[0].children).toHaveLength(1);
    expect(manifest[0].children[0].subflowId).toBe('sf-B');
    expect(manifest[0].children[0].children).toHaveLength(1);
    expect(manifest[0].children[0].children[0].subflowId).toBe('sf-C');
  });

  it('total manifest entries equals total entry/exit pairs', () => {
    const recorder = new ManifestFlowRecorder();

    // Generate random-ish but balanced nesting
    const pairs = 20;
    let depth = 0;
    let totalEntries = 0;

    for (let i = 0; i < pairs; i++) {
      recorder.onSubflowEntry({ name: `F${i}`, subflowId: `sf-${i}` });
      depth++;
      totalEntries++;

      // Close some entries to vary nesting
      if (depth > 3 || (depth > 1 && i % 3 === 0)) {
        recorder.onSubflowExit({ name: `F${i}` });
        depth--;
      }
    }
    // Close remaining
    while (depth > 0) {
      recorder.onSubflowExit({ name: 'closing' });
      depth--;
    }

    // Count all entries in tree
    function countEntries(entries: { children: any[] }[]): number {
      return entries.reduce((sum, e) => sum + 1 + countEntries(e.children), 0);
    }

    expect(countEntries(recorder.getManifest())).toBe(totalEntries);
  });

  it('spec storage: first-write-wins for same subflowId', () => {
    const recorder = new ManifestFlowRecorder();
    const spec1 = { version: 1 };
    const spec2 = { version: 2 };

    recorder.onSubflowRegistered({ subflowId: 'sf-1', name: 'A', specStructure: spec1 });
    recorder.onSubflowRegistered({ subflowId: 'sf-1', name: 'A', specStructure: spec2 });

    // First write wins — second registration does not overwrite
    expect(recorder.getSpec('sf-1')).toBe(spec1);
  });
});
