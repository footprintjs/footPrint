/** Process boundary shared by audit orchestration and installation. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const CI = process.env.GITHUB_ACTIONS === 'true';

/**
 * Run one shell command in `cwd` with its output streamed; `{ ok, seconds }`. In CI the output is
 * data: between `stop-commands` and its random token, nothing a consumer prints (a test reporter's
 * `::error`) becomes a workflow command, so the run's annotations are this audit's verdicts.
 */
export function run(command, cwd) {
  const started = Date.now();
  const token = randomUUID();
  console.log(CI ? `::group::${command}\n::stop-commands::${token}` : `\n$ ${command}    # in ${cwd}`);
  const { status } = spawnSync('bash', ['-c', command], { cwd, stdio: 'inherit' });
  if (CI) console.log(`::${token}::\n::endgroup::`);
  return { ok: status === 0, seconds: Math.round((Date.now() - started) / 1000) };
}

export const read = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
export const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
