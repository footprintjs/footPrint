import { expect, it, vi } from 'vitest';

import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import { RunObservers } from './attach.js';

it('returns no manifest/spec for absent or unrelated inline recorders', () => {
  const observers = new RunObservers();
  expect(observers.getSubflowManifest()).toEqual([]);
  expect(observers.getSubflowSpec('missing')).toBeUndefined();
  observers.attachFlow({ id: 'unrelated', onStageStart() {} });
  expect(observers.getSubflowManifest()).toEqual([]);
  expect(observers.getSubflowSpec('missing')).toBeUndefined();
});

it('preserves first inline class match, exact delegation and id replacement order', () => {
  const observers = new RunObservers();
  const first = new ManifestFlowRecorder('first');
  const second = new ManifestFlowRecorder('second');
  const manifest = [{ name: 'one' }];
  const spec = { id: 'one' };
  const getManifest = vi.spyOn(first, 'getManifest').mockReturnValue(manifest);
  const getSpec = vi.spyOn(first, 'getSpec').mockReturnValue(spec);
  const nextManifest = vi.spyOn(second, 'getManifest').mockReturnValue([]);
  observers.attachFlow(first);
  observers.attachFlow(second);
  expect(observers.getSubflowManifest()).toBe(manifest);
  expect(observers.getSubflowSpec('recorded-id')).toBe(spec);
  expect(getManifest).toHaveBeenCalledTimes(1);
  expect(getSpec).toHaveBeenCalledExactlyOnceWith('recorded-id');
  expect(nextManifest).not.toHaveBeenCalled();
  const replacement = new ManifestFlowRecorder('first');
  const replaced = [{ name: 'replacement' }];
  vi.spyOn(replacement, 'getManifest').mockReturnValue(replaced);
  observers.attachFlow(replacement);
  // Existing attachment policy removes the replaced ID and appends its replacement.
  // The other inline manifest is now first; removing it reveals the replacement.
  expect(observers.getSubflowManifest()).toEqual([]);
  expect(nextManifest).toHaveBeenCalledTimes(1);
  observers.detachFlow('second');
  expect(observers.getSubflowManifest()).toBe(replaced);
});
