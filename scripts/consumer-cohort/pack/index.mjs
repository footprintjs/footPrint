/** Same-run producer. No foreign artifact downloader, publisher or promoted version file. */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { clone } from '../../audit-consumers.mjs';
import { read, run } from '../../audit-process.mjs';
import { relabelCandidate } from '../../consumer-relabel.mjs';
import { requireSource } from '../workspace/identity.mjs';
import { installPaired } from '../workspace/index.mjs';
import { recipes, requireRanges, buildOrder, verifyHead, hash } from '../plan/index.mjs';
import { inspectPacked, integrity, verifyInstalled } from '../bytes/index.mjs';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const names = (family) => new Set([...family.map((row) => row.package), 'footprint-storydeck']);

async function registryManifest(row, get = fetch) {
  const response = await get(
    `https://registry.npmjs.org/${encodeURIComponent(row.package)}/${encodeURIComponent(row.version)}`,
    {
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`${row.package}@${row.version}: registry HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.name !== row.package || manifest.version !== row.version || manifest.dist?.integrity !== row.integrity)
    throw new Error('registry selection identity differs');
  return manifest;
}

/** A real local output is packed with hooks off; source manifest restored before packing. */
function packLocal(dir, folder, io) {
  const result = JSON.parse(io.read('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', folder], dir));
  const filename = result?.[0]?.filename;
  if (typeof filename !== 'string' || basename(filename) !== filename) throw new Error('npm did not identify its pack');
  return join(folder, filename);
}

/** Fixed normal build recipes, dependency ordered from authored manifests. */
export async function produce({ plan, context, folder, root, family }, services = {}) {
  const io = { run, read, verifyHead, registryManifest, ...services };
  const workspace = mkdtempSync(join(tmpdir(), 'fp-cohort-pack-'));
  const selected = new Map();
  const receipts = [];
  const sourceSelections = [];
  const save = (name, originalPath, manifest, more = {}) => {
    const path = join(folder, `${name}.tgz`);
    if (originalPath !== path) copyFileSync(originalPath, path);
    const observed = inspectPacked(path, manifest);
    const row = { ...observed, filename: `${name}.tgz`, ...more };
    receipts.push(row);
    if (more.head) sourceSelections.push(row);
    selected.set(name, { ...observed, path });
  };
  try {
    const engineSource = context.manifest;
    const labelled = relabelCandidate(
      join(folder, 'footprintjs-candidate.tgz'),
      plan.engineVersion,
      join(workspace, 'engine'),
    );
    save(
      'footprintjs',
      labelled,
      { ...engineSource, version: plan.engineVersion },
      {
        head: context.head,
        checkout: context.checkout,
        tree: context.tree,
        sourceManifestHash: hash(Buffer.from(JSON.stringify(engineSource))),
      },
    );
    // Only immutable registry selections. npm pack downloads; it runs no package lifecycle script.
    for (const row of plan.registry) {
      const metadata = await io.registryManifest(row);
      const packed = JSON.parse(
        io.read(
          'npm',
          [
            'pack',
            `${row.package}@${row.version}`,
            '--ignore-scripts',
            '--json',
            '--registry=https://registry.npmjs.org',
            '--pack-destination',
            workspace,
          ],
          root,
        ),
      );
      const filename = packed?.[0]?.filename;
      if (typeof filename !== 'string' || basename(filename) !== filename)
        throw new Error('registry pack path invalid');
      const path = join(workspace, filename);
      if (integrity(readFileSync(path)) !== row.integrity) throw new Error('registry bytes differ from selected SRI');
      // Registry metadata has dist/readme/private service fields outside the published manifest.
      const { packedManifest } = await import('../bytes/index.mjs');
      const manifest = packedManifest(path, row.package);
      if (manifest.name !== metadata.name || manifest.version !== metadata.version)
        throw new Error('registry package differs');
      save(row.package, path, manifest);
    }
    const manifests = new Map();
    const directories = new Map();
    for (const row of plan.packages) {
      const recipe = recipes[row.package];
      await io.verifyHead(recipe.repo, row);
      const dir = join(workspace, recipe.dir);
      const problem = clone({ ...recipe, branch: 'main', commit: row.head }, dir, { local: false }, io);
      if (problem) throw new Error(problem);
      const manifest = json(join(dir, 'package.json'));
      if (manifest.name !== row.package || manifest.version !== row.version)
        throw new Error('authored candidate version differs');
      manifests.set(row.package, manifest);
      directories.set(row.package, dir);
    }
    const versions = new Map([...selected, ...plan.packages.map((row) => [row.package, row])]);
    for (const row of selected.values()) requireRanges(row.manifest, versions, names(family), false);
    for (const manifest of manifests.values()) requireRanges(manifest, versions, names(family));
    for (const row of buildOrder(plan.packages, manifests)) {
      const dir = directories.get(row.package);
      const manifest = manifests.get(row.package);
      const original = readFileSync(join(dir, 'package.json'));
      const used = installPaired(dir, manifest, selected, family, io);
      if (!io.run(recipes[row.package].build, dir).ok) throw new Error(`${row.package}: candidate build failed`);
      verifyInstalled(dir, used, plan.registry.find((item) => item.package === 'foottrace').version);
      // No file:/workspace requests leak into the packed source manifest.
      writeFileSync(join(dir, 'package.json'), original);
      requireSource(dir, row.head, ['package-lock.json'], io);
      save(row.package, packLocal(dir, workspace, io), manifest, {
        head: row.head,
        tree: io.read('git', ['rev-parse', 'HEAD^{tree}'], dir),
        sourceManifestHash: hash(original),
        recipe: recipes[row.package].build,
      });
    }
    // An existing published label may be reused only for exactly those registry bytes. A 404
    // observes absence, not a reservation or authorization to publish.
    for (const row of sourceSelections) {
      const response = await (services.fetch ?? fetch)(
        `https://registry.npmjs.org/${encodeURIComponent(row.package)}/${encodeURIComponent(row.version)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (response.status === 404) continue;
      if (!response.ok || (await response.json()).dist?.integrity !== row.integrity)
        throw new Error(`${row.package}@${row.version}: existing label collision or registry unreadable`);
    }
    const receipt = { schema: 1, planHash: plan.hash, context, packages: receipts };
    writeFileSync(join(folder, 'cohort.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function packStage(scope) {
  const { input, ports } = scope.$getEnv();
  await ports.produce({ ...input, plan: scope.plan });
  scope.completed = true;
}
