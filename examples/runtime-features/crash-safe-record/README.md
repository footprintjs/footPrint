# Crash-safe records

These examples write the existing four-kind record through its sink and read
the bytes that survived. `05-offline-why.ts` reads native decision and read-name
evidence with `readRunEvidence` from Foottrace. It needs no live executor,
execution-tree snapshot, recorder or model. Channel status travels with every
answer; missing or partial evidence never means nothing happened.

The examples own and remove their temporary files. `src/lib/memory/storedEvidence/crash.test.mjs`
checks a real SIGKILL inside a mounted stage. Its flushed prefix is deliberately
durable for that probe; ordinary asynchronous writes still have a loss window.
