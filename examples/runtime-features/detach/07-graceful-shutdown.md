---
name: Detach (Graceful Shutdown)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#graceful-shutdown
---

# `flushAllDetached` — Drain Before Exit

When your process is about to exit (SIGTERM, test cleanup, batch
completion) you usually want to flush every in-flight detached child
to terminal first — otherwise telemetry / audit / cache-warmup work
that was scheduled but not yet flushed silently dies.

`flushAllDetached(opts?)` waits for the registry to drain. It returns
counts for diagnostics; the contract is that on successful return
**no detached work remains in flight**.

```
process.on('SIGTERM', async () => {
  const stats = await flushAllDetached({ timeoutMs: 10_000 });
  console.log(`Drained ${stats.done} done, ${stats.failed} failed, ${stats.pending} pending.`);
  process.exit(stats.pending === 0 ? 0 : 1);
});
```

## The contract

| Field            | Meaning                                                       |
|------------------|---------------------------------------------------------------|
| `done`           | Handles whose `wait()` was awaited and resolved (best-effort) |
| `failed`         | Handles whose `wait()` was awaited and rejected (best-effort) |
| `pending`        | In-flight handles when the deadline hit. `0` = drain complete.|
| `timeoutMs`      | Default `30_000`. Set to your shutdown grace window.          |

`done`/`failed` are **best-effort** counts: a child that completes
inside another's `wait()` may finish (and unregister) before we get a
chance to await it directly. The drain is still complete — only the
count is approximate.

## When to use

- **HTTP server SIGTERM handler** — flush analytics before exit.
- **CLI batch jobs** — make sure metric exports flush before the
  process ends.
- **Test cleanup** — drain pending detaches between test cases so
  state doesn't leak across them.
