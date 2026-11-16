# Resume a stored wait in a new process

This example uses FootPrint's existing pause/resume APIs and a private SQLite host. The waiting process exits. A different process loads the saved checkpoint and the one recorded reply-or-timer decision, validates its current worker claim, and calls native `resume()`.

With dependencies installed and the package built, run:

```bash
npm run example -- examples/runtime-features/pause-resume/11-sqlite-durable-wait.ts
```

Requires Node 22.16+ or Node 24 on Linux/macOS for built-in SQLite, private POSIX file modes and the owned process-kill proof. It uses only synthetic local state. The output is a safe JSON report, including the actual SDK version, scenario facts, child exit receipts and limits. The repository's normal examples gate runs it against the built package; its focused integration test separately runs current source.

Reply and timeout take different recorded branches. A timeout says **waiting ended**, not that an outside action failed. If a worker dies after its continuation's local synthetic effect but before saving the result, recovery demonstrates two effects for one logical task. An application must query authoritative outside status or use an enforceable idempotency contract before resending ambiguous work.

This is one static wait generation, not a production scheduler or a new engine API. The detailed storage, privacy, expiry and supported-shape boundaries are in [the private helper guide](durable-sqlite/README.md). Operational checkpoints are private real state; they are not scrubbed historical diagnostic records. Missing delivery, external completion/cancellation and cross-resume read history remain unknown.
