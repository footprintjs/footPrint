# Evidence input before privacy

`copyEvidenceInput` prepares one intended evidence projection before a privacy
operation reads it. It reuses the shared history copier, producing detached,
recursively frozen inert data without invoking own accessors, `toJSON` or coercion.
It does not collect live state, choose privacy rules or admit stored evidence.

Own object properties whose value is undefined survive this preparation so the
existing privacy operation can mask them before normal evidence omission creates
absence receipts. Preserved properties do not fire `onOmitted`. Undefined roots,
array entries and sparse arrays are still refused. Ordinary `copyHistoryData`
calls retain their JSON omission behavior.

Preparation defaults to 1 MiB and obeys the shared node, key and depth limits.
Every preserved undefined value counts as a node and is conservatively charged
as a `null` slot, alongside its key and punctuation, before retention. Preparation
admission can therefore refuse oversized raw data even when privacy would later
shrink it. The existing post-privacy normalization and admission are still needed.

This is temporary preparation data, not a wire format, signature or sandbox for
arbitrary executable Proxies. Reflection on a Proxy can run its traps. A registered
recorder's explicit hook remains author code; getters in its returned data do not
gain that authority. Adjacent tests cover preparation and the unchanged JSON law.
