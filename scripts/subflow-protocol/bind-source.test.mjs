import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { bindSource } from './bind-source.mjs';
import { command } from './identity.mjs';

let scratch, repo, shallow, eventPath, common, base, head, preview, previewTree;
const env = {
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY_ID: '1234',
  GITHUB_REF: 'refs/pull/42/merge',
};

const git = (...args) =>
  command(
    'git',
    [
      '-c',
      'user.name=Source fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    repo,
  ).trim();

const payload = () => ({
  action: 'opened',
  number: 42,
  pull_request: { base: { ref: 'main', repo: { id: 1234 }, sha: base }, head: { sha: head, repo: { id: 9876 } } },
});

function bind(root, expected, event, overrides = {}) {
  writeFileSync(eventPath, JSON.stringify(event));
  return bindSource(root, { ...env, GITHUB_SHA: expected, GITHUB_EVENT_PATH: eventPath, ...overrides });
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'consumer-source-binding-'));
  repo = join(scratch, 'origin');
  shallow = join(scratch, 'shallow');
  eventPath = join(scratch, 'event.json');
  mkdirSync(repo);
  git('init', '--quiet');
  writeFileSync(join(repo, 'package.json'), '{"name":"footprintjs","version":"1.0.0"}\n');
  git('add', 'package.json');
  git('commit', '-qm', 'common');
  common = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'package.json'), '{"name":"footprintjs","version":"1.0.1"}\n');
  git('commit', '-qam', 'base');
  base = git('rev-parse', 'HEAD');
  git('switch', '--detach', '--quiet', common);
  writeFileSync(join(repo, 'candidate'), 'feature\n');
  git('add', 'candidate');
  git('commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD');
  previewTree = git('merge-tree', '--write-tree', base, head);
  preview = git('commit-tree', previewTree, '-p', base, '-p', head, '-m', 'preview');
  git('branch', 'preview', preview);
  git('clone', '--quiet', '--depth=1', '--branch', 'preview', pathToFileURL(repo).href, shallow);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test('admits a stale-head preview from its raw commit even in a depth-one checkout', () => {
  assert.throws(() => git('diff', '--exit-code', head, preview, '--'), /git failed/);
  const admitted = bind(shallow, preview, payload());
  assert.equal(admitted.head, preview);
  assert.equal(admitted.tree, previewTree);
  assert.equal(admitted.manifest.version, '1.0.1');
  assert.deepEqual(admitted.binding, {
    event: 'pull_request',
    repositoryId: '1234',
    parents: [base, head],
    pullRequest: 42,
  });
});

test('keeps the GitHub event SHA authoritative when the payload merge SHA disagrees', () => {
  for (const mergeCommit of [undefined, null, head]) {
    const event = payload();
    event.pull_request.merge_commit_sha = mergeCommit;
    assert.equal(bind(shallow, preview, event).head, preview);
  }
  assert.throws(() => bind(shallow, head, payload()), /Expected values to be strictly equal/);
});

test('a head that already includes main still has an admitted two-parent preview', () => {
  const updated = git('commit-tree', previewTree, '-p', base, '-m', 'updated head');
  const merged = git('commit-tree', previewTree, '-p', base, '-p', updated, '-m', 'updated preview');
  git('switch', '--detach', '--quiet', merged);
  const event = payload();
  event.pull_request.head.sha = updated;
  assert.deepEqual(bind(repo, merged, event).binding.parents, [base, updated]);
  assert.equal(git('rev-parse', updated + '^{tree}'), previewTree);
});

test('rejects stale parent pairs, wrong order, and the wrong number of parents', () => {
  for (const field of ['base', 'head']) {
    const event = payload();
    event.pull_request[field].sha = common;
    assert.throws(() => bind(shallow, preview, event), /synchronize the pull request or reopen it/);
  }
  for (const parents of [[head, base], [head], [base, head, common]]) {
    const variant = git('commit-tree', previewTree, ...parents.flatMap((parent) => ['-p', parent]), '-m', 'variant');
    git('switch', '--detach', '--quiet', variant);
    assert.throws(() => bind(repo, variant, payload()), /two parents|merge parents differ/);
  }
});

test('requires matching identity, target and event shape', () => {
  const event = payload();
  event.pull_request.base.repo.id = 9999;
  assert.throws(() => bind(shallow, preview, event), /base repository/);
  const retargeted = payload();
  retargeted.pull_request.base.ref = 'other';
  assert.throws(() => bind(shallow, preview, retargeted), /target main/);
  assert.throws(() => bind(shallow, preview, payload(), { GITHUB_REF: 'refs/pull/17/merge' }), /merge ref/);
  assert.throws(() => bind(shallow, preview, { ...payload(), action: 'edited' }), /request action/);
  assert.throws(() => bind(shallow, preview, { ...payload(), number: 0 }), /number is invalid/);
  assert.throws(() => bind(shallow, preview, { action: 'opened', number: 42 }), /base repository/);
  for (const invalid of [undefined, '', 'main', 'F'.repeat(40), 'a'.repeat(39), preview + '\n']) {
    assert.throws(() => bind(shallow, invalid, payload()), /event SHA/);
  }
});

test('requires a valid event file', () => {
  const identity = { ...env, GITHUB_SHA: preview };
  assert.throws(() => bindSource(shallow, identity), /event file is missing/);
  for (const malformed of ['{', 'null', '[]', 'true']) {
    writeFileSync(eventPath, malformed);
    assert.throws(() => bindSource(shallow, { ...identity, GITHUB_EVENT_PATH: eventPath }), /missing or malformed/);
  }
});

test('admits the exact input-free dispatch on a single-parent commit', () => {
  git('switch', '--detach', '--quiet', base);
  const dispatch = { GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const admitted = bind(repo, base, {}, dispatch);
  assert.deepEqual(admitted.binding, { event: 'workflow_dispatch', repositoryId: '1234', parents: [common] });
  assert.throws(() => bind(repo, base, { inputs: { sha: head } }, dispatch), /does not accept inputs/);
  for (const eventName of ['merge_group', 'pull_request_target', 'workflow_run']) {
    assert.throws(() => bind(repo, base, {}, { GITHUB_EVENT_NAME: eventName }), /unsupported consumer event/);
  }
});
