# api-doors

Keeps the generated API reference and the package's doors in step, and tells the site where each door lives.

```sh
npm run docs                # TypeDoc writes api-docs/ (the pages) and api-docs.json (what it lists)
npm run check:api-doors     # exit 1 when the reference and the doors disagree
```

| File | One job |
|---|---|
| `site.mjs` | Where the site serves each door, and the sidebar's items. No dependencies, because the site's build loads it too. |
| `check.mjs` | The command line and each check. It fixes nothing. |

Nothing here keeps a list. The doors come from `scripts/doors.mjs · doorSpecifiers`, which reads `package.json · exports`. `test/architecture/published-doors.test.ts` pins that reader to the doors it holds to the published release. What each door is for comes from `ai-instructions/source/import-map.json`. The site's Import map page and its sidebar read that same file when the site builds, so neither can drift from it. `typedoc.json · entryPoints` is the one copy, because TypeDoc needs it, and this check watches it.

## What it catches

| Code | Meaning |
|---|---|
| `door-undocumented`, `entry-not-a-door` | `typedoc.json · entryPoints` and the doors disagree. |
| `output-missing` | No `api-docs.json` to read. Run `npm run docs`. |
| `door-unlisted`, `module-unknown` | The modules TypeDoc lists and the doors disagree. A wrong `@module` tag shows up here. |
| `page-missing` | A door has no page where the sidebar links. |
| `name-unlisted` | A door exports a name that the reference leaves out, for example because of `@internal`. |
| `job-missing` | A door's own comment does not say what the import map says. This is what keeps `footprintjs/advanced` marked as engine internals. |
| `door-missing`, `door-unknown`, `name-missing` | The import map and the doors disagree. `scripts/ai-instructions/facts.mjs · importMapProblems` owns this rule. |

## What it misses

Whether a comment is any good, and whether a page reads well. It does not read `foottrace`, which has its own docs. The site's link check in `docs-site/checks` follows the links.

The check is advisory in `docs-check.yml`: a red result warns on the pull request and the job stays green. `test/architecture/api-doors.test.ts` proves each code above goes red, on a small package built by real TypeDoc.
