# time-travel/ — finished-record readers moved to foottrace

The time-travel implementation and its canonical contract now live in the
standalone [foottrace repository](https://github.com/footprintjs/foottrace/blob/main/src/lib/time-travel/README.md).
Import `stateAt`, `timeTravel`, `commitStops`, `tagStops`, the record shapes
and `HONESTY_CODES` from `foottrace`; FootPrint does not re-export them.

A cursor reads the record the engine already wrote. It is not a second live
execution, retry or resume mechanism. FootPrint retains the engine integrations
and byte-identity witnesses that exercise readers over its real execution logs.

See the [record contract](../../../docs/guides/record-contract.md) for the package
boundary. This pointer deliberately keeps no second copy of the reader contract.
