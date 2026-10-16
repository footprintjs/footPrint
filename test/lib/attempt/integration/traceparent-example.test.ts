/**
 * The correlation example, RUN — `examples/integrations/traceparent.ts` asserts its own invariants (a valid header
 * carried, a forged one refused and never echoed, explicit ids carried) and exits non-zero on any violation; this
 * test shells out to it and reads the exit code and the closing line.
 *
 * The example imports `footprintjs`, which resolves to `dist/`, so this runs only from `npm run test:examples`
 * (vitest.examples.config.ts builds first); it never builds itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../../..');
const example = resolve(projectRoot, 'examples/integrations/traceparent.ts');

describe('examples/integrations/traceparent.ts', () => {
  it('runs cleanly: carried, refused without echo, explicit', () => {
    if (!existsSync(resolve(projectRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ correlation carried, refused, and given explicitly');
    expect(output).toContain('inbound traceparent refused (');
    expect(output).not.toContain('<script>');
  }, 30_000);
});
