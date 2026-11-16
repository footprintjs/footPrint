# One native pause with a transactional host

Private support for the adjacent numbered example, using Node's built-in SQLite. Requires Node 22.16+ or Node 24 on Linux/macOS for the private POSIX modes and process-kill proof. Nothing here is an exported FootPrint API or a production host adapter. There is no extra npm dependency and no service, model or cloud call.

The chart prepares a synthetic operation, pauses through `addPausableFunction`, then uses `decide()` to follow the host's recorded reply/timer winner. It writes only `reply-recorded` or `waiting-ended`; neither says a remote order failed or succeeded. A new executor in a new process consumes the exact stored checkpoint. Native checkpoint decoding stays in FootPrint; record readers stay in Foottrace.

## Owners

| Module | Responsibility |
| --- | --- |
| `workflow.cjs`, `stages/` | Chart wiring and small stage owners. A separate fixed negative-test variant pauses a second time. |
| `identity.cjs` | Fixed source/built loaders, actual SDK/program/dependency file identities, bounded JSON and owned private paths. |
| `store.cjs` | Atomic checkpoint/wait/outbox, inbox/winner/task, claims, private admission and fenced terminal result. |
| `worker.cjs` | Genuine native producer/resumer; bounded private pipe input and allowlisted safe output. No checkpoint-bearing argv. |
| `host.cjs`, `host.d.cts` | Finite scenario driver and its typed example entry. Owns all scratch and children. |
| `store.test.cjs` | Adjacent store behavior and deliberately broken-policy checks, independent of the SDK. |
| `test/lib/pause/durable-sqlite-host.test.ts` | Source-mode genuine integration. The existing examples gate runs the numbered built-mode example separately. |

## Meaning of a wait

The example uses one fixed workflow/operation/generation and test principals. These names and epochs are not credentials. They model an already authorized caller; production authentication, revocation and tenant isolation need their own adapter contract.

An injected SQLite clock samples time inside a serialized write transaction. Replies admitted strictly before `dueAt` are eligible; the timer wins the exact tie. The first eligible stored receipt wins. Sample time is not wall time at commit or provider completion time. A delayed scheduler cannot promote a newly arriving late reply.

A lease caps host result publication and an increasing epoch fences stale workers. The original business expiry does not reset on resume. Native timeout uses the remaining duration, never injected store timestamps minus wall-clock time. A lease does not stop an old process or an outside effect.

Checkpoint bytes, the immutable decision, and task ownership are validated before native resume. Digests establish byte consistency, not authenticity against someone allowed to rewrite storage. The installed Foottrace version must match the repository lock's pin; actual file digests are recorded separately, without treating the lock as proof of those bytes. There is no fallback to an earlier installed SDK.

The identity covers the selected chart helpers, source or built SDK files, and resolved Foottrace files. Built mode also checks that the package's public entry resolves to this repository's `dist/index.js`. These hashes do not attest Node, `tsx`, esbuild, the operating system or the whole loader toolchain. The report records actual Node/SQLite versions separately; a lockfile is not proof that every installed executable byte is authentic.

## Boundaries kept visible

- Operational checkpoints retain real private state. A synthetic private sentinel must never appear in public output, even though the narrative policy redacts it. Files stay in an owned 0700 directory with 0600 database and effect files.
- A genuine continuation can append a synthetic effect and die before result publication. Recovery can repeat it: two effects, one logical task. Provider idempotency or authoritative status reconciliation remains necessary.
- A second native pause is refused as unsupported by this one-generation host; it is not marked complete.
- A native failed continuation stores a failed outcome and its actual safe failure identity. Host task completion is not a successful workflow verdict.
- No production scheduler, retention garbage collector, cancellation, distributed-store/power-loss guarantee, nested or parallel wait, historical read-ancestry join or physical root cause is proved.

The driver removes its temporary database/WAL files, effect ledgers and synchronization files and settles all owned child processes in `finally`. It never prints raw child stderr, private checkpoints or state. Source and built modes have separate identities; the source-mode proof is not a substitute for the built-package CI gate.

## Refusal and recovery

| Refusal | Next step |
| --- | --- |
| Missing/mismatched locked runtime or built entry | Install the reviewed lock and build this checkout before running the example. |
| Checkpoint/program/SDK mismatch | Select its pinned program and stored bytes; do not relabel or rewrite a checkpoint to pass admission. |
| Active, stale or expired worker | Read current task ownership; recover only through a fresh authorized claim. Check outside status before repeating an ambiguous effect. |
| Storage unavailable | The result is unknown; restore storage and read the durable decision before dispatch/resume. |
| Unsupported next pause | Keep this example to one wait, or implement and prove atomic next-generation publication before adoption. |
| Unexpected native/child failure | Inspect the bounded local test and exact source; private state is deliberately absent from public errors. |
