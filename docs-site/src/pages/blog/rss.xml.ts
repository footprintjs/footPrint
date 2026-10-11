import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { blogHref, getPosts } from '../../blog/posts';
import { feedContent } from '../../blog/presentation';
import { renderPost } from '../../blog/render';

export const GET: APIRoute = async ({ site, locals }) => {
  if (!site) throw new Error('The blog feed requires the site URL.');
  return rss({
    title: 'footprintjs | Blog',
    description: 'The flowchart pattern for backend code. Self-explainable systems that AI can reason about.',
    site,
    xmlns: { atom: 'http://www.w3.org/2005/Atom', fh: 'http://purl.org/syndication/history/1.0' },
    items: await Promise.all(
      (
        await getPosts()
      ).map(async (post) => ({
        title: post.data.title,
        link: blogHref(post.id),
        pubDate: post.data.date,
        categories: post.data.tags,
        description: post.data.excerpt,
        content: feedContent(await renderPost(post, locals), site),
      })),
    ),
    customData: `<language>en</language>\n<fh:complete/>\n<atom:link rel="self" href="${
      new URL(blogHref('rss.xml'), site).href
    }"/>`,
  });
};
