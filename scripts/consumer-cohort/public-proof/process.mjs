/** Fixed Node process port: finite output/time, argv data and no inherited credentials/options. */
import { spawnSync } from 'node:child_process';
const ENV_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'];
export function directNode(script, args, cwd, spawn = spawnSync) {
  const env = Object.fromEntries(
    ENV_KEYS.filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]),
  );
  const result = spawn(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}
