# Native closure production

`record.ts` assembles one bounded immutable prefix from already retained observations.
Its caller supplies the selected raw evidence projection, privacy operation and exact
selected failure. The producer prepares bounded inert data before privacy, then admits
the normalized result; absent or contradictory evidence returns unknown. This L7 producer is excluded from trace readers.

Tests live beside the implementation; engine scenarios cover lifecycle and persistence.

`state.ts` owns only the one-shot latch and immutable result. `cut.ts` uses short-lived
lazy ports, preserving refusal/read/copy order; neither retains its callbacks or a
live runtime. The executor resets the state only when a new native run ID is assigned.
