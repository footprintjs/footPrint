# Native closure production

`record.ts` assembles one bounded immutable prefix from already retained observations.
Its caller supplies privacy-filtered data and the exact selected failure; absent or
contradictory evidence returns unknown. This L7 producer is excluded from trace readers.

Tests live beside the implementation; engine scenarios cover lifecycle and persistence.

`state.ts` owns only the one-shot latch and immutable result. `cut.ts` uses short-lived
lazy ports, preserving refusal/read/copy order; neither retains its callbacks or a
live runtime. The executor resets the state only when a new native run ID is assigned.
