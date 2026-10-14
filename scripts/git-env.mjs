/**
 * The environment for a child `git` that must act on its own `cwd` — never on the repository
 * whose hook happens to be running.
 *
 * Why: a git hook (husky's pre-push runs the suite) exports repository-location variables such
 * as GIT_DIR and GIT_INDEX_FILE. A child `git` that inherits them ignores its `cwd` and operates
 * on THAT repository: `git init` in a temporary folder then flips the real checkout to
 * `core.bare = true`, and fixture commits land on the real branch. It happened on 2026-10-14
 * through test/architecture/trace-readiness.test.ts. Users: trace-ready.mjs, audit-process.mjs
 * (the audit's run/read boundary), audit-family-versions.mjs and that test.
 *
 * The list is git's own: `git rev-parse --local-env-vars` (git 2.50), plus the numbered
 * GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n pairs that GIT_CONFIG_COUNT introduces. Everything
 * else in the environment (PATH, HOME, SSH settings) is kept.
 */
export const REPO_LOCAL_GIT_ENV = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

const NUMBERED_CONFIG = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/** A copy of `env` without the repository-location variables; the input is not changed. */
export function isolatedGitEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (REPO_LOCAL_GIT_ENV.includes(key) || NUMBERED_CONFIG.test(key)) continue;
    out[key] = value;
  }
  return out;
}
