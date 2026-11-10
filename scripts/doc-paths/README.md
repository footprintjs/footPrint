# doc-paths

Fails when a doc names a repo path that is not in the tree. Docs go stale this way when a file moves or is deleted and nothing points back at the docs that named it.

```sh
node scripts/doc-paths/check.mjs     # exit 1, one line per problem: file:line: path
```

| File        | One job                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `paths.mjs` | The rule, as pure functions: which tokens are paths, which docs and paths are excluded, and whether a path resolves. |
| `check.mjs` | The command line. It reads `git ls-files` and each doc, and prints the problems. It fixes nothing.                   |

## What counts

Every tracked `.md` and `.mdx` file is read. A path is a token that starts with `src/`, `test/`, `docs/`, `docs-site/`, `scripts/`, `examples/`, `bench/`, `ai-instructions/`, `contract/`, `.github/` or `.claude/`. A trailing `:line` or `:from-to` is dropped. Globs (`*`, `{}`, `[]`) and placeholders (`...`, `<name>`) are not checked.

A path resolves when it is a tracked file, a tracked folder, or a tracked file whose extension the doc left out. It is tried from the repo root first, then from the doc's own package folder (the nearest folder above the doc with its own `package.json`), so `docs-site/checks/README.md` may name `env.d.ts` under its own `src` folder and mean `docs-site/src/env.d.ts`.

## What it skips, and why

Each exclusion is listed once in `paths.mjs`, with its reason:

- `EXCLUDED_DOCS`: `CHANGELOG.md` (history) and `docs/design/` (dated design notes). Both describe the tree they were written in.
- `ALLOWED_PATHS`: install destinations in a user's project (from `ai-instructions/README.md`) and outputs that git ignores (`docs-site/dist`, `bench/results/latest.json`).
- `FOREIGN_PACKAGES`: a sentence that names the `foottrace` package speaks about that repository's tree, so its paths are not checked here.

## What it misses

Paths that do not start with one of the roots above, such as `lib/memory/` or `runner/validateInput.ts` written relative to `src/lib/`. Symbols after a path (`file · symbol`) are not checked. Links in the site are checked by `docs-site/checks`.

`test/architecture/doc-paths.test.ts` pins each rule on small in-memory cases and runs the check on this repository.
