import { z } from 'astro/zod';

/** Fail at build time instead of silently discarding unsupported blog metadata. */
export const blogSchema = z.object({
  title: z.string(),
  description: z.string(),
  date: z.date(),
  authors: z
    .array(z.literal('sanjay', { error: 'This blog currently supports the author sanjay only.' }))
    .length(1, 'This blog currently requires exactly one author: sanjay.'),
  excerpt: z.string(),
  tags: z
    .array(z.string())
    .length(0, 'Tag navigation is not implemented. Add its routes and preservation tests before using tags.')
    .default([]),
});
