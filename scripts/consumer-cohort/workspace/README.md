# First paired installation

Capture original manifests, derive the selected runtime closure, validate original ranges and use
the existing packaged install plan BEFORE the first strict ci, including library roots previously
using linked mode. Peers stay unchanged. Root development dependencies count; a published dependency's
development-only pins do not create runtime dependencies. Source-only siblings keep their existing
complete-tree borrowing rule. An unsupported runtime sibling refuses instead of disappearing.
