import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { blogHref } from './posts';

// This is a mobile header alternative, not a documentation chapter. Add it
// after Starlight computes chapter pagination so it cannot become "Previous".
export const onRequest = defineRouteMiddleware((context) => {
  if (context.url.pathname.startsWith(blogHref())) return;
  context.locals.starlightRoute.sidebar.unshift({
    type: 'link',
    label: 'Blog',
    href: blogHref(),
    isCurrent: false,
    badge: undefined,
    attrs: { class: 'blog-mobile-link' },
  });
});
