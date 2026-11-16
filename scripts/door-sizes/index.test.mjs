import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { bundledBytes } from './index.mjs';

it('measures retained app code, drops unused exports and keeps external doors external', async () => {
  const root = mkdtempSync(join(tmpdir(), 'footprint-door-size-'));
  try {
    const entry = join(root, 'entry.js');
    const app = join(root, 'app.js');
    writeFileSync(entry, `export const kept = 42; export const unused = ${JSON.stringify('DISPOSABLE'.repeat(5000))};`);
    writeFileSync(app, "import { kept } from './entry.js'; console.log(kept);");
    const baseline = await bundledBytes({ entryPoints: [app] });
    writeFileSync(entry, `export const kept = 42; export const unused = ${JSON.stringify('UNREACHED'.repeat(10000))};`);
    expect(await bundledBytes({ entryPoints: [app] })).toBe(baseline);
    writeFileSync(app, "import { readRunEvidence } from 'foottrace'; console.log(readRunEvidence);");
    expect(await bundledBytes({ entryPoints: [app] })).toBeGreaterThan(0);
    writeFileSync(app, "import { missing } from 'a-package-that-does-not-exist'; console.log(missing);");
    await expect(bundledBytes({ entryPoints: [app] })).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});
