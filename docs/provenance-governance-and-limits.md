# Provenance, governance and limits

[Back to the README](../README.md)

The README demonstrates one connected runtime recording. This guide explains how to interpret that evidence, relate it to governance vocabulary, and design the controls around it. It is an engineering guide, not a legal opinion, certification, or compliance assessment.

**Capture and investigation are distinct:** evidence and runtime relationships are collected during execution; a later query assembles the requested view from that recording. No LLM is needed to manufacture the execution history.

## From debugging to provenance and traceability

The same evidence has names outside debugging.

**Provenance** asks where a value or result came from. **Traceability** asks whether you can follow the relevant relationships. **Decision transparency** makes the recorded rule evaluation and branch choice understandable to a reviewer.

In the example, `LoadImage` is the recorded producer of `width`. Following that value into `CheckResolution`, and following its choice into `RejectExport`, makes the outcome traceable within the captured run.

These are useful engineering and governance concepts, not EU-only terms. [W3C PROV](https://www.w3.org/TR/prov-overview/) provides a broader vocabulary for origins and production activities. This is a conceptual connection, not a claim that FootPrint implements the W3C PROV interchange standards.

**Provenance does not mean “proven correct.”** It supplies evidence for an assessment.

## One execution record, different review questions

A developer asks: **“Which stage should I investigate?”**

A coding agent asks: **“What does the recorded path establish, and what hypothesis should I test?”**

An internal reviewer asks: **“Did this run apply the approved rule?”**

An **audit trail** is the relevant history retained for later review. **Auditability** is the ability to examine that history and check claims against defined criteria. FootPrint can contribute connected execution evidence to that process; the application must retain and protect it appropriately.

For teams working with European governance terminology:

| Governance objective | How the evidence can help | What the organisation still needs |
| --- | --- | --- |
| Traceability | Follow recorded origins, dependencies, and decisions. | Capture coverage and identifiers for relevant external sources. |
| Transparency | Inspect the evaluated rule and selected path. | Explanations suitable for the intended audience. |
| Auditability | Examine recorded activity against review criteria. | Retention, protected storage, versions, and review procedures. |
| Human oversight | Give a reviewer evidence at an intervention point. | Authorised reviewers, effective controls, and operating procedures. |
| Accountability | Connect an outcome to recorded actions and decisions. | Verified actor identity, assigned responsibility, and remediation. |

The European Commission's [Ethics Guidelines for Trustworthy AI](https://digital-strategy.ec.europa.eu/en/library/ethics-guidelines-trustworthy-ai) connect traceability with transparency and auditability with accountability. This table is an engineering mapping to those objectives, not a regulatory compliance assessment.

## Keep control of your evidence

### Separate capture, retention, and disclosure

What the runtime captures, what your organisation retains, and what an LLM or reviewer receives are separate decisions.

Use the available redaction and recording controls as part of that design. Do not assume that enabling tracing makes every output safe to share. Treat free-text errors, external payloads, and exported artifacts as separate disclosure surfaces.

Durable storage, access control, retention, deletion, and record-integrity protection belong to the surrounding application and infrastructure. Preserve failure evidence as well as successful results; test the persistence path rather than assuming an in-memory trace will survive a failure.

### Record-reading independence and digital sovereignty

Foottrace can read supported records without their original flowchart engine or an AI provider. That contributes to the independent lifecycle of the evidence-reading layer. It does not establish the sovereignty of an entire deployment: hosting, suppliers, storage controls, and operating arrangements remain separate choices.

See the [Foottrace record contract](https://github.com/footprintjs/foottrace/blob/main/docs/guides/record-contract.md).

## Know what the recording can establish

**Connected evidence is not a blanket correctness guarantee.** Here, a causal trace follows recorded program dependencies; it is not a proof of real-world causation.

Capture settings, untracked inputs, redaction, and scope boundaries affect what an investigation can establish. A stage-level dependency can be conservative: a recorded read is not proof that it was mathematically necessary for every value the stage wrote. Preserve the query's warnings about incomplete or truncated evidence.

Replay of recorded state is not a guarantee that rerunning external services, nondeterministic code, or a model will reproduce the same outcome.

An immutable in-memory record is not automatically a tamper-evident audit archive. A runtime trace does not establish fairness, legal compliance, or the correctness of the requirement being executed. It is also not a view into an LLM's hidden internal reasoning.

See Foottrace's [slicing contract](https://github.com/footprintjs/foottrace/blob/main/src/lib/slice/README.md) for interpretation and boundary details. The control-dependency recorder's current mappings reset between runs and resumes; this example does not demonstrate continuous control attribution across a pause/resume boundary.

## How this fits with existing tooling

FootPrint is a workflow runtime with connected evidence capture—not an LLM log summariser, a replacement for your test suite, or an automatic refactoring of arbitrary existing code.

Structured logs and distributed traces already support machine-readable correlation; for example, the [OpenTelemetry log model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) includes trace and span identifiers. FootPrint's focus is the relationship between workflow state, evaluated decisions, and executed branches. Use it alongside the infrastructure and monitoring tools appropriate to your system.

**The goal is a shared basis for investigation.** Faster repairs, lower model costs, or better diagnosis rates should be established through controlled measurements, not inferred from the existence of a trace.

## A small vocabulary for the implementation

| Term | Meaning |
| --- | --- |
| Flowchart | The executable structure of the workflow. |
| Stage | A named unit of work. |
| Scope | The tracked state interface used by a stage. |
| Decider / selector | A step choosing one branch / a set of branches. |
| Recorder | A runtime observer that captures selected execution evidence. |
| Commit log | The recorded state changes used by the replay and query layer. |
| Narrative | A readable presentation of recorded execution activity. |
| Causal slice | A bounded dependency view assembled from recorded evidence. |


## Recording boundaries for the README example

The example attaches `controlDepRecorder()` before execution and supplies its live lookup to `causalChain()`. A commit log alone does not contain every control relationship this lookup provides. For offline investigation, retain the matching read evidence and the control information your reader needs. Do not assume serializing only the final state preserves those relationships.

The current control recorder resets its mappings on a new run ID, including resume. It does not provide continuous pre-pause control attribution after resuming. Pair subflow logs with their own read evidence and preserve incomplete-source and truncation markers. See the [control recorder's contract](https://github.com/footprintjs/footPrint/blob/main/src/lib/recorder/ControlDepRecorder.ts) and [Foottrace slicing contract](https://github.com/footprintjs/foottrace/blob/main/src/lib/slice/README.md).

Recording configuration is not a blanket disclosure policy. In particular, the [decision-evidence types](https://github.com/footprintjs/footPrint/blob/main/src/lib/decide/types.ts) warn that error messages thrown by user-provided rule functions are not filtered through the redaction policy. Review every surface sent to a model, an export, or a reviewer.

## Evidence before performance claims

The example demonstrates recorded data and control dependencies. It does not measure improved repair speed, lower token costs, or higher diagnosis accuracy. A suitable evaluation would hold the implementation, failing case, model, and repair criteria constant while varying access to recorded evidence. Judge repairs by independent tests and regressions, not by the persuasiveness of an explanation.
