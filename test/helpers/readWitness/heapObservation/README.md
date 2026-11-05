# Original heap-call observations

This optional port is selected only from the actual BASELINE/BUILD engine object. The two layout adapters read own data: baseline `StageContext.sharedMemory.context`, build `StageContext.record.state.context`. Unknown layouts provide no proof. Neither adapter invokes a native method or computes fallback paths.

The facade receives the existing observer's clock, object identities, current read stack, detached snapshotter and event sink. It wraps the original `SharedMemory.getValue` exactly once, preserves its receiver, arguments, returned identity and thrown identity, and records only calls made during a named native stage read. It owns no second identity registry or lifecycle.

Generation IDs are local to one observer. Detached full heap facts additionally detect an in-place change in the baseline. Cross-engine proof compares pre-delete facts, never local object IDs. `readLawWitness/heapFallback` owns the pure admission relation; this port never admits a difference.

This is test evidence. No source engine, fixture program, generator, corpus or normal record is changed.
