/** The maintained 9.x line must never replace the current major's npm latest tag. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function maintenanceChannel(pkg, releaseTag) {
  if (pkg?.name !== 'footprintjs' || !/^9\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg?.version ?? ''))
    throw new Error('Maintenance publication requires a stable footprintjs 9.x package');
  if (releaseTag !== `v${pkg.version}`)
    throw new Error('Release tag must match the checked package version exactly');
  return 'legacy-9';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  console.log(`dist_tag=${maintenanceChannel(pkg, process.env.RELEASE_TAG)}`);
}
