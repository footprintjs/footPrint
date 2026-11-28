# Wait for an independent child chart

Use `footprintjs/child-continuation` when a host runs a child with its own `FlowChartExecutor` and needs to store the child's pending approval with the exact parent call. A directly mounted subflow already pauses through the parent. Its existing API and checkpoint are unchanged.

Create a continuation with the host's exact parent-call occurrence and its admitted immutable implementation identity. Resolve that identity to a fresh executor for each admitted leg. Start with `{ kind: 'new' }` and advance with `{ kind: 'start' }`. A waiting outcome offers a gate, native pause data for the host and a private JSON string in `saved`. Store the string in the host's current waiting slot and project only the question the caller may see.

After a restart, use `{ kind: 'restore', saved }` from that slot. Advance the child with `{ kind: 'answer', gate, answer }`. With an `interrupt()` pause, the interrupted stage body runs again. With a declared pausable function, the separate resume half runs. The child may offer a different gate. Advance the parent only when a child `finished` result is available and the parent's scheduler permits it.

One handle accepts one live leg at a time. A matching answer spends its gate when native execution starts. Another wait replaces that gate. The host must recheck authorization and atomically claim its current waiting revision before a worker resumes it. A fresh process cannot detect an older copy if the host supplies it as current. Keep the saved envelope and raw approval input in the host's private path. The continuation admits one native wait at a time. Native fork waits still work through the executor's existing mounted path.

## Native execution limits

- **Don't share an executor between concurrent runs.** A second `run()` rejects with `RunInFlightError`.
- **Don't do what cannot run twice before `interrupt()`.** Resume re-runs the stage from its top. A pause inside a lazy subflow or an `.addParallelForEach()` branch cannot resume.
