import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';

export const hasClass = (node, name) => node.properties?.className?.includes(name);
export function elements(node, predicate = () => true) {
  return [
    ...(node.type === 'element' && predicate(node) ? [node] : []),
    ...(node.children ?? []).flatMap((child) => elements(child, predicate)),
  ];
}

// Only compiler-owned names are normalized. Text, links, dates, authored class
// names, style attributes, and script bodies otherwise remain part of the proof.
export function generatedNames(value) {
  return value.replace(/(\/_astro\/[^\s"'<>]*\.)[\w-]+(?=\.(?:css|js)\b)/g, '$1HASH');
}

function normalizedTree(node) {
  if (node.type === 'comment') return undefined;
  const result = { ...node };
  delete result.position;
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties)
        .filter(([key]) => !/^dataAstroCid/.test(key))
        .map(([key, value]) => [
          key,
          key === 'className'
            ? value.filter((name) => !/^astro-[a-z0-9]+$/.test(name))
            : typeof value === 'string'
            ? generatedNames(value)
            : value,
        ])
        .filter(([key, value]) => key !== 'className' || value.length)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (result.children) result.children = result.children.map(normalizedTree).filter(Boolean);
  return result;
}

export function normalizedMarkup(node) {
  return toHtml(normalizedTree(node));
}

function text(node) {
  if (node.type === 'text') return node.value;
  if (['script', 'style', 'template'].includes(node.tagName)) return '';
  return (node.children ?? []).map(text).join(' ');
}

export function visibleText(node) {
  return text(node).replace(/\s+/g, ' ').trim();
}

export function htmlContract(html) {
  const tree = fromHtml(html);
  const body = elements(tree, (node) => node.tagName === 'body')[0];
  const head = elements(tree, (node) => node.tagName === 'head')[0];
  const markdown = elements(tree, (node) => hasClass(node, 'sl-markdown-content'))[0];
  const metadata = elements(tree, (node) => hasClass(node, 'sl-blog-metadata'));
  const isPost = Boolean(
    markdown &&
      metadata.length === 1 &&
      elements(
        head,
        (node) =>
          node.tagName === 'meta' && node.properties.property === 'og:type' && node.properties.content === 'article',
      ).length,
  );
  const semantics = {
    text: visibleText(body ?? tree),
    scripts: elements(tree, (node) => node.tagName === 'script' && node.properties.type !== 'application/ld+json').map(
      (node) => ({
        properties: Object.fromEntries(
          Object.entries(node.properties).map(([key, value]) => [
            key,
            typeof value === 'string' ? generatedNames(value) : value,
          ]),
        ),
        source: generatedNames((node.children ?? []).map((child) => child.value ?? '').join('')),
      }),
    ),
    // Includes every link (not merely links within <nav>), titles, form controls,
    // time attributes, images and ARIA labels. Styling cannot hide a broken URL.
    controls: elements(
      body ?? tree,
      (node) =>
        ['a', 'img', 'button', 'input', 'select', 'option', 'time', 'form'].includes(node.tagName) ||
        Object.keys(node.properties).some((key) => key.startsWith('aria') || key === 'dataCurrent'),
    ).map((node) => ({
      tag: node.tagName,
      text: visibleText(node),
      properties: Object.fromEntries(
        Object.entries(node.properties)
          .filter(
            ([key]) => !['className', 'style'].includes(key) && (!key.startsWith('data') || key === 'dataCurrent'),
          )
          .map(([key, value]) => [key, typeof value === 'string' ? generatedNames(value) : value])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    })),
    // Styles and executable scripts have their own resource and visual checks.
    head: elements(
      head ?? { children: [] },
      (node) =>
        ['title', 'meta'].includes(node.tagName) ||
        (node.tagName === 'link' &&
          !node.properties.rel?.some((rel) => ['stylesheet', 'modulepreload', 'preload'].includes(rel))) ||
        (node.tagName === 'script' && node.properties.type === 'application/ld+json'),
    )
      .map(normalizedMarkup)
      .sort(),
  };
  const postTree = isPost
    ? {
        type: 'root',
        children: markdown.children.filter(
          (node) => !hasClass(node, 'sl-blog-metadata') && !hasClass(node, 'sl-blog-post-footer'),
        ),
      }
    : undefined;
  return {
    tree,
    semantics,
    postBody: postTree ? normalizedMarkup(postTree) : undefined,
    postBodySource: postTree ? toHtml(postTree) : undefined,
  };
}
