/**
 * Security: ManifestFlowRecorder isolation guarantees.
 *
 * Verifies that the manifest recorder cannot be used to break execution,
 * leak internal state, or corrupt the traversal.
 */

import { FlowRecorderDispatcher } from '../../../../src/lib/engine/narrative/FlowRecorderDispatcher';
import { ManifestFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ManifestFlowRecorder';

describe('Security: ManifestFlowRecorder isolation', () => {
  it('throwing ManifestFlowRecorder does not break dispatcher', () => {
    const dispatcher = new FlowRecorderDispatcher();
    const calls: string[] = [];

    // Bad recorder that throws on every hook
    const badManifest = new ManifestFlowRecorder('bad');
    badManifest.onSubflowEntry = () => {
      throw new Error('sabotage');
    };
    badManifest.onSubflowExit = () => {
      throw new Error('sabotage');
    };
    badManifest.onSubflowRegistered = () => {
      throw new Error('sabotage');
    };

    dispatcher.attach(badManifest);
    dispatcher.attach({ id: 'good', onSubflowEntry: (e) => calls.push(e.name) });

    expect(() => dispatcher.onSubflowEntry('Test', 'sf-test')).not.toThrow();
    expect(calls).toEqual(['Test']);
  });

  it('getManifest returns array that does not mutate internal state', () => {
    const recorder = new ManifestFlowRecorder();
    recorder.onSubflowEntry({ name: 'A', subflowId: 'sf-a' });
    recorder.onSubflowExit({ name: 'A' });

    const manifest = recorder.getManifest();
    manifest.push({ subflowId: 'injected', name: 'Injected', children: [] });

    // Internal state should be unchanged
    expect(recorder.getManifest()).toHaveLength(1);
  });

  it('spec objects are stored by reference, not cloned', () => {
    const recorder = new ManifestFlowRecorder();
    const spec = { mutable: true };
    recorder.onSubflowRegistered({ subflowId: 'sf', name: 'X', specStructure: spec });

    // Callers can mutate — this is intentional (performance over safety)
    // The security concern is about the recorder not breaking the pipeline
    expect(recorder.getSpec('sf')).toBe(spec);
  });
});
