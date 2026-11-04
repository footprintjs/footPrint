import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

const { candidateMatchesSource } = createRequire(resolve('scripts/publish-release/candidate-version.test.ts'))(
  './candidate-version.cjs',
);

it.each(['10.7.2-rc.0', '10.8.0-rc.1', '11.0.0-rc.999'])(
  'accepts one patch, minor or major source bump: %s',
  (candidate) => {
    expect(candidateMatchesSource(candidate, '10.7.1')).toBe(true);
  },
);

it.each([
  '10.7.1-rc.1',
  '10.7.3-rc.1',
  '10.9.0-rc.1',
  '11.1.0-rc.1',
  '99.0.0-rc.1',
  '11.0.0',
  'v11.0.0-rc.1',
  '11.0.0-rc.01',
  '11.0.0-rc.1\n',
  '9007199254740991.0.0-rc.1',
  '1'.repeat(129) + '.0.0-rc.1',
  null,
  11,
])('refuses a malformed or unrelated candidate: %j', (candidate) => {
  expect(candidateMatchesSource(candidate, '10.7.1')).toBe(false);
});

it.each(['10.07.1', '10.7.1-rc.1', '9007199254740991.7.1', null, 10])(
  'refuses a source without a bounded canonical stable version: %j',
  (source) => {
    expect(candidateMatchesSource('11.0.0-rc.1', source)).toBe(false);
  },
);
