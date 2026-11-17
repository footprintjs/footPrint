# Public native producer fixture

`produce.cjs` takes the installed public engine exports and returns actual raw/redacted snapshots. It makes a mapped seed/output, a later parent overwrite, reordered generated branches and a nested parent collection. It never imports source internals or constructs handoff DTOs. The adjacent native capture tests exercise the same public options; the separate hosted protocol driver supplies the actual packed engine and reader packages and proves archive/source identity and a strict single-copy install before execution.

These memory snapshots are not durable receipts. A host conversion must mark native invocation inventories partial, preserve literal source names and use exact runtime log addresses rather than static aliases.
