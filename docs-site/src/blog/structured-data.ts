import { author, blogHref, type BlogPost } from './posts';

/** The public URLs identify the same blog, author and articles before and after migration. */
export function structuredData(site: URL, pathname: string, post?: BlogPost, authorPage = false) {
  const url = (path: string) => new URL(path, site).href;
  const blogUrl = url(blogHref());
  const blog = { '@id': `${blogUrl}#blog`, '@type': 'Blog', name: 'Blog', url: blogUrl };
  const person = {
    '@type': 'Person',
    '@id': `${url(blogHref(`authors/${author.slug}`))}#author`,
    name: author.name,
    url: author.url,
  };
  const graph = post
    ? [
        {
          '@type': 'BlogPosting',
          datePublished: post.data.date.toISOString(),
          headline: post.data.title,
          inLanguage: 'en',
          isPartOf: blog,
          mainEntityOfPage: url(blogHref(post.id)),
          url: url(blogHref(post.id)),
          author: [person],
          description: post.data.description,
          ...(post.data.tags.length ? { keywords: post.data.tags } : {}),
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Blog', item: blogUrl },
            { '@type': 'ListItem', position: 2, name: post.data.title },
          ],
        },
      ]
    : [
        {
          '@type': 'CollectionPage',
          inLanguage: 'en',
          name: authorPage ? author.name : 'Blog',
          url: url(pathname),
          ...(pathname === blogHref() ? { mainEntity: { '@id': blog['@id'] } } : { isPartOf: { '@id': blog['@id'] } }),
          ...(authorPage ? { mainEntity: { '@id': person['@id'] } } : {}),
        },
        blog,
        ...(authorPage ? [person] : []),
      ];
  return { '@context': 'https://schema.org', '@graph': graph };
}
