# Immutable source origin

A source archive is identified by fixed repository/PR/head/tree, original manifest bytes/hash and
its built archive/member identities. An authored stable label does not claim the registry bytes
with that label. Registry selections remain exact version/SRI. Source and registry cannot select
the same package.

Only AgentFootprint may stage a canonical one-bump RC after its normal build, following its native
route. Every other source keeps its authored version. Strategy is derived from code, never a plan
or receipt waiver. Original manifest fields except version and all public peer constraints remain.
All RC labels retain existing-registry collision refusal. No publication authority is added.

The pack stage preserves/restores exact original manifest and lock bytes (or lock absence).
Temporary strict install lock evidence is recorded separately. Tiny fixture tests establish these
joins, not a real AF15 producer or future published-cohort compatibility.
