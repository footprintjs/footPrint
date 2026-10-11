# Generated-site migration checks

These checks protect the native-blog migration. They compare two **real builds**,
not a hand-written expected page list or a copied feed. The baseline must be the
unchanged PR base commit. Both docs applications install their committed locks
with `npm ci`, without overrides or forced peer dependencies. Build in `TZ=UTC`.

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
