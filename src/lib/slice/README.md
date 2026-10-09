# slice/ — record queries moved to foottrace

The slice implementation and its canonical contract now live in the standalone
[foottrace repository](https://github.com/footprintjs/foottrace/blob/main/src/lib/slice/README.md).
Import `causalChain`, `sliceForKey`, the slice serializers and `HONESTY_CODES`
from `foottrace`; FootPrint does not re-export them.

FootPrint still owns the engine that produces the record, and its integration
witnesses exercise these readers against engine-produced logs. Quality recording
and `qualityTrace` remain on `footprintjs/trace`: a quality recorder can locate
the step, then the foottrace readers explain the recorded value.

See the [record contract](../../../docs/guides/record-contract.md) for the package
boundary. This pointer deliberately keeps no second copy of the slice contract.
