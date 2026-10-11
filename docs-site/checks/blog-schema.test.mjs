import assert from 'node:assert/strict';
import test from 'node:test';
import { blogSchema } from '../src/blog/schema.ts';

const post = {
  title: 'Title',
  description: 'Description',
  date: new Date('2026-04-13'),
  authors: ['sanjay'],
  excerpt: 'Excerpt',
};

test('the existing single-author, untagged metadata is preserved', () => {
  assert.deepEqual(blogSchema.parse(post), { ...post, tags: [] });
  assert.deepEqual(blogSchema.parse({ ...post, tags: [] }), { ...post, tags: [] });
});

test('unsupported author lists fail instead of showing the wrong author', () => {
  for (const authors of [[], ['other'], ['sanjay', 'sanjay']]) {
    const result = blogSchema.safeParse({ ...post, authors });
    assert.equal(result.success, false);
    assert.match(result.error.message, /author/i);
  }
});

test('tags fail with a clear requirement for tag navigation', () => {
  const result = blogSchema.safeParse({ ...post, tags: ['tracing'] });
  assert.equal(result.success, false);
  assert.match(result.error.message, /Tag navigation is not implemented/);
});
