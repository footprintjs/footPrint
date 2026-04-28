---
name: Redaction
group: Features
guide: https://footprintjs.github.io/footPrint/guides/features/redaction/
---

# Redaction — PII Protection

Sensitive data (SSNs, credit cards, API keys, PHI) shouldn't leak into narratives, debug logs, or recorder output. Redaction **scrubs specified keys** before they reach any recorder — so the story stays intact but the values are masked.

```
Narrative without redaction:
  Step 1: Write ssn = "123-45-6789"        ← leaked to logs, LLM prompts, audit DBs

Narrative with redaction:
  Step 1: Write ssn = <REDACTED>           ← same story, zero leakage
```

## When to use

- **Regulated data** — HIPAA (PHI), PCI-DSS (credit cards), SOC 2 (secrets), GDPR (personal data).
- **LLM prompts derived from traces** — "Copy narrative for LLM" in the playground would otherwise leak raw values.
- **Audit logs sent off-server** — redact before cloud ingestion.
- **Developer debug logs** — production-safe trace capture.

## The pattern

```typescript
executor.setRedactionPolicy({
  keys: ['ssn', 'creditCard', 'apiKey'],            // exact key matches
  patterns: [/password/i, /token$/i],                // regex on key name
  replacement: '<REDACTED>',                          // optional custom mask
});

await executor.run({ input });
// All recorders see redacted values. Scope itself is untouched.
```

## Redaction scope

Redaction applies **at the recorder layer** — scope operations (reads, writes, decisions) happen with real values, but any event dispatched to a recorder gets scrubbed first:

- `onWrite({ key: 'ssn', value: '<REDACTED>' })`
- `onCommit({ mutations: [{ key: 'ssn', value: '<REDACTED>' }] })`
- Narrative lines: `"Write ssn = <REDACTED>"`
- Commit log entries: `{ updates: { ssn: '<REDACTED>' } }`

**Your business logic still sees the real values.** Stages can read, write, and compute on sensitive data — it only gets masked when observed.

## Multi-layer protection

Three mechanisms, different concerns:

| Mechanism | Protects | Applied when |
|---|---|---|
| `setRedactionPolicy` | Recorder events, narrative, commit log | During execution |
| `summarizeValue` (built-in) | Large objects truncated in logs | Always |
| Custom `RedactingRecorder` | Your own storage / exporter | You control |

For maximum safety, combine all three: set a policy, ship only summarized objects to external systems, and wrap any custom recorder with its own redaction pass.

## Key name vs value redaction

footprintjs redacts by **key**, not by scanning values. Rationale:

- Scanning values is expensive (every string checked against every pattern).
- Keys are authoritative — you know which fields are sensitive at design time.
- Value scanning gives false positives (e.g., a URL containing `?token=` in a non-sensitive context).

If you truly need value scanning, wrap a custom recorder.

## Verification

In the playground, click **Insights → Story → Copy for LLM**. The narrative you copy has redactions applied — you can paste it into an LLM without leaking PII.

## Key API

- `executor.setRedactionPolicy({ keys, patterns, replacement? })` — attach a policy.
- `setRedactionPolicy({ keys })` — common case: match by exact key name.
- `patterns` — regex against key names (e.g., `/^pw/i` catches `password`, `pwHash`).
- Default replacement: `'<REDACTED>'` (configurable).

## Related

- **[Subflow Redaction](./17-subflow-redaction.md)** — redaction cascades into mounted subflows.
- **[Contract & OpenAPI](./10-contract-openapi.md)** — declare which fields are sensitive at contract time.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/redaction/)** — patterns, edge cases, and the RedactingRecorder pattern.
