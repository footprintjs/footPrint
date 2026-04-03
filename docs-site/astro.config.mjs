import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';

export default defineConfig({
  // Must match GitHub repository name. Update base + site if repo is renamed
  // or moved to a custom domain (e.g. base: '/', site: 'https://footprintjs.dev').
  site: 'https://footprintjs.github.io',
  base: '/footPrint',
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
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://footprintjs.github.io/footPrint/og.png' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Key Concepts', slug: 'getting-started/key-concepts' },
            { label: 'Why footprintjs?', slug: 'getting-started/why' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Building a flowchart', slug: 'guides/building' },
            { label: 'Decision branching', slug: 'guides/decision-branching' },
            { label: 'Observing with recorders', slug: 'guides/recording' },
            { label: 'Subflows & composition', slug: 'guides/subflows' },
            { label: 'Self-describing APIs', slug: 'guides/self-describing' },
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
              label: 'Samples on GitHub',
              link: 'https://github.com/footprintjs/footprint-samples',
              attrs: { target: '_blank', rel: 'noopener' },
            },
          ],
        },
      ],
    }),
  ],
});
