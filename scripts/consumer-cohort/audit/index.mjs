/** A paired result has one acceptance law: every original command actually ran and passed. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clone, prepareWorkspace, aptInstall, aptFailure } from '../../audit-consumers.mjs';
import { read, run } from '../../audit-process.mjs';
import { connectSourceWorkspace, sourceWorkspaceProblem } from '../../consumer-workspace.mjs';
import { requireSource } from '../workspace/identity.mjs';
import { installPaired } from '../workspace/index.mjs';
import { requireRanges, verifyHead } from '../plan/index.mjs';
import { verifyInstalled } from '../bytes/index.mjs';

export function pairedVerdict(checks, steps) {
  return Array.isArray(steps) &&
    steps.length === checks.length &&
    Array.from(steps).every((row, i) => row?.key === checks[i] && row.ok === true && !row.skipped)
    ? 'pass'
    : 'BLOCKING';
}

export async function auditPaired({ entry, row, root, family, selections }, services = {}) {
  const io = { run, read, clone, verifyHead, verifyInstalled, ...services };
  const home = mkdtempSync(join(tmpdir(), 'fp-cohort-consumer-'));
  const notes = new Set();
  const steps = [];
  const checks = [...(entry.setup ? [entry.setup] : []), ...entry.checks];
  try {
    await io.verifyHead(entry.repo, row);
    for (const sibling of entry.siblings ?? []) {
      const selected = row.siblings.find((item) => item.package === sibling.dir);
      await io.verifyHead(sibling.repo, selected);
    }
    for (const tool of entry.apt ?? []) {
      const result = io.run(aptInstall(tool), home);
      if (!result.ok) throw new Error(aptFailure(tool, result.status));
    }
    symlinkSync(root, join(home, 'footPrint'));
    const commits = new Map([
      [entry.dir, row.head],
      ...(entry.siblings ?? []).map((s) => [s.dir, row.siblings.find((item) => item.package === s.dir).head]),
    ]);
    // Same authored source/sibling handling. Packaged materialization deliberately avoids the
    // default linked path's initial npm ci against unavailable future registry candidates.
    const workspace = prepareWorkspace(
      { ...entry, installStrategy: 'packaged' },
      home,
      { local: false },
      io,
      notes,
      commits,
    );
    if (workspace.stop) throw new Error(workspace.stop);
    const familyNames = new Set(family.map((item) => item.package));
    for (const sibling of workspace.installOptions.sourceOnly)
      requireRanges(JSON.parse(readFileSync(join(sibling, 'package.json'), 'utf8')), selections, familyNames, false);
    const manifest = workspace.originalManifests.get(workspace.dir);
    const used = installPaired(workspace.dir, manifest, selections, family, io);
    const plannedManifest = readFileSync(join(workspace.dir, 'package.json'));
    const sourceProblem = connectSourceWorkspace(workspace.dir, workspace.installOptions.sourceOnly);
    if (sourceProblem) throw new Error(sourceProblem);
    const ancestor = workspace.installOptions.sourceOnly.length ? realpathSync(join(home, 'node_modules')) : null;
    const verify = () => {
      io.verifyInstalled(workspace.dir, used, selections.get('foottrace').version);
      if (!readFileSync(join(workspace.dir, 'package.json')).equals(plannedManifest))
        throw new Error('consumer manifest changed after pairing');
      const ownershipProblem = sourceWorkspaceProblem(workspace.dir, workspace.installOptions.sourceOnly);
      if (ownershipProblem) throw new Error(ownershipProblem);
      if (ancestor && realpathSync(join(home, 'node_modules')) !== ancestor)
        throw new Error('source-only borrowed dependency owner changed');
      for (const checkout of workspace.checkouts)
        requireSource(
          checkout.path,
          commits.get(checkout.dir),
          checkout.path === workspace.dir ? ['package.json', 'package-lock.json'] : [],
          io,
        );
    };
    // No default latest/planRange/own-failure/flaky/report-only path and no published leg.
    for (const check of checks) {
      verify();
      const result = io.run(check, workspace.dir);
      verify();
      steps.push({ key: check, ...result });
    }
    await io.verifyHead(entry.repo, row);
    for (const sibling of entry.siblings ?? [])
      await io.verifyHead(
        sibling.repo,
        row.siblings.find((item) => item.package === sibling.dir),
      );
    return { verdict: pairedVerdict(checks, steps), head: row.head, checks: steps, notes: [...notes] };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function auditStage(scope) {
  const { input, ports } = scope.$getEnv();
  const row = scope.plan.consumers.find((item) => item.package === input.consumer);
  const entry = input.family.find((item) => item.package === input.consumer && item.checks);
  if (!row || !entry) throw new Error('consumer not in complete source plan');
  const selections = ports.verifyBundle(input.receipt, scope.plan, input.context, input.folder);
  for (const selected of scope.plan.packages) await ports.verifyHead(ports.recipes[selected.package].repo, selected);
  scope.result = await ports.auditPaired({ entry, row, root: input.root, family: input.family, selections });
  for (const selected of scope.plan.packages) await ports.verifyHead(ports.recipes[selected.package].repo, selected);
}
