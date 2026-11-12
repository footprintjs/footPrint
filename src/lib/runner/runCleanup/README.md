# Run cleanup helpers

Two helpers the executor calls around a run: `autoFlushMs` gives the bound on a run's own record flush (the run's
time left, at least 1 s, never past 30 s), and `disposeOnThrow` releases an armed run when a step of a refused entry
throws, so no deadline timer outlives it.
