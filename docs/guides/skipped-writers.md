# Possible writers on skipped paths

Import from `footprintjs/skipped-writers` to ask whether a skipped branch could have written a key in an exact live FootPrint capture. The evaluator reports candidate writer evidence and gaps. A declared writer was possible, and an observed writer ran at another admitted placement. Neither case establishes the value or outcome the skipped path would have produced.

Call `declareSkippedWriterPaths(placement, paths)` for the exact authored placement when the list covers everything it can write. An empty list declares that the placement writes nothing. The same static stage can occur in more than one placement, so declare each one separately. If a recorded write falls outside the declarations for a stage whose placements are all declared, the reader returns a `declaration-mismatch` gap and the record carries no saved chart binding.

Use `await skippedWriterCaptureOptions({ sink })` when constructing a `FlowChartExecutor`. After a successful run, call `readSkippedWriters(snapshot, key, beforeIdx)` with the exact result of `executor.getSnapshot()`. The commit cutoff is exclusive and can equal `snapshot.commitLog.length`. A same-executor resume can retain first-leg evidence when one verified chart governed the whole log. Copied snapshots and foreign logs cannot carry native binding.

Foottrace 3.1 provides the optional evaluator. Applications with Foottrace 2 can keep their ordinary engine behavior. If the evaluator is unavailable, the reader returns a `not-collected` gap.

The option enables explain capture as well. The run’s record can include tracked `readKeys` and decision and loop notes. A non-JSON value such as a `Date` in any root commit makes the live capture unavailable with a `not-collected` gap.
