/** Bind each engine pack to GitHub's exact event checkout and ordered merge parents. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bytes, command, source } from './identity.mjs';

export const ENGINE_RECEIPT_VERSION = 2;

const commitId = /^[a-f0-9]{40}$/;
const prActions = ['opened', 'synchronize', 'reopened'];

function eventOf(path) {
  assert.ok(path, 'consumer event file is missing');
  try {
    const event = JSON.parse(bytes(path, 2 * 1024 * 1024));
    assert.ok(event && Object.getPrototypeOf(event) === Object.prototype);
    return event;
  } catch {
    throw new Error('consumer event file is missing or malformed');
  }
}

function parentsOf(root) {
  // Raw commit headers expose the parent IDs even in a depth-one checkout.
  const [header] = command('git', ['cat-file', 'commit', 'HEAD'], root).split('\n\n', 1);
  return header
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice(7));
}

export function bindSource(root, env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME;
  const repositoryId = env.GITHUB_REPOSITORY_ID;
  const expected = env.GITHUB_SHA;
  assert.ok(eventName === 'pull_request' || eventName === 'workflow_dispatch', 'unsupported consumer event');
  assert.match(repositoryId ?? '', /^[1-9][0-9]*$/, 'consumer repository ID is missing or invalid');
  assert.match(expected ?? '', commitId, 'consumer event SHA is missing or invalid');
  const event = eventOf(env.GITHUB_EVENT_PATH);
  const witness = source(root, expected);
  const parents = parentsOf(root);

  if (eventName === 'workflow_dispatch') {
    const inputs = event.inputs;
    assert.ok(
      inputs === undefined ||
        inputs === null ||
        (Object.getPrototypeOf(inputs) === Object.prototype && Object.keys(inputs).length === 0),
      'consumer dispatch does not accept inputs',
    );
    return { ...witness, binding: { event: eventName, repositoryId, parents } };
  }

  assert.ok(prActions.includes(event.action), 'unsupported consumer pull request action');
  const pullRequest = event.number;
  assert.ok(Number.isSafeInteger(pullRequest) && pullRequest > 0, 'consumer pull request number is invalid');
  assert.equal(env.GITHUB_REF, 'refs/pull/' + pullRequest + '/merge', 'consumer pull request merge ref does not match');
  const base = event.pull_request?.base;
  assert.equal(String(base?.repo?.id), repositoryId, 'consumer pull request base repository does not match');
  assert.equal(base.ref, 'main', 'consumer pull request must target main');
  const head = event.pull_request.head?.sha;
  assert.match(base.sha ?? '', commitId, 'consumer pull request base SHA is missing or invalid');
  assert.match(head ?? '', commitId, 'consumer pull request head SHA is missing or invalid');
  assert.equal(parents.length, 2, 'consumer pull request checkout must have two parents');
  assert.deepEqual(
    parents,
    [base.sha, head],
    'consumer merge parents differ from the event; synchronize the pull request or reopen it to obtain a fresh preview',
  );
  return { ...witness, binding: { event: eventName, repositoryId, parents, pullRequest } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { head, tree, binding } = bindSource(process.cwd());
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Consumers tested source',
        '',
        '- Event: `' + binding.event + '`',
        '- Commit: `' + head + '`',
        '- Tree: `' + tree + '`',
        '- Ordered parents: ' + (binding.parents.map((id) => '`' + id + '`').join(', ') || 'none'),
        '',
      ].join('\n') + '\n',
    );
  }
}
