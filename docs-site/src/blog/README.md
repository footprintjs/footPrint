# Native blog

This is the site's English blog, not a general-purpose blog plugin. Astro owns
content loading, MDX rendering, pagination and RSS serialization. Public
Starlight components own the site shell, headings, search and navigation.

- `posts.ts` owns ordering, public URLs, the author and sidebar.
- `navigation.ts` adds the mobile Blog shortcut after Starlight computes docs
  chapter pagination. It is navigation, not a previous documentation chapter.
- `render.ts` uses Astro's container and official MDX renderer. Its per-build
  cache is for this single English collection; add a locale key if translations
  are introduced. It renders once for reading time and RSS, never at runtime.
- `presentation.ts` applies the existing reading-time and feed presentation
  rules to rendered HTML with the two explicitly declared HAST utilities. It
  does not parse HTML with regular expressions or reimplement Markdown.
- `structured-data.ts` retains public blog, author and article identities.
- `../layouts/BlogPage.astro` composes the public Starlight page. Small local
  components render metadata, previews and previous/next links.

Add an MDX post to `../content/docs/blog/` with the same frontmatter as the
existing posts. The `blog` collection owns these files; the `docs` collection
explicitly excludes them. Their existing location is intentional: Starlight's
official Markdown transformations apply there, preserving heading anchors and
code direction without private imports or a second implementation. File names
are published URL slugs; do not rename an existing post.

The eight existing posts have one author and no tags, covers, drafts or locale
variants. Those are not silently supplied by a plugin anymore. If introducing
such a feature, update the schema, routes, presentation and preservation tests
together. The feed currently contains all eight posts and remains complete;
there are no archive feeds to retain.

The preservation checks compare the full generated page list, rendered post
content, metadata, navigation, JSON-LD, RSS bytes and JavaScript/CSS budgets with
the base branch. Run the docs build with `TZ=UTC` for the comparison. Source
posts must remain byte-identical during this migration. The shared library's
documentation snippets are still checked separately from the site build.

Small styling and feed rules adapted from the former plugin retain its MIT
notice in `../../THIRD-PARTY-NOTICES.txt`. There is no plugin dependency, override,
private import or vendored plugin framework.
