# agent-debug: does an agent fix a fault with fewer tokens when it has the map and the record?

A benchmark with a model in the loop. It is a small package of its own (its own `package.json` and lock) so that it runs on the PUBLISHED `footprintjs` and `foottrace`, the ones a user installs, and so that a model SDK never becomes a dependency of the engine.

**Why it exists.** The library's central claim is that a run recorded by the flowchart lets an agent find the cause of a wrong value without reading everything and without adding logs. Until a checked-in run with a real model shows it, that is a claim and not a result. `bench/fault-finding.ts` shows that the walk back contains the faulty step; it does not show that a model using it spends less.

**Read [RULE.md](RULE.md) first.** It says what is tested, what is counted and what decides the next step, and it was committed before the harness and before any model was called.

## State

Version 1 of the rule is written. The program, the faults, the harness and the rehearsal are being built. No model has been called.

## Running it

To be filled in with the harness. The convention will be the family's: the key comes from the environment (`node --env-file=<file>`), the bench never reads a key file, and `--rehearse` runs everything with a scripted stand-in and spends nothing.
