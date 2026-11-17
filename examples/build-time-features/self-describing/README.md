# Self-describing charts

These examples inspect builder-owned chart metadata. The static shape describes
possible work; it is not evidence that a stage ran or caused a value.

| Example | Shows |
|---|---|
| `01-openapi.ts` | The chart's OpenAPI description. |
| `02-mcp-tool.ts` | The chart's MCP tool description. |
| `03-mermaid.ts` | The root graph rendered by `chart.toMermaid()`. |
| `04-spec.ts` | The serialized build-time specification. |
| `04-static-subflows.ts` | Each eager mount's inner stages through a structure recorder and the public walker. |

The static-subflows example imports only `footprintjs` and `footprintjs/trace`.
It builds two mounts of the same child and prints each supplied local stage ID
with its mount namespace. The lazy mount stays explicitly unresolved. Its own
regression guards check recorder errors, both stage identities, the unresolved
mount and zero stage/lazy-factory calls. The existing every-example integration
test discovers it automatically and runs it against the built package.

The default Mermaid diagram stays flat at subflow boundaries. The walker follows
only available nested specs; it does not resolve factories, run stages, admit
untrusted stored input or promise a global depth/work budget.

See [subflow composition](../../../docs/guides/patterns.md#inspecting-static-inner-charts)
for the recorder recipe and the distinction between supplied spec IDs and native
prefixed roots.
