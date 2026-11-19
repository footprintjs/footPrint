/** Process boundary shared by audit orchestration and installation. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { isolatedGitEnv } from './git-env.mjs';
const CI = process.env.GITHUB_ACTIONS === 'true';

/**
 * Run one shell command in `cwd` with its output streamed; `{ ok, seconds, status }`. `status` is the
 * command's exit status (`null` when a signal ended it), for a caller that has to say WHY it failed.
 * In CI the output is data: between `stop-commands` and its random token, nothing a consumer prints
 * (a test reporter's `::error`) becomes a workflow command, so the run's annotations are this audit's
 * verdicts.
 */
export function run(command, cwd) {
  const started = Date.now();
  const token = randomUUID();
  console.log(CI ? `::group::${command}\n::stop-commands::${token}` : `\n$ ${command}    # in ${cwd}`);
  const { status } = spawnSync('bash', ['-c', command], { cwd, env: isolatedGitEnv(), stdio: 'inherit' });
  if (CI) console.log(`::${token}::\n::endgroup::`);
  return { ok: status === 0, seconds: Math.round((Date.now() - started) / 1000), status };
}

/** Every child here runs in its own `cwd`: none inherits the repository of a git hook (git-env.mjs). */
export const read = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();
export const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command that installs one system tool with apt-get (CI, `--apt`). A tool that is already
 * on PATH is not installed again. Each apt-get call is BOUNDED: a few tries per download, a time limit
 * per connection, and `timeout` around the whole call.
 *
 * WHY: on 2026-11-11 the runners could not resolve Ubuntu's archive for some hours. `apt-get update`
 * gave up after three and a half minutes with warnings, then `apt-get install ffmpeg` kept trying with
 * no limit, and three audits ran into the job's 60 minute timeout: no verdict, and no reason in the
 * summary. The primary attempt gives up in about ten minutes. If the FFmpeg install fails, retry once
 * through the Ubuntu US archive with the same bounds. Give the copy of the image's deb822 sources a
 * different URI while preserving the signed suites, components and keyring. Keep the runner's source
 * files and original mirror indexes in place.
 *
 * WHY `;` AND NOT `&&` after the update: a refresh that failed decides nothing. The install is tried
 * against whatever index is there, inside its own limit, and whether IT succeeds is the answer.
 */
export function aptInstall(tool) {
  const apt = (minutes) =>
    `sudo timeout --kill-after=15s ${minutes}m apt-get ` +
    '-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60';
  const install = (options = '') => `${apt(4)}${options} update -qq; ${apt(6)}${options} install -y -qq ${tool}`;
  const primary = install();
  if (tool !== 'ffmpeg') return `command -v ${tool} >/dev/null || { ${primary}; }`;

  const mirror = 'https://us.archive.ubuntu.com/ubuntu/';
  const alternate =
    ' -o Dir::Etc::sourcelist="$alternate_sources/ubuntu.sources" -o Dir::Etc::sourceparts=-' +
    ' -o APT::Get::List-Cleanup=false';
  return `command -v ${tool} >/dev/null || { ${primary} || (
    primary_status=$?
    ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
    [ -r "$ubuntu_sources" ] || exit "$primary_status"
    alternate_sources=$(mktemp -d) || exit "$primary_status"
    trap 'rm -rf -- "$alternate_sources"' EXIT
    sed -E 's|^URIs:[[:blank:]]+.*|URIs: ${mirror}|' "$ubuntu_sources" > "$alternate_sources/ubuntu.sources" ||
      exit "$primary_status"
    cmp -s "$ubuntu_sources" "$alternate_sources/ubuntu.sources" && exit "$primary_status"
    echo 'Retrying the FFmpeg install through ${mirror}' >&2
    ${install(alternate)}
  ); }`;
}

/**
 * What the audit says when {@link aptInstall} failed. `timeout` ends a call that ran past its limit
 * with status 124, or 137 when it had to kill it; any other status is apt-get's own (a package it
 * could not find, a lock, a broken download). The two are told apart, because "the archive did not
 * answer" and "the package is not there" are fixed by different people.
 */
export function aptFailure(tool, status) {
  const why =
    status === 124 || status === 137
      ? 'it did not finish within its time limit (a mirror or a name server may be down)'
      : `apt-get failed${typeof status === 'number' ? ` with status ${status}` : ''}`;
  return `could not install ${tool}: ${why}; see the log. Not checked`;
}
