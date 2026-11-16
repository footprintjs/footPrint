/** Strict first-install materialization shared by source producers and consumer checks. */
import { leg } from '../../audit-consumers.mjs';
import { run } from '../../audit-process.mjs';
import { requireRanges } from '../plan/index.mjs';
import { verifyInstalled } from '../bytes/index.mjs';

/** Root development edges count; dependencies' development-only declarations do not install. */
export function closure(manifest, selections, family) {
  const names = new Set([...family.map((row) => row.package), 'footprint-storydeck']);
  const used = new Map();
  const visit = (current, root) => {
    requireRanges(current, selections, names, root);
    const wanted = new Set(root ? ['footprintjs', 'foottrace'] : []);
    for (const field of [
      'dependencies',
      ...(root ? ['devDependencies'] : []),
      'optionalDependencies',
      'peerDependencies',
    ])
      for (const name of Object.keys(current[field] ?? {})) if (names.has(name)) wanted.add(name);
    for (const name of wanted) {
      if (used.has(name)) continue;
      const row = selections.get(name);
      if (!row?.manifest) throw new Error(`selected package unavailable: ${name}`);
      used.set(name, row);
      visit(row.manifest, false);
    }
  };
  visit(manifest, true);
  return used;
}

/** Original peers are never changed. Unlike default linked mode, candidates precede first ci. */
export function installPaired(root, manifest, selections, family, io = { run }) {
  const used = closure(manifest, selections, family);
  const notes = new Set();
  const pins = [...used].filter(([name]) => name !== 'footprintjs').map(([name, row]) => `${name}@file:${row.path}`);
  const steps = leg(used.get('footprintjs').path, [root], pins, [], notes, [root], new Map([[root, manifest]]), {
    strategy: 'packaged',
    runCommand: io.run,
  });
  if (!steps[0]?.ok) throw new Error(`strict paired install failed: ${[...notes].join('; ')}`);
  verifyInstalled(root, used, selections.get('foottrace').version);
  return used;
}
