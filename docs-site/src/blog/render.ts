import mdxRenderer from '@astrojs/mdx/server.js';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { render } from 'astro:content';
import type { BlogPost } from './posts';

const container = await AstroContainer.create();
container.addServerRenderer({ name: 'mdx', renderer: mdxRenderer });

// One English collection, rendered once per build for both metadata and RSS.
const rendered = new Map<string, Promise<string>>();
export function renderPost(post: BlogPost, locals: App.Locals) {
  let result = rendered.get(post.id);
  if (!result) {
    result = render(post).then(({ Content }) => container.renderToString(Content, { locals }));
    rendered.set(post.id, result);
  }
  return result;
}
