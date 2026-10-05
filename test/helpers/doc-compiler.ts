import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Tiny typed API for compiler-mechanics tests, not a replacement for the real-doc gate. */
export function docCompilerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'doc-compiler-api-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src/index.ts'),
    `export function flowChart(name: string, stage: () => void, id: string) { return { name, stage, id }; }
export class FlowChartExecutor { constructor(chart: { name: string }) {} }
export interface FlowRecorder { id: string }
`,
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
