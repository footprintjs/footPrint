/** Bind a candidate to one event's exact reviewed revision, without changing the checkout. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { command } from './identity.mjs';

export function bindSource(root, expectedHead) {
  assert.match(expectedHead ?? '', /^[a-f0-9]{40}$/);
  command('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', expectedHead], root);
  command('git', ['diff', '--exit-code', expectedHead, 'HEAD', '--'], root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  bindSource(process.cwd(), process.env.PROTOCOL_ENGINE_HEAD);
