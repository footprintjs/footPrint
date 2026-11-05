# Native read observation

Test-only adapter over the actual StageContext and TransactionBuffer objects supplied by the existing engine fixture. It calls each original method once with the same receiver/arguments and returns or throws the same result. Detached own-data snapshots retain order, frame, buffer, epoch, canonical address and value/object identity facts; restoration runs in finally. Unsupported or ambiguous evidence fails closed.

The local input selector requires a successful same-frame delete or set-of-undefined before the observed read, with no overlapping replacement or intervening commit. Commit-oracle activity is not a stage mutation. These are inputs to a later named #124 comparison, not an equivalence verdict, causal replay engine or permission to ignore changed records.

The adjacent inert tests exercise delegation and conservative refusal. Native tests separately compare instrumented and uninstrumented bytes on each real engine and witness the corrected native return. Neither test family establishes global observer authenticity or source approval. No production code imports this folder. Outside callers import the sibling facade only.
