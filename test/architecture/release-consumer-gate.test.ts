import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { minimalChildEnv } from '../helpers/childProcessEnv';

const release = readFileSync(resolve(__dirname, '../../scripts/release.sh'), 'utf8');
const gate = release.slice(release.indexOf('HEAD_SHA='), release.indexOf('# ── Gate 2:'));
const fakeGitHub = `
git() { echo 57f59e72911025fd04c8f73de20483cd4a0f173a; }
gh() {
  args=" $* "
  case "$args" in
    *" --commit 57f59e72911025fd04c8f73de20483cd4a0f173a "*) ;;
    *) return 1 ;;
  esac
  case "$args" in
    *" --event workflow_dispatch "*) printf '%s' "$MANUAL_RESULT" ;;
    *) echo 'completed success https://example.invalid/pr-run' ;;
  esac
}
`;

describe('the local release consumer gate', () => {
  it.each([
    ['only a green PR run', '', 1],
    ['a red manual run', 'completed failure https://example.invalid/manual-run', 1],
    ['a running manual audit', 'in_progress  https://example.invalid/manual-run', 1],
    ['a green manual run', 'completed success https://example.invalid/manual-run', 0],
  ])('checks the exact dispatch result with %s', (_label, result, expected) => {
    const invocation = spawnSync('bash', ['-euo', 'pipefail'], {
      input: fakeGitHub + gate,
      encoding: 'utf8',
      env: { ...minimalChildEnv(process.env), MANUAL_RESULT: result },
      timeout: 3000,
    });
    expect(invocation.error).toBeUndefined();
    expect(invocation.status, invocation.stderr).toBe(expected);
  });
});
