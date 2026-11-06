import { readFile, readdir } from 'node:fs/promises';
import { posix, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fromHtml } from 'hast-util-from-html';

export const siteRoot = 'https://footprintjs.github.io/footPrint/';

// TypeDoc's search, navigation and hierarchy files are data about the API. They grow
// with every documented name, so they are reported but not budgeted. Its code stays in.
const API_DATA = /^api\/assets\/(?:search|navigation|hierarchy)\.js$/;

async function paths(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? paths(root, posix.join(prefix, entry.name)) : [posix.join(prefix, entry.name)],
      ),
    )
  )
    .flat()
    .sort();
}

function elements(node, predicate = () => true) {
  return [
    ...(node.type === 'element' && predicate(node) ? [node] : []),
    ...(node.children ?? []).flatMap((child) => elements(child, predicate)),
  ];
}

// Only a post page renders the post footer (`pages/blog/[slug].astro`). A listing
// page also shows post metadata, so metadata cannot tell the two apart.
const isPost = (tree) =>
  elements(tree, (node) => node.properties?.className?.includes('sl-blog-post-footer')).length > 0;

function localUrl(reference, page) {
  if (!reference || /^(?:data|mailto|tel|javascript):/i.test(reference)) return undefined;
  const url = new URL(reference, new URL(page.replace(/index\.html$/, ''), siteRoot));
  const root = new URL(siteRoot);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return undefined;
  return {
    path: decodeURIComponent(url.pathname.slice(root.pathname.length)),
    hash: decodeURIComponent(url.hash.slice(1)),
  };
}

function resolveFile(path, files) {
  return [path, posix.join(path, 'index.html'), `${path}.html`].find((candidate) => files.has(candidate));
}

function size(buffer) {
  return { bytes: buffer.length, gzipBytes: gzipSync(buffer).length };
}

// The generator escapes every post body, so these tags are always the feed's own.
function feedItems(xml) {
  const field = (item, name) => item.match(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`))?.[1];
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: field(item, 'title'),
    link: field(item, 'link'),
    guid: field(item, 'guid'),
    pubDate: field(item, 'pubDate'),
  }));
}

// Every item must lead to a generated page, and every post must be in a feed.
function feedProblems(feeds, posts, files, pages) {
  const problems = [];
  const linked = new Set();
  for (const [path, feed] of Object.entries(feeds)) {
    for (const item of feed.items) {
      const target = item.link && localUrl(item.link, path);
      const file = target && resolveFile(target.path, files);
      if (pages.has(file)) linked.add(file);
      else problems.push(`${path} item leads to no page: ${item.link}`);
    }
  }
  for (const post of posts) if (!linked.has(post)) problems.push(`post is in no feed: ${post}`);
  return problems;
}

export async function auditSite(root) {
  const files = new Map(
    await Promise.all((await paths(root)).map(async (path) => [path, await readFile(join(root, path))])),
  );
  const pages = new Map(
    [...files].filter(([path]) => path.endsWith('.html')).map(([path, bytes]) => [path, fromHtml(bytes.toString())]),
  );
  const feeds = Object.fromEntries(
    [...files]
      .filter(([, bytes]) => /^\s*<\?xml[^>]*>\s*<rss\b/.test(bytes.toString()))
      .map(([path, bytes]) => [
        path,
        {
          ...size(bytes),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          items: feedItems(bytes.toString()),
        },
      ]),
  );
  const posts = [...pages].filter(([, tree]) => isPost(tree)).map(([path]) => path);
  const brokenLinks = [];
  const perPage = {};
  const totals = { js: { bytes: 0, gzipBytes: 0 }, css: { bytes: 0, gzipBytes: 0 } };
  const apiData = {};
  for (const [path, bytes] of files) {
    if (API_DATA.test(path)) {
      apiData[path] = size(bytes);
      continue;
    }
    const kind = path.endsWith('.js') ? 'js' : path.endsWith('.css') ? 'css' : undefined;
    if (kind) for (const key of ['bytes', 'gzipBytes']) totals[kind][key] += size(bytes)[key];
  }
  for (const [page, tree] of pages) {
    const resources = new Set();
    const inline = { js: [], css: [] };
    for (const node of elements(tree)) {
      for (const key of ['href', 'src', 'poster']) {
        if (typeof node.properties[key] !== 'string') continue;
        const reference = node.properties[key];
        const target = localUrl(reference, page);
        if (!target) continue;
        const file = resolveFile(target.path, files);
        if (!file) {
          brokenLinks.push({ page, reference, reason: 'missing file' });
          continue;
        }
        if (
          target.hash &&
          pages.has(file) &&
          !elements(
            pages.get(file),
            (element) => element.properties.id === target.hash || element.properties.name === target.hash,
          ).length
        ) {
          brokenLinks.push({ page, reference, reason: 'missing anchor' });
        }
        if (['script', 'link'].includes(node.tagName) && /\.(?:js|css)$/.test(file)) resources.add(file);
      }
      if (node.tagName === 'style') inline.css.push((node.children ?? []).map((child) => child.value ?? '').join(''));
      if (node.tagName === 'script' && !node.properties.src && node.properties.type !== 'application/ld+json')
        inline.js.push((node.children ?? []).map((child) => child.value ?? '').join(''));
    }
    // Follow generated JS/CSS imports too; an entry chunk cannot conceal a large
    // lazy-loaded payload from its page budget. Only existing local resources count.
    const visitReferences = (source, origin) => {
      for (const match of source.matchAll(/["'`]([^"'`\s]+\.(?:js|css)(?:\?[^"'`\s]*)?)["'`]/g)) {
        const target = localUrl(match[1], origin);
        const file = target && resolveFile(target.path, files);
        if (file && /\.(?:js|css)$/.test(file)) resources.add(file);
      }
    };
    for (const source of [...inline.js, ...inline.css]) visitReferences(source, page);
    for (const resource of resources) visitReferences(files.get(resource).toString(), resource);
    const budget = { js: { bytes: 0, gzipBytes: 0 }, css: { bytes: 0, gzipBytes: 0 } };
    for (const kind of ['js', 'css']) {
      const buffers = [...resources]
        .filter((path) => path.endsWith(`.${kind}`) && !API_DATA.test(path))
        .map((path) => files.get(path));
      buffers.push(...inline[kind].map((source) => Buffer.from(source)));
      for (const bytes of buffers) for (const key of ['bytes', 'gzipBytes']) budget[kind][key] += size(bytes)[key];
    }
    perPage[page] = budget;
  }
  return {
    pages: [...pages.keys()],
    posts,
    feeds,
    feedProblems: feedProblems(feeds, posts, files, pages),
    brokenLinks: [...new Map(brokenLinks.map((link) => [JSON.stringify(link), link])).values()],
    budgets: { totals, perPage, apiData },
  };
}
