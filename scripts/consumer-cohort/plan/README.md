# Source-cohort input admission

Accept only all configured consumer PR heads, one PR/full-head tuple per fixed repository, the finite source
recipe table and exact registry versions with SHA-512. There is no own-head field, arbitrary
command, repository override, failure-acceptance option or published version ledger.
`requireRanges` reads authored manifests; it cannot widen peers or bless an old Foottrace pin.
Unsupported aliases/recipes, missing transitive packages and cycles refuse explicitly.

The existing source owner supplies candidate versions and PRs; a plan does not grant ownership,
review, merge or publication. GitHub reads prove the selected open PR head at observation time.

Canonical engine/AF root dev requests may be audit setup, while all original runtime, optional and
peer requirements must admit the actual selected version. Root Foottrace pins still bind. This is
not a generic dev-field escape or a change to dependency-only/source-only runtime closure.
