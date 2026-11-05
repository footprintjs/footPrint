# Existing branch facts

One job: the existing immutable value projections, snapshot identity checks and branch-call preconditions shared by CHART's old strategies and the newly ruled projection table. Import only the sibling branchFacts.ts facade.

The value/identity helper bodies are moved from chartBranch.ts. In particular sameEmbeddedRead, sameCopiedMembers, freshLiteral and spread's caller retain their rules; deep-copy batch does not weaken SAME copied-member identity. The prior call preconditions become validateCalls, used by both dispatch paths. These units read detached observation data only. They do not execute native calls, decide a FIRST cause or construct heap state.

Existing adjacent chartBranch.test.ts exercises the facade through the branch dispatcher; projection/index.test.ts adds the new behavior controls. Those inert controls do not replace actual native/full-suite proof.
