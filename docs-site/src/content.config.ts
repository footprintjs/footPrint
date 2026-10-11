import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { blogSchema } from './blog/schema';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    // Separate ownership without relocating source: Starlight's Markdown transforms
    // apply to content/docs, including blog headings and code direction attributes.
    loader: glob({
      pattern: ['**/[^_]*.{markdown,mdown,mkdn,mkd,mdwn,md,mdx}', '!blog/**'],
      base: './src/content/docs',
    }),
    schema: docsSchema(),
  }),
  blog: defineCollection({
    loader: glob({ pattern: '**/*.mdx', base: './src/content/docs/blog' }),
    schema: blogSchema,
  }),
};
