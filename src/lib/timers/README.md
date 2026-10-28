# timers/ — the one long-timer law

A host timer holds at most 2^31 − 1 ms (about 24.8 days). Node turns a longer delay — `Infinity` included — into 1 ms, so a raw `setTimeout(fn, limit)` gives up at once exactly when the caller asked to wait longest. `drainObservers({ timeoutMs: Infinity })` did; so did `flushAllDetached`, `flushRecord`, a file sink's `flushTimeoutMs` and the `setTimeout` detach driver, until each was routed here.

| File | One job |
|---|---|
| `longTimeout.ts` | `setLongTimeout(fn, ms, { unref? })` — arm a host timer for a limit of any length: `Infinity` arms NO timer (the work decides when the wait ends); a finite delay past 2^31 − 1 ms is waited in chunks, never early and never in 1 ms; anything not a number > 0 (`0`, a negative, `-Infinity`, `NaN`) is due at once. `{ unref: true }` unrefs every chunk, for a timer that only bounds a wait |

**The law is enforced, not hoped for.** `test/architecture/timer-law.test.ts` reads every file under `src/` and refuses, outside `longTimeout.ts`: a `setTimeout` / `setInterval` whose delay is not a literal a host timer holds (or a constant on the test's named allow-list); any other way of reaching one (an alias, `globalThis['setTimeout']`, `.call`, destructuring, `Reflect.apply`); an import of `timers` / `timers/promises`; `scheduler.wait`; and `AbortSignal.timeout` with a non-literal or too-long argument (use `attempt/deadline.ts · armDeadline`).

```typescript
import { setLongTimeout } from '../timers/longTimeout.js';

const cancel = setLongTimeout(() => giveUp(), timeoutMs, { unref: true }); // Infinity: no timer; 2^31: 24.8 days, then the rest
work.finally(cancel);
```

A leaf in its own folder (L0 in `scripts/layering.config.cjs`): it imports nothing, so every layer — the observer queue at L1 as much as the engine — arms its limits with the same law.
