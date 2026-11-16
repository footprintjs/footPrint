# Native chart stages

Each child owns one stage responsibility: prepare, pause/resume, decide, record the selected outcome, or continue through an injected effect. `workflow.cjs` only wires these stages. None reads storage or another stage's implementation. Both branches and failure/re-pause behavior are observed by the feature's genuine fresh-process integration suite.
