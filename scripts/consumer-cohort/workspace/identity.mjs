/** Compare actual tracked bytes to HEAD, including staged changes; HEAD identity alone is insufficient. */
import { read } from '../../audit-process.mjs';

export function requireSource(dir, head, installManifests, io = { read }) {
  const paths = ['.', ...installManifests.map((file) => `:(exclude)${file}`)];
  if (
    io.read('git', ['rev-parse', 'HEAD'], dir) !== head ||
    io.read('git', ['diff', '--name-only', 'HEAD', '--', ...paths], dir)
  )
    throw new Error('consumer or producer source changed during checks');
}
