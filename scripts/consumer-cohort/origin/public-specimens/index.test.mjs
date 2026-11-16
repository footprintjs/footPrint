import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
for (const name of ['preflight.cjs', 'preflight.mjs', 'run.cjs', 'run.mjs'])
  it('parses the fixed ' + name + ' specimen', () => {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL('./' + name, import.meta.url))], {
      timeout: 5000,
    });
  });
