/**
 * Loaded FIRST in every confined child (`--import`), before any code of the
 * working copy: `process.kill`, `process._kill` and `process._debugProcess`
 * refuse. `_debugProcess(pid)` sends SIGUSR1 to any process of the user (it
 * ends a program without a handler, and asks a Node process to open its
 * debugger), so it is a way to signal like `kill`.
 *
 * Checked once on Node 24 for other ways to signal another process:
 * `process.binding` and `process._linkedBinding` (ERR_ACCESS_DENIED under the
 * permission model), `process.dlopen` (native addons are refused),
 * `child_process` (refused). Harmless, because they act on the child itself:
 * `process.abort`, `process.exit`, `process.reallyExit`, `process._debugEnd`,
 * `process._rawDebug` (writes to stderr).
 *
 * Why: Node's permission model does not stop a process from signalling
 * another, so the agent's code could stop the harness (or any process of the
 * same user). This is a SPEED BUMP, not a wall: code that finds another way to
 * send a signal is not stopped here. The wall is the session's sandbox
 * (RULE.md, rule 8): a paid batch runs inside it, where a signal to a process
 * outside the sandbox is refused, so the most the agent's code can stop is
 * the batch itself, and then the run is kept as `interrupted` (rule 2).
 * Example: `process.kill(process.ppid, 0)` in the copy → throws ERR_ACCESS_DENIED.
 */
const refuse = () => {
  throw Object.assign(new Error('process.kill is refused in this run'), { code: 'ERR_ACCESS_DENIED' });
};
for (const name of ['kill', '_kill', '_debugProcess']) {
  if (name in process) Object.defineProperty(process, name, { value: refuse, writable: false, configurable: false });
}
