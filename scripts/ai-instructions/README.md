# ai-instructions

Writes `AGENTS.md` and the files in `ai-instructions/` from one source, `ai-instructions/source/`, and checks them.

```sh
npm run ai:generate            # write the files, then report any wrong fact
npm run check:ai-instructions  # write nothing; exit 1 on drift or a wrong fact
```

| File | One job |
|---|---|
| `render.mjs` | Source to text. Pure, so writing, checking and tests share one result. |
| `facts.mjs` | Each check, returning problems. It fixes nothing. |
| `generate.mjs` | The command line: compose both, write or compare, print the sizes. |

## What `--check` catches

| Code | Meaning |
|---|---|
| `drift` | A generated file differs from what its source renders to, or is missing. |
| `stray-file` | A file in `ai-instructions/` that nothing generates. |
| `door-missing`, `door-unknown` | The import map and the package doors disagree. FootPrint's doors come from `scripts/doors.mjs · doorSpecifiers`, foottrace's from `installedDoorSpecifiers`. |
| `name-missing` | The import map shows a name its door does not export. |
| `path-missing`, `anchor-missing` | A task points at a file or heading that is gone. |
| `name-unknown` | Prose names an API that no public door declares. |
| `line-citation` | Prose cites `file:line`. Cite `file · symbol`. |
| `over-budget` | A file outgrew its `maxBytes` in `targets.json`. |

## What it misses

Whether a sentence is true. `name-unknown` knows a name exists on some public door, not that it belongs to the object the sentence puts it on, and it reads only calls, `$` methods, `on…` hooks and capitalised names. Code fences are left to `check:doc-snippets`, which compiles them. `test/architecture/ai-instructions-snippets.test.ts` runs the snippets and compares their output, from `npm run test:examples`.

The check is advisory in `ci.yml`: a red result warns on the pull request and the job stays green. `test/architecture/ai-instructions.test.ts` proves each code above goes red.
