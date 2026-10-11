import { readFile, readdir } from 'node:fs/promises';
import { posix, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { elements, htmlContract } from './html-contract.mjs';

export const siteRoot = 'https://footprintjs.github.io/footPrint/';

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

export async function auditSite(root) {
  const files = new Map(
    await Promise.all((await paths(root)).map(async (path) => [path, await readFile(join(root, path))])),
  );
  const pages = new Map(
    [...files]
      .filter(([path]) => path.endsWith('.html'))
      .map(([path, bytes]) => [path, htmlContract(bytes.toString())]),
  );
  const feeds = Object.fromEntries(
    [...files]
      .filter(([, bytes]) => /^\s*<\?xml[^>]*>\s*<rss\b/.test(bytes.toString()))
      .map(([path, bytes]) => [
        path,
        {
          ...size(bytes),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          items: (bytes.toString().match(/<item>/g) ?? []).length,
        },
      ]),
  );
  const brokenLinks = [];
  const perPage = {};
  const totals = { js: { bytes: 0, gzipBytes: 0 }, css: { bytes: 0, gzipBytes: 0 } };
  for (const [path, bytes] of files) {
    const kind = path.endsWith('.js') ? 'js' : path.endsWith('.css') ? 'css' : undefined;
    if (kind) for (const key of ['bytes', 'gzipBytes']) totals[kind][key] += size(bytes)[key];
  }
  for (const [page, contract] of pages) {
    const resources = new Set();
    const inline = { js: [], css: [] };
    for (const node of elements(contract.tree)) {
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
            pages.get(file).tree,
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
      const buffers = [...resources].filter((path) => path.endsWith(`.${kind}`)).map((path) => files.get(path));
      buffers.push(...inline[kind].map((source) => Buffer.from(source)));
      for (const bytes of buffers) for (const key of ['bytes', 'gzipBytes']) budget[kind][key] += size(bytes)[key];
    }
    perPage[page] = budget;
  }
  return {
    pages: Object.fromEntries(
      [...pages].map(([path, contract]) => [
        path,
        { semantics: contract.semantics, postBody: contract.postBody, postBodySource: contract.postBodySource },
      ]),
    ),
    feeds,
    brokenLinks: [...new Map(brokenLinks.map((link) => [JSON.stringify(link), link])).values()],
    budgets: { totals, perPage },
  };
}
