# Record lifecycle metadata

`openingMeta` and `closingError` serve the existing root-log metadata shape.
They preserve field order and optional-value omission. The opening budget is read
before the current run ID; the run-ID callback is synchronous and never retained.
Closing errors pass through the run privacy rule once and never include raw errors.
The settling caller supplies its native failure state before finish releases ownership.
Closing metadata consumes that exact pending token's retained projection. An absent,
unreported or commit-invalidated receipt is unknown under the active state policy.
No-policy metadata keeps the structured message, name/code order and optional omission.
