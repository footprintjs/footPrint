// Regression cases promoted from independent exact-head03b review.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, unlinkSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
vi.mock('../workspace/index.mjs', () => ({
  installPaired: (root) => {
    for (const name of ['footprintjs', 'foottrace']) {
      mkdirSync(join(root, 'node_modules', name), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', name, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
        }),
      );
    }
    return new Map();
  },
}));
import { auditPaired } from './index.mjs';
import { requireRanges } from '../plan/index.mjs';
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function runMutation(kind) {
  const root = mkdtempSync(join(tmpdir(), 'review-cohort-'));
  const roots = new Map();
  const templates = new Map();
  for (const name of ['app', 'source']) {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(kind === 'sibling-range' && name === 'source' ? { peerDependencies: { footprintjs: '^12.0.0' } } : {}),
      }),
    );
    writeFileSync(join(path, 'code.js'), 'original');
    git(path, 'init', '-b', 'main');
    git(path, 'add', '.');
    git(path, 'commit', '-m', 'original');
    templates.set(name, path);
  }
  const entry = {
    package: 'app',
    repo: 'fixed/app',
    dir: 'app',
    checks: ['check'],
    siblings: [{ dir: 'source', repo: 'fixed/source', sourceOnly: true }],
  };
  const row = {
    head: git(templates.get('app'), 'rev-parse', 'HEAD'),
    pr: 1,
    siblings: [{ package: 'source', head: git(templates.get('source'), 'rev-parse', 'HEAD'), pr: 2 }],
  };
  const io = {
    verifyHead: async () => {},
    verifyInstalled: () => {},
    clone: (spec, path) => {
      cpSync(templates.get(spec.dir), path, { recursive: true });
      roots.set(spec.dir, path);
      return null;
    },
    read: (cmd, args, cwd) =>
      execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    run: () => {
      if (kind === 'control') return { ok: true, status: 0 };
      if (kind === 'sibling-install') {
        mkdirSync(join(roots.get('source'), 'node_modules', 'footprintjs'), { recursive: true });
        writeFileSync(join(roots.get('source'), 'node_modules', 'footprintjs', 'package.json'), '{}');
      } else if (kind === 'ancestor-link') {
        const link = join(dirname(roots.get('app')), 'node_modules');
        unlinkSync(link);
        symlinkSync(root, link, 'dir');
      } else {
        const dir = roots.get(kind === 'sibling-manifest' ? 'source' : 'app');
        writeFileSync(
          join(dir, kind === 'sibling-manifest' ? 'package.json' : 'code.js'),
          kind === 'sibling-manifest' ? '{}' : 'mutated',
        );
        if (kind === 'staged') git(dir, 'add', 'code.js');
      }
      return { ok: true, status: 0 };
    },
  };
  try {
    return await auditPaired(
      {
        entry,
        row,
        root,
        family: [{ package: 'footprintjs' }, { package: 'foottrace' }],
        selections: new Map([
          ['foottrace', { version: '1.0.0' }],
          ['footprintjs', { version: '13.0.0-rc.0' }],
        ]),
      },
      io,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('independent mutation refusals', () => {
  it('accepts untouched source and dependency ownership', async () => {
    expect((await runMutation('control')).verdict).toBe('pass');
  });
  it('preflights borrowed source declarations against the actual installed cohort', async () => {
    await expect(runMutation('sibling-range')).rejects.toThrow('refuses the selected cohort');
  });
  it('refuses ordinary unstaged source mutation', async () => {
    await expect(runMutation('unstaged')).rejects.toThrow('source changed');
  });
  it('refuses staged source mutation', async () => {
    await expect(runMutation('staged')).rejects.toThrow('source changed');
  });
  it('refuses source-only sibling manifest mutation', async () => {
    await expect(runMutation('sibling-manifest')).rejects.toThrow();
  });
  it('refuses new independent source-only install', async () => {
    await expect(runMutation('sibling-install')).rejects.toThrow();
  });
  it('refuses changed ancestor module link', async () => {
    await expect(runMutation('ancestor-link')).rejects.toThrow();
  });
  it.each(['npm:agentfootprint@1.0.0', 'npm:footprintjs@1.0.0', 'npm:foottrace@1.0.0'])(
    'refuses unsupported alias %s',
    (range) => {
      expect(() =>
        requireRanges(
          { name: 'app', dependencies: { alias: range } },
          new Map(),
          new Set(['footprintjs', 'foottrace', 'agentfootprint']),
        ),
      ).toThrow();
    },
  );
});
