# Documentation snippet checks

`npm run check:doc-snippets` checks TypeScript fences that import FootPrint against current source with strict TypeScript. Each fence is a separate module. Syntax errors, missing context, assignment/argument mismatches and compiler failures fail the check; no diagnostic codes are ignored and parse failures do not remove documents.

`discover.mjs` owns document discovery and uses `markdown-it` for CommonMark fence extraction, including list and quote containers. It includes Markdown/MDX, `src/README.md` and extensionless editor instructions under `ai-instructions`. Generated directories and the existing historical `design`, `proposals` and `internals` directories are excluded. Missing roots and unclosed selected fences fail. A malformed import containing the module name remains selected even when TypeScript cannot recover its import declaration. Original line/column mappings account for stripped container prefixes and partially expanded tabs.

`compile.mjs` owns in-memory compilation with a separate program per fence, so even global or module augmentations cannot leak between examples. Virtual modules live beside their documents so relative imports resolve there. Public package doors map to their source entry points; dependency declaration files use the repository's existing `skipLibCheck` policy. The checker emits no files, does not execute examples and does not assert that their runtime behavior or printed output is correct. It provides no hidden globals or `any` preamble. TypeScript suppression directives in selected examples are refused.

`index.mjs` composes discovery, checking and original document line/column reporting. The public script is only the command-line facade and fails on unexpected compiler/discovery errors. Its summary distinguishes checked import-bearing examples from unselected TypeScript fragments; it never claims every code fence was verified.

The scope is source examples, not validation of upstream declaration packages: `skipLibCheck` means errors inside a dependency's `.d.ts` file may remain undiscovered. Direct missing imports and errors in imported `.ts` source still fail. No JavaScript or import-free fragment is silently counted as checked.

In MDX, JSX containers do not hide their Markdown children. This checks the fenced examples, not MDX expressions, attributes or component imports; the documentation-site build validates the surrounding MDX.

Keep checked examples self-contained. If a snippet describes integration with an existing application, show and label the typed input contract in the snippet itself. Do not rely on a previous independent example's declarations, change a language label to evade checking, or replace a real API with an untyped stub. Historical records stay historical; current guides must demonstrate the current API.

Regression coverage lives in `test/architecture/doc-snippets.test.ts` and `test/architecture/doc-snippet-markdown.test.ts`.

## Measured baseline

Before editing examples, the checker was measured against commit `e000f5653487210006d8f9590984b830fd3ff1b0` with TypeScript 5.4.5. The old checker selected 194 fences from 76 documents, dropped three documents after parse failures, concatenated the rest, and filtered compiler diagnostics. Turning on full strict checking in that arrangement produced 470 diagnostics, including 344 duplicate declarations caused by concatenating independent examples.

Checking each fence independently, removing the injected executor declaration, restoring the three skipped documents, and adding the source README and extensionless editor instructions selected 197 fences from 79 documents. That baseline had 229 diagnostics in 42 documents: 190 missing-context errors and 39 others. Real API problems included a pause handler narrowing an `unknown` input without validation and passing a possibly missing causal node to its formatter. These counts are not 470 distinct library defects.

The repaired examples pass without diagnostic filters, parse-based exclusions, or relaxed types. The command reports the checked population and the remaining import-free TypeScript fragments separately; those fragments still need review in their surrounding context. No runtime-library behavior changes in this packet.
