# The record contract

FootPrint executes a chart and writes its record through `foottrace/write`. The record's shapes,
encoding laws and readers now belong to the standalone [foottrace record contract](https://github.com/footprintjs/foottrace/blob/main/docs/guides/record-contract.md).

Read finished records with `foottrace` (`stateAt`, `timeTravel`, causal chains and slices), and handle
record paths with `foottrace/paths`. Recorder stores, topology and chart boundary observers remain
on `footprintjs/trace`.

The engine's 26 [pinned flowchart records](../../test/fixtures/README.md) continue to prove that its
frame writes the same bytes through that dependency. Extraction changes ownership and import paths,
not the record contract or its bytes.
