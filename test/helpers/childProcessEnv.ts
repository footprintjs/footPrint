import { delimiter, dirname } from 'node:path';

import { isolatedGitEnv } from '../../scripts/git-env.mjs';

/**
 * The host's temporary-directory pointers, passed through as set: the names Node's `os.tmpdir()`
 * reads (POSIX: TMPDIR, then TMP, then TEMP; Windows: TEMP, then TMP).
 *
 * Why they are here: a pointer grants nothing. The child can already write wherever the host's
 * user can; the variable only says WHERE the host keeps its scratch. Without it a child's
 * `os.tmpdir()` silently falls back to `/tmp` (or `%SystemRoot%\temp`), away from the host's own
 * temporary directory, and on a host whose `/tmp` is not writable (a sandbox) every `mkdtemp` in
 * the child fails. A value is copied as the host has it; an unset or empty one is not invented.
 *
 * One consequence to know: a child that listens on a Unix socket under its temp directory (tsx's
 * command line uses `<tmpdir>/tsx-<uid>/<pid>.pipe`) now does so under the host's path. A very long
 * temp path can exceed the platform's socket path limit (`listen` gave `EINVAL` at 168 characters;
 * the limit is about 104 bytes on macOS, 108 on Linux), so such a host fails loudly there, where `/tmp`
 * would have worked. It never fails silently, and GitHub's Linux runners leave `TMPDIR` unset.
 */
export const TEMP_DIR_ENV = Object.freeze(['TMPDIR', 'TMP', 'TEMP'] as const);

/** Limit fixture-child capabilities to command lookup, the host's temp directory and Windows startup. */
export function minimalChildEnv(
  source: Readonly<NodeJS.ProcessEnv>,
  executablePath = process.execPath,
): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {
    PATH: [dirname(executablePath), source.PATH].filter(Boolean).join(delimiter),
    ...(source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
  };
  for (const name of TEMP_DIR_ENV) if (source[name]) minimal[name] = source[name];
  return isolatedGitEnv(minimal);
}
