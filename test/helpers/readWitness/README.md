# Native read observation

Test-only adapter over the actual StageContext and TransactionBuffer objects supplied by the existing engine fixture. It calls each original method once with the same receiver/arguments and returns or throws the same result. Detached own-data snapshots retain order, frame, buffer, epoch, canonical address and value/object identity facts; restoration runs in finally. Unsupported or ambiguous evidence fails closed.

The local input selector requires a successful same-frame delete or set-of-undefined before the observed read, with no overlapping replacement or intervening commit. Commit-oracle activity is not a stage mutation. These are inputs to a later named #124 comparison, not an equivalence verdict, causal replay engine or permission to ignore changed records.

The adjacent inert tests exercise delegation and conservative refusal. Native tests separately compare instrumented and uninstrumented bytes on each real engine and witness the corrected native return. Neither test family establishes global observer authenticity or source approval. No production code imports this folder. Outside callers import the sibling facade only.

Operation, argument and returned-object facts share this observer's original clock and WeakMap. Nested identity paths are getter-free own-data metadata, separate from semantic value bytes. Retained slots require an explicit unchanged native full/summary mode; an old slot under OFF or unknown mode supplies no claim.

Optional commit origins observe the real inner encoder and surviving-path outputs before any outer rewrite. Missing origin or operation facts never manufacture a named cause. The native producer/profile/corruption controls run on the actual installed classes separately from the inert port tests.
