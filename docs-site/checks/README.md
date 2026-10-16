# Generated-site migration checks

These checks protect the native-blog migration. They compare two **real builds**,
not a hand-written expected page list or a copied feed. The baseline must be the
unchanged PR base commit. Both docs applications install their committed locks
with `npm ci`, including the reviewed compatibility override below, without
forcing peer dependencies. Build in `TZ=UTC`.

```sh
node --test checks/compare-sites.test.mjs
node checks/compare-sites.mjs /path/to/baseline/dist dist /path/to/report.json
```

After the Astro build generates `.astro/types.d.ts`, run the strict source check
from `docs-site` (the repository's root TypeScript is already installed):

```sh
../node_modules/.bin/tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module preserve --target esnext .astro/types.d.ts src/env.d.ts src/content.config.ts src/blog/*.ts src/pages/blog/rss.xml.ts
```

The `Docs parity` pull-request workflow builds the exact PR base and candidate,
runs the documentation snippets, merges the generated TypeDoc site into each,
and uploads the comparison report even on failure. TypeDoc uses `--gitRevision
main` for both builds so source links match the published documentation rather
than the temporary checkout branch. The root library has no committed lockfile
by repository policy; the two documentation applications do.

## What must match

- Every generated HTML path, including static pages, pagination and author pages.
- Every page's text, links, images, forms, dates, ARIA labels and head metadata.
- Executable inline script contents and script attributes (apart from generated
  asset names), including code outside the posts.
- Each post's rendered content markup, including authored classes and scripts.
- RSS feed paths and complete bytes: SHA-256, byte count and item count are in the
  report. The existing site has **one** feed, `blog/rss.xml`, containing eight
  posts. The check discovers feeds rather than pretending a second feed exists.

## The complete normalization allowance

1. Content hashes in generated `/_astro/` JavaScript/CSS asset filenames.
2. Astro compiler-owned scoped classes and `data-astro-cid-*` attributes.
3. Post metadata and post-footer wrapper markup are not part of the inner-post
   markup comparison. Their text, dates, author links, pagination and accessible
   controls still take part in the whole-page comparison.

HTML is parsed using the two existing approved HAST utilities. Text, URLs, dates,
authored CSS classes and post structure are never repaired by search/replace.
Serialization differences such as attribute order and comments are not reader
content. Any further allowance requires a named, reviewed change here and a
negative-control test; do not add a broad ignore list to obtain a passing check.

## Links and size

The link checker resolves local routes, assets and fragments against the merged
site. Other projects on the same host, external sites and non-HTTP actions are
not fetched. All pre-existing broken links are reported individually; the check
fails on every newly introduced failure. This is a **no-new-regressions** result,
not a claim that existing documentation is link-clean.

No site-size budget existed before this migration. Its budget is therefore
**zero growth from the actual baseline**, for total JavaScript/CSS bytes and the
JavaScript/CSS loaded by each page. Page budgets include inline code/styles and
generated local imports, including lazy imports. Gzip figures are also reported,
but raw bytes are the deterministic gate: a changed content hash can alone alter
gzip compression. No percentage allowance or fixed extra kilobytes are granted.

This migration parity workflow intentionally rejects content or navigation
changes. Future intentional content work must adapt the contract in a reviewed
change rather than silently snapshotting new expectations. It does not replace
a browser visual and interaction check of the actual pages.

## Expressive Code dependency compatibility

`package.json` scopes a `postcss-nested` 7.0.2 override to
`@expressive-code/core@0.44.2`. Core otherwise selects Nested 6 and the vulnerable
`postcss-selector-parser` 6 line ([GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)).
Nested 7 uses the patched parser 7 line; the committed lock resolves 7.1.6.
This is an application-maintained compatibility exception, not an upstream
Expressive Code compatibility guarantee. Reevaluate and remove it when upgrading
core to a version that accepts a patched parser through its own dependencies.

Nested 7 preserves the CommonJS plugin API, default options and PostCSS 8 peer
range used by core. Its Node 18 floor fits this application's Node 22/24 builds.
It also changes comment movement: inline comments can leave an empty parent rule
after core strips comments. The tests deliberately retain this output difference;
they do not claim universal byte equivalence with Nested 6. The reviewed Node 22
and 24 builds kept all generated CSS/JS asset bytes and all 203 rendered code
blocks identical to the unchanged baseline, alongside the full site parity check.

`expressive-code.test.mjs` checks the installed dependency chain, public plugin
nesting/at-rule/comment processing, and exact public syntax HTML, CSS and frame
scripts. Its hashes come from the unchanged core 0.44.2 baseline and must be
reviewed when dependencies change, not updated just to make a test pass.
