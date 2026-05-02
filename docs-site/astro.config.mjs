import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';

export default defineConfig({
  // Must match GitHub repository name. Update base + site if repo is renamed
  // or moved to a custom domain (e.g. base: '/', site: 'https://footprintjs.dev').
  site: 'https://footprintjs.github.io',
  base: '/footPrint',
  // Allow importing from ../examples/ for code examples in docs
  vite: {
    resolve: { alias: { '@examples': new URL('../examples', import.meta.url).pathname } },
    server: { fs: { allow: ['..'] } },
  },
  redirects: {
    '/api/modules/main':      '/footPrint/api/modules/index.html',
    '/api/modules/recorders': '/footPrint/api/modules/recorders.html',
    '/api/modules/advanced':  '/footPrint/api/modules/advanced.html',
  },
  integrations: [
    starlight({
      title: 'footprintjs',
      description: 'The flowchart pattern for backend code. Self-explainable systems that AI can reason about.',
      plugins: [
        starlightBlog({
          title: 'Blog',
          navigation: 'header-start',
          metrics: { readingTime: true },
          rss: true,
          authors: {
            sanjay: {
              name: 'Sanjay Krishna Anbalagan',
              title: 'Creator of footprintjs',
              url: 'https://github.com/sanjay1909',
            },
          },
        }),
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/footprintjs/footPrint' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/footprintjs' },
      ],
      components: {
        SiteTitle: './src/components/HeaderLinks.astro',
      },
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'meta',
          attrs: { name: 'author', content: 'Sanjay Krishna Anbalagan' },
        },
        {
          tag: 'meta',
          attrs: { name: 'keywords', content: 'footprintjs, flowchart, backend, orchestration, tracing, observability, recorder, narrative, TypeScript, AI, LLM, explainability, Sanjay Krishna Anbalagan' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://footprintjs.github.io/footPrint/og.png' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:width', content: '1200' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:height', content: '630' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:alt', content: 'footprintjs — The flowchart pattern for backend code' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:image', content: 'https://footprintjs.github.io/footPrint/og.png' },
        },
        {
          tag: 'meta',
          attrs: { property: 'article:author', content: 'Sanjay Krishna Anbalagan' },
        },
        {
          tag: 'meta',
          attrs: { property: 'article:publisher', content: 'https://www.linkedin.com/in/sanjay-krishna-anbalagan/' },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'TechArticle',
            author: { '@type': 'Person', name: 'Sanjay Krishna Anbalagan', url: 'https://github.com/sanjay1909', sameAs: ['https://www.linkedin.com/in/sanjay-krishna-anbalagan/', 'https://github.com/sanjay1909'] },
            creator: { '@type': 'Person', name: 'Sanjay Krishna Anbalagan', url: 'https://www.linkedin.com/in/sanjay-krishna-anbalagan/' },
            publisher: { '@type': 'Organization', name: 'footprintjs', url: 'https://footprintjs.github.io/footPrint/' },
            isPartOf: { '@type': 'WebSite', name: 'footprintjs', url: 'https://footprintjs.github.io/footPrint/' },
          }),
        },
      ],
      sidebar: [
        { label: 'Overview', slug: 'overview' },
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Key Concepts', slug: 'getting-started/key-concepts' },
            { label: 'Why footprintjs?', slug: 'getting-started/why' },
          ],
        },
        {
          label: 'Building Blocks',
          items: [
            { label: 'Stages & flowcharts', slug: 'guides/building-blocks/stages' },
            { label: 'Decision branching', slug: 'guides/building-blocks/decisions' },
            { label: 'Subflows & composition', slug: 'guides/building-blocks/subflows' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'Observing with recorders', slug: 'guides/features/recorders' },
            { label: 'Self-describing APIs', slug: 'guides/features/self-describing' },
            { label: 'Redaction & PII', slug: 'guides/features/redaction' },
            { label: 'Pause & resume', slug: 'guides/features/pause-resume' },
            { label: 'Streaming stages', slug: 'guides/features/streaming' },
          ],
        },
        {
          label: 'Patterns',
          items: [
            { label: 'Loops & retry', slug: 'guides/patterns/loops-and-retry' },
            { label: 'Error handling', slug: 'guides/patterns/error-handling' },
            { label: 'Detach (fire-and-forget)', slug: 'guides/patterns/detach' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'flowChart() / Builder', slug: 'api/flowchart' },
            { label: 'decide() / select()', slug: 'api/decide' },
            { label: 'FlowChartExecutor', slug: 'api/executor' },
            { label: 'Recorders', slug: 'api/recorders' },
            { label: 'Contract & Self-describing', slug: 'api/contract' },
          ],
        },
        {
          label: 'Resources',
          items: [
            {
              label: 'Interactive Playground',
              link: 'https://footprintjs.github.io/footprint-playground/',
              attrs: { target: '_blank', rel: 'noopener' },
            },
            {
              label: 'Examples on GitHub',
              link: 'https://github.com/footprintjs/footPrint/tree/main/examples',
              attrs: { target: '_blank', rel: 'noopener' },
            },
          ],
        },
      ],
    }),
  ],
});
