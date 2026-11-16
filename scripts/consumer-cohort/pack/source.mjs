/** Native source build/pack boundary. No published archive is transformed here. */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceOrigin } from '../origin/index.mjs';
import { requireSource } from '../workspace/identity.mjs';
import { installPaired } from '../workspace/index.mjs';
import { verifyInstalled } from '../bytes/index.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A real local output is packed with hooks off; source manifest restored before packing. */
function packLocal(dir, folder, io) {
  const result = JSON.parse(io.read('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', folder], dir));
  const filename = result?.[0]?.filename;
  if (typeof filename !== 'string' || basename(filename) !== filename) throw new Error('npm did not identify its pack');
  return join(folder, filename);
}

export async function produceSource(
  { dir, row, manifest, recipe, selected, family, workspace, expectedTrace },
  io,
  save,
  services = {},
) {
  const ports = { installPaired, verifyInstalled, ...services };
  const packageFile = join(dir, 'package.json'),
    lockFile = join(dir, 'package-lock.json');
  requireSource(dir, row.head, [], io);
  const original = readFileSync(packageFile),
    lock = existsSync(lockFile) ? readFileSync(lockFile) : null;
  const origin = sourceOrigin(recipe.repo, row, io.read('git', ['rev-parse', 'HEAD^{tree}'], dir), original);
  const restore = () => {
    writeFileSync(packageFile, original);
    if (lock === null) rmSync(lockFile, { force: true });
    else writeFileSync(lockFile, lock);
  };
  try {
    const used = ports.installPaired(dir, manifest, selected, family, io);
    const installManifest = readFileSync(packageFile),
      installedLock = readFileSync(lockFile);
    const checks = [];
    const verifySetup = () => {
      ports.verifyInstalled(dir, used, expectedTrace);
      if (!readFileSync(packageFile).equals(installManifest))
        throw new Error('producer install manifest changed during build');
      if (!readFileSync(lockFile).equals(installedLock)) throw new Error('producer paired lock changed during build');
      requireSource(dir, row.head, ['package.json', 'package-lock.json'], io);
    };
    const execute = (commands, verify) => {
      for (const command of commands) {
        verify();
        const result = io.run(command, dir);
        verify();
        checks.push({ command, ...result });
        if (!result.ok || result.status !== 0)
          throw new Error(`${row.package}: native source check failed: ${command}`);
      }
    };
    execute([...(recipe.beforeBuild ?? []), recipe.build], verifySetup);
    origin.installManifestHash = hash(installManifest);
    origin.installLockHash = hash(installedLock);
    restore();
    const verifyOriginal = () => {
      ports.verifyInstalled(dir, used, expectedTrace);
      requireSource(dir, row.head, [], io);
    };
    execute(recipe.packageChecks ?? [], verifyOriginal);
    origin.checks = checks;
    requireSource(dir, row.head, [], io);
    const staged = Buffer.from(`${JSON.stringify({ ...manifest, version: row.version }, null, 2)}\n`);
    writeFileSync(packageFile, staged);
    save(row.package, packLocal(dir, workspace, io), manifest, {
      head: row.head,
      tree: origin.tree,
      sourceManifestHash: hash(original),
      recipe: recipe.build,
      origin,
    });
    if (!readFileSync(packageFile).equals(staged)) throw new Error('producer staged manifest changed during pack');
    requireSource(dir, row.head, ['package.json'], io);
  } finally {
    restore();
    requireSource(dir, row.head, [], io);
  }
}
