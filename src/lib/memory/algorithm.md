# Backward causal-chain analysis

Causal-chain analysis is owned by the standalone `foottrace` package and is
imported from its root door. FootPrint supplies the engine's recorded writes,
tracked reads and optional control-dependency observations; it does not contain
a second slicing implementation.

See the canonical [slice contract](https://github.com/footprintjs/foottrace/blob/main/src/lib/slice/README.md)
and [record contract](https://github.com/footprintjs/foottrace/blob/main/docs/guides/record-contract.md)
for the algorithm, limits and honesty rules. Engine recording and quality
integration remain documented in [the recorder guide](../recorder/README.md).
