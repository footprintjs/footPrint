import { getCollection, type CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;
export const pageSize = 5;
export const author = {
  name: 'Sanjay Krishna Anbalagan',
  title: 'Creator of footprintjs',
  url: 'https://github.com/sanjay1909',
  slug: 'sanjay-krishna-anbalagan',
};

function blogPath(path = '') {
  return `/blog/${path}${path && !path.endsWith('.xml') ? '/' : ''}`;
}

export function blogHref(path = '') {
  return `${import.meta.env.BASE_URL.replace(/\/$/, '')}${blogPath(path)}`;
}

export async function getPosts() {
  return (await getCollection('blog')).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime() || a.data.title.localeCompare(b.data.title),
  );
}

export async function getBlogSidebar() {
  const posts = await getPosts();
  return [
    { label: 'All posts', link: blogPath() },
    {
      label: 'Recent posts',
      items: posts.slice(0, 10).map((post) => ({ label: post.data.title, link: blogPath(post.id) })),
    },
    { label: 'RSS', link: blogPath('rss.xml') },
  ];
}
