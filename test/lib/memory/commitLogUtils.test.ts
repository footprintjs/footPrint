/**
 * Unit tests for commit log query utilities.
 */
import { describe, expect, it } from 'vitest';

import { findCommit, findCommits, findLastWriter } from '../../../src/lib/memory/commitLogUtils';
import type { CommitBundle } from '../../../src/lib/memory/types';

function bundle(idx: number, stage: string, stageId: string, keys: string[], runtimeStageId?: string): CommitBundle {
  return {
    idx,
    stage,
    stageId,
    runtimeStageId: runtimeStageId ?? `${stageId}#${idx}`,
    trace: keys.map((k) => ({ path: k, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: {},
    updates: {},
  };
}

const log: CommitBundle[] = [
  bundle(0, 'Seed', 'seed', ['messages', 'loopCount']),
  bundle(1, 'SystemPrompt', 'sf-system-prompt', ['systemPrompt']),
  bundle(2, 'CallLLM', 'call-llm', ['adapterRawResponse', 'adapterResult']),
  bundle(3, 'ParseResponse', 'parse-response', ['parsedResponse', 'messages']),
  bundle(4, 'ExecuteTools', 'execute-tool-calls', ['toolResultMessages']),
  bundle(5, 'CallLLM', 'call-llm', ['adapterRawResponse', 'adapterResult']),
  bundle(6, 'Finalize', 'final', ['result']),
];

describe('findCommit', () => {
  it('finds by stageId', () => {
    const found = findCommit(log, 'seed');
    expect(found?.idx).toBe(0);
  });

  it('finds by stageId + key', () => {
    const found = findCommit(log, 'call-llm', 'adapterRawResponse');
    expect(found?.idx).toBe(2); // first CallLLM
  });

  it('returns undefined for missing stageId', () => {
    expect(findCommit(log, 'nonexistent')).toBeUndefined();
  });
});

describe('findCommits', () => {
  it('finds all commits by stageId', () => {
    const found = findCommits(log, 'call-llm');
    expect(found).toHaveLength(2);
    expect(found[0].idx).toBe(2);
    expect(found[1].idx).toBe(5);
  });

  it('returns empty for missing stageId', () => {
    expect(findCommits(log, 'nonexistent')).toEqual([]);
  });
});

describe('findLastWriter', () => {
  it('finds last writer of a key', () => {
    const found = findLastWriter(log, 'messages');
    expect(found?.idx).toBe(3); // ParseResponse wrote messages last
  });

  it('finds last writer before a given index', () => {
    const found = findLastWriter(log, 'adapterRawResponse', 5);
    expect(found?.idx).toBe(2); // first CallLLM, before idx 5
  });

  it('returns undefined if no writer found', () => {
    expect(findLastWriter(log, 'nonexistent')).toBeUndefined();
  });

  it('findLastWriter for backtracking — who wrote systemPrompt before CallLLM#5', () => {
    const writer = findLastWriter(log, 'systemPrompt', 5);
    expect(writer?.stageId).toBe('sf-system-prompt');
    expect(writer?.idx).toBe(1);
  });
});
