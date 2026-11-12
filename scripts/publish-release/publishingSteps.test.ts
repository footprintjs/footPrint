import { describe, expect, it } from 'vitest';

import { publishes } from './publishingSteps';

describe('what counts as publishing text', () => {
  it.each([
    'npm publish',
    'env npm publish "$DIR/package.tgz"',
    'sudo -E npm --registry=https://registry.npmjs.org publish ./package.tgz',
    '/usr/local/bin/npm publish',
    'npx --yes some-tool publish',
    'pnpm publish',
    'yarn npm publish',
    'echo start\nnpm \\\n  publish',
    'bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh" publish',
    'bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh" publish\necho done',
    "bash '$X/run.sh' publish",
  ])('publishes: %s', (run) => {
    expect(publishes({ run })).toBe(true);
  });

  it('an action named for publishing counts', () => {
    expect(publishes({ uses: 'someone/npm-publish@v1' })).toBe(true);
  });

  it.each([
    'npm ci',
    'npm install -g npm@11.19.0 --ignore-scripts --registry=https://registry.npmjs.org',
    'npx publint',
    'npx @arethetypeswrong/cli --pack',
    'npm run test:examples',
    'bash scripts/publish-release/run.sh admit',
    'bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh" admit',
    '# npm publish is done elsewhere\nnpm pack',
    'echo "published" ; npm pack',
    'npm pack\nmv ./*.tgz package.tgz',
  ])('does not publish: %s', (run) => {
    expect(publishes({ run })).toBe(false);
  });

  it('a step with no run and an ordinary action does not publish', () => {
    expect(publishes({ uses: 'actions/checkout@v7' })).toBe(false);
    expect(publishes({})).toBe(false);
  });
});
