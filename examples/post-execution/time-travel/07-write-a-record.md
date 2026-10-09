---
name: Write a record
group: Post-execution · Time travel
---

A record written through `footprintjs/write` — the heap, the log and one frame per step, the classes the engine itself writes with — and read back by `stateAt`, `commitValueAt` and `causalChain`. A secret written with a redaction verdict's bytes reaches the log as `'REDACTED'` while the heap keeps the value. The rules it follows are the record contract (`docs/guides/record-contract.md`, "Writing a record").
