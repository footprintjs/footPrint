/**
 * Loaded FIRST in every confined child (`--import`), before any code of the
 * working copy: `process.kill` refuses.
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
for (const name of ['kill', '_kill']) {
  if (name in process) Object.defineProperty(process, name, { value: refuse, writable: false, configurable: false });
}
