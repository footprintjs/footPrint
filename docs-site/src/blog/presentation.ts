import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';

type Node = ReturnType<typeof fromHtml> | ReturnType<typeof fromHtml>['children'][number];

function hasClass(node: Node, name: string) {
  return (
    node.type === 'element' && Array.isArray(node.properties.className) && node.properties.className.includes(name)
  );
}

/** Preserve the existing reading-time contract: English words, excluding code and hidden labels. */
export function readingMinutes(html: string) {
  let images = 0;
  function text(node: Node): string {
    if (node.type === 'element' && node.tagName === 'img') images++;
    if (hasClass(node, 'expressive-code') || hasClass(node, 'sr-only')) return '';
    if (node.type === 'text') return node.value;
    return 'children' in node ? node.children.map(text).join('') : '';
  }
  const words = [...new Intl.Segmenter('en', { granularity: 'word' }).segment(text(fromHtml(html)))].filter(
    (part) => part.isWordLike,
  ).length;
  let seconds = (words / 213) * 60;
  for (let index = 0; index < images; index++) seconds += Math.max(3, 12 - index);
  return Math.ceil(seconds / 60);
}

/**
 * Feed presentation policy retained from starlight-blog (MIT; see THIRD-PARTY-NOTICES).
 * Parse rendered MDX, not source text: custom components must be real HTML in readers.
 */
export function feedContent(html: string, site: URL) {
  const tree = fromHtml(html);
  function clean(node: Node): boolean {
    if (node.type === 'element') {
      if (
        ['link', 'script', 'style'].includes(node.tagName) ||
        ['sr-only', 'starlight-aside__icon', 'sl-anchor-link', 'ln'].some((name) => hasClass(node, name)) ||
        Object.hasOwn(node.properties, 'dataCode') ||
        Object.hasOwn(node.properties, 'ariaLive')
      )
        return false;
      for (const key of ['href', 'src']) {
        const value = node.properties[key];
        if (
          ((node.tagName === 'a' && key === 'href') || (node.tagName === 'img' && key === 'src')) &&
          typeof value === 'string' &&
          value.startsWith('/')
        )
          node.properties[key] = new URL(value, site).href;
      }
      for (const key of ['style', 'className', 'dataAstroSourceFile', 'dataAstroSourceLoc', 'dataLanguage'])
        delete node.properties[key];
    }
    if ('children' in node) {
      const hadChildren = node.children.length > 0;
      node.children = node.children.filter(clean);
      // A removed control must not leave its now-empty wrapper in the feed.
      if (hadChildren && node.children.length === 0) return false;
    }
    return true;
  }
  clean(tree);
  const document = tree.children.find((node) => node.type === 'element' && node.tagName === 'html');
  const body =
    document?.type === 'element' &&
    document.children.find((node) => node.type === 'element' && node.tagName === 'body');
  return toHtml(body && body.type === 'element' ? body.children : tree);
}
