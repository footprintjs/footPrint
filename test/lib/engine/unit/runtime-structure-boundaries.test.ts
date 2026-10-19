import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../../src/index.js';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode.js';
import {
  computeNodeType,
  RuntimeStructureManager,
} from '../../../../src/lib/engine/handlers/RuntimeStructureManager.js';
import type { SerializedPipelineStructure } from '../../../../src/lib/engine/types.js';

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('runtime structure admission and diagnostics', () => {
  it('leaves an unrepresentable build structure untracked instead of breaking execution', () => {
    const cyclic: SerializedPipelineStructure = { id: 'root', name: 'Root', type: 'stage' };
    cyclic.next = cyclic;
    const manager = new RuntimeStructureManager();
    expect(() => manager.init(cyclic)).not.toThrow();
    expect(manager.getStructure()).toBeUndefined();
    manager.updateDynamicNext('root', { id: 'next', name: 'Next' });
    expect(manager.getStructure()).toBeUndefined();
  });

  it('reports missing dynamic mounts in development while preserving the known structure', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new RuntimeStructureManager();
    manager.init({ id: 'root', name: 'Root', type: 'stage' });
    const before = structuredClone(manager.getStructure());
    manager.updateDynamicChildren('missing-children', [{ id: 'child', name: 'Child' }]);
    manager.updateDynamicSubflow('missing-mount', 'subflow');
    manager.updateDynamicNext('missing-next', { id: 'next', name: 'Next' });
    manager.updateIterationCount('missing-iteration', 9);
    expect(manager.getStructure()).toEqual(before);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("node 'missing-children' not found"),
      expect.stringContaining("node 'missing-mount' not found"),
      expect.stringContaining("node 'missing-next' not found"),
    ]);
    disableDevMode();
    manager.updateDynamicNext('production-missing', { id: 'next', name: 'Next' });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('keeps dynamic parallel and loop back-edge roles visible to consumers', () => {
    const parallel: StageNode = { id: 'each', name: 'Each', isDynamicParallel: true };
    const backEdge: StageNode = { id: 'again', name: 'Again', isLoopRef: true };
    expect(computeNodeType(parallel)).toBe('fork');
    expect(computeNodeType(backEdge)).toBe('loop');
    const manager = new RuntimeStructureManager();
    const tags = ['checkout'];
    const node: StageNode = { id: 'tagged', name: 'Tagged', tags };
    const structure = manager.stageNodeToStructure(node);
    tags.push('later');
    expect(structure.tags).toEqual(['checkout']);
  });
});
