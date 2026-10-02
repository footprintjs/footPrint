/**
 * The three leaves F0 moved (the fence and the leaves) keep their OLD paths for one
 * minor, as re-exports. This pins the promise: each old path hands back the SAME
 * function object as its new home — so the dev-mode flag in particular is one piece of
 * state, never a copy — and nothing else is exported from it.
 *
 * Delete this file together with the three shims when they go (the minor after F0).
 */
import { describe, expect, it } from 'vitest';

import * as circular from '../../../src/lib/capture/circular';
import * as invokeHook from '../../../src/lib/capture/invokeHook';
import * as summarize from '../../../src/lib/capture/summarize';
import * as devMode from '../../../src/lib/devMode';
import * as oldInvokeHook from '../../../src/lib/recorder/invokeHook';
import * as oldDetectCircular from '../../../src/lib/scope/detectCircular';
import * as oldSummarizeValue from '../../../src/lib/scope/recorders/summarizeValue';

describe('moved leaves — the old paths re-export for one minor', () => {
  it('scope/detectCircular re-exports devMode and capture/circular, nothing more', () => {
    expect(Object.keys(oldDetectCircular).sort()).toEqual(
      ['disableDevMode', 'enableDevMode', 'hasCircularReference', 'isDevMode'].sort(),
    );
    expect(oldDetectCircular.enableDevMode).toBe(devMode.enableDevMode);
    expect(oldDetectCircular.disableDevMode).toBe(devMode.disableDevMode);
    expect(oldDetectCircular.isDevMode).toBe(devMode.isDevMode);
    expect(oldDetectCircular.hasCircularReference).toBe(circular.hasCircularReference);
  });

  it('the dev-mode flag is ONE piece of state across the old and the new path', () => {
    try {
      expect(devMode.isDevMode()).toBe(false);
      oldDetectCircular.enableDevMode();
      expect(devMode.isDevMode()).toBe(true);
      devMode.disableDevMode();
      expect(oldDetectCircular.isDevMode()).toBe(false);
    } finally {
      devMode.disableDevMode();
    }
  });

  it('recorder/invokeHook re-exports capture/invokeHook', () => {
    expect(Object.keys(oldInvokeHook)).toEqual(['invokeRecorderHook']);
    expect(oldInvokeHook.invokeRecorderHook).toBe(invokeHook.invokeRecorderHook);
  });

  it('scope/recorders/summarizeValue re-exports capture/summarize · summarizeValue', () => {
    expect(Object.keys(oldSummarizeValue)).toEqual(['summarizeValue']);
    expect(oldSummarizeValue.summarizeValue).toBe(summarize.summarizeValue);
  });
});
