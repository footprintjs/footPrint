import { delimiter, dirname } from 'node:path';

import { isolatedGitEnv } from '../../scripts/git-env.mjs';

/** Limit fixture-child capabilities to command lookup and Windows startup requirements. */
export function minimalChildEnv(
  source: Readonly<NodeJS.ProcessEnv>,
  executablePath = process.execPath,
): NodeJS.ProcessEnv {
  const minimal = {
    PATH: [dirname(executablePath), source.PATH].filter(Boolean).join(delimiter),
    ...(source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
  };
  return isolatedGitEnv(minimal);
}
