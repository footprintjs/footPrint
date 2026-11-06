# Generated-site checks

These checks compare two **real builds** of the site: the pull request's base
and its candidate. Pages are free to change. A pull request can add, edit, move
or delete a page, but it cannot break a link, damage the feed or grow the
JavaScript and CSS. Both docs applications install their committed locks with
`npm ci`, including the reviewed compatibility override below, without forcing
peer dependencies. Build in `TZ=UTC`.

```sh
node --test checks/compare-sites.test.mjs
node checks/compare-sites.mjs /path/to/baseline/dist dist /path/to/report.json
```

After the Astro build generates `.astro/types.d.ts`, run the strict source check
from `docs-site` (the repository's root TypeScript is already installed):

```sh
../node_modules/.bin/tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module preserve --target esnext .astro/types.d.ts src/env.d.ts src/content.config.ts src/blog/*.ts src/pages/blog/rss.xml.ts
```

The `Docs site checks` pull-request workflow builds the exact PR base and
candidate, runs the documentation snippets, merges the generated TypeDoc site
into each, and uploads the report even on failure. TypeDoc uses `--gitRevision
main` for both builds so source links match the published documentation rather
than the temporary checkout branch.

## What fails

`compareSites` in `compare-sites.mjs` fails for these reasons:

- **An empty build.** Either build has no HTML or no RSS feed.
- **A new broken local link.** See "Links and size".
- **A damaged feed.** See "The feed".
- **JavaScript or CSS growth.** See "Links and size".

Every rule has a test in `compare-sites.test.mjs` that makes it fail, next to a
test for the content change it must allow.

Page text, navigation, head metadata and the page list are not compared. The
report lists `pages.added` and `pages.removed` for the reviewer. A deleted page
that another page still links to fails the link check, but nothing here can see
links from outside the site, so check those when you delete a page. These checks
do not replace a look at the actual pages in a browser.

## The feed

`site-audit.mjs` reads each RSS feed it finds. The site has **one** feed,
`blog/rss.xml`. The check fails when:

- a feed path from the base build is gone, or a feed has no items;
- an item that stays in the feed changes its date, because that reorders it for
  feed readers;
- an item leads to no generated page;
- a post page is in no feed.

A post keeps its `guid` because the URL is its file name, and
[the blog notes](../src/blog/README.md) say never to rename a post. This check
cannot tell a rename from a delete and an add. It reads both as allowed.

Feed bytes may change. They hold the post text, the links in it and the site
description, and all of these change with ordinary content work. The report keeps
each feed's SHA-256, byte count and items for the reviewer. `presentation.test.mjs`
tests how a post is turned into feed content.

## Links and size

The link checker resolves local routes, assets and fragments against the merged
site. Other projects on the same host, external sites and non-HTTP actions are
not fetched. All pre-existing broken links are reported individually; the check
fails on every newly introduced failure. This is a **no-new-regressions** result,
not a claim that existing documentation is link-clean. A failure is a page plus
a reference, so a broken reference that every page shares would fail each new page.

No site-size budget existed before the blog migration. The budget is therefore
**zero growth from the actual baseline**, for total JavaScript/CSS bytes and the
JavaScript/CSS loaded by each page. Page budgets include inline code/styles and
generated local imports, including lazy imports. A new page has no baseline of its
own and counts only toward the total. Gzip figures are also reported, but raw bytes
are the deterministic gate: a changed content hash can alone alter gzip compression.
No percentage allowance or fixed extra kilobytes are granted.

One named exception: TypeDoc's `api/assets/search.js`, `navigation.js` and
`hierarchy.js` are data about the API, and they grow with every documented name.
The report lists them under `apiData` and no budget counts them. TypeDoc's code,
such as `main.js`, stays in the budget. Any further exception needs a named,
reviewed change here and a test that proves the rule around it still fails.

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
