import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogAddress } from 'foottrace';

import { type IndexedRecordFile, openIndexedRecordFile } from '../../src/sinks.js';

export const indexedAddress = (logRunId = 'one', drillPath: string[] = []): LogAddress => ({ logRunId, drillPath });
export const indexedRows = (logRunId = 'one', drillPath: string[] = []) => [
  { kind: 'opened', address: indexedAddress(logRunId, drillPath), at: 0, initialState: {} },
  { kind: 'closed', address: indexedAddress(logRunId, drillPath), at: 1, outcome: 'completed', commits: 0 },
];
export const indexedText = (rows: unknown[]) => rows.map((row) => JSON.stringify(row) + '\n').join('');
export function indexedFixture(rows: unknown[] = indexedRows()) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-indexed-test-'));
  const path = join(dir, 'record.jsonl');
  writeFileSync(path, indexedText(rows), { mode: 0o600 });
  return { dir, path };
}
export async function indexedReady(
  path: string,
  allowedScopes: LogAddress[] = [indexedAddress()],
): Promise<IndexedRecordFile> {
  const result = await openIndexedRecordFile(path, { allowedScopes });
  if (result.status !== 'ready') throw Error(`Unexpected test refusal: ${result.reason}`);
  return result.reader;
}
