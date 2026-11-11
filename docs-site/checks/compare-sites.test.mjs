import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSite } from './site-audit.mjs';
import { compareSites } from './compare-sites.mjs';

const html = `<!doctype html><html><head><title>A post</title><meta property="og:type" content="article"><meta name="description" content="Summary"><link rel="stylesheet" href="/footPrint/_astro/site.a123.css"></head><body><nav><a href="/footPrint/blog/">Blog</a></nav><main><div class="sl-markdown-content"><div class="sl-blog-metadata astro-abc123"><time datetime="2026-10-11">11 October 2026</time><a href="https://example.org">Author</a></div><p class="authored astro-abc123">Original <strong>post</strong>.</p><a href="#target">Jump</a><h2 id="target">Target</h2><div class="sl-blog-post-footer"><a href="/footPrint/blog/">Back</a></div></div></main><script type="module" src="/footPrint/_astro/app.abc123.js"></script></body></html>`;

const plainPage = (body) =>
  `<!doctype html><html><head><title>A page</title></head><body><main>${body}</main></body></html>`;

const postLink = 'https://footprintjs.github.io/footPrint/blog/';
const item = ({ link = postLink, date = 'Sun, 11 Oct 2026 00:00:00 GMT', body = 'Original' } = {}) =>
  `<item><title>A post</title><link>${link}</link><guid isPermaLink="true">${link}</guid><description>Summary</description><pubDate>${date}</pubDate><content:encoded>&lt;p&gt;${body}&lt;/p&gt;</content:encoded></item>`;
const feed = (...items) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Blog</title><description>Pitch</description>${items.join(
    '',
  )}</channel></rss>`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'docs-site-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'blog'), { recursive: true });
  await mkdir(join(root, '_astro'));
  await writeFile(join(root, 'blog/index.html'), html);
  await writeFile(join(root, '_astro/site.a123.css'), 'p{color:red}');
  await writeFile(join(root, '_astro/app.abc123.js'), 'console.log("ok");');
  await writeFile(join(root, 'blog/rss.xml'), feed(item()));
  return root;
}

test('an unchanged build passes, with one post and the exact feed', async (t) => {
  const root = await fixture(t);
  const site = await auditSite(root);
  const report = compareSites(site, site);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, true);
  assert.equal(report.posts.after, 1);
  assert.deepEqual(report.feeds.before['blog/rss.xml'].items, [
    { title: 'A post', link: postLink, guid: postLink, pubDate: 'Sun, 11 Oct 2026 00:00:00 GMT' },
  ]);
});

test('refuses an empty or incomplete baseline instead of comparing two empty outputs', async (t) => {
  const root = await fixture(t);
  const site = await auditSite(root);
  const message = 'Baseline must contain generated HTML and an RSS feed';
  assert.ok(compareSites({ ...site, pages: [] }, site).failures.includes(message));
  assert.ok(compareSites({ ...site, feeds: {} }, site).failures.includes(message));
});

test('refuses an empty candidate, which no longer fails any page comparison', async (t) => {
  const root = await fixture(t);
  const site = await auditSite(root);
  assert.ok(
    compareSites(site, { ...site, pages: [] }).failures.includes(
      'Candidate must contain generated HTML and an RSS feed',
    ),
  );
  assert.ok(
    compareSites(site, { ...site, feeds: {} }).failures.includes(
      'Candidate must contain generated HTML and an RSS feed',
    ),
  );
});

for (const [label, from, to] of [
  ['post text', 'Original', 'Altered'],
  ['a date in the page', 'datetime="2026-10-11"', 'datetime="2026-10-12"'],
  ['the title', '<title>A post</title>', '<title>Different</title>'],
  ['post markup', '<strong>post</strong>', '<em>post</em>'],
]) {
  test(`allows a content change: ${label}`, async (t) => {
    const root = await fixture(t);
    const before = await auditSite(root);
    await writeFile(join(root, 'blog/index.html'), html.replace(from, to));
    assert.deepEqual(compareSites(before, await auditSite(root)).failures, []);
  });
}

test('allows a new page and reports it', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await mkdir(join(root, 'guide'));
  await writeFile(join(root, 'guide/index.html'), plainPage('<a href="/footPrint/blog/">Blog</a>'));
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.pages.added, ['guide/index.html']);
});

test('allows a deleted page nothing links to, and reports it', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'guide'));
  await writeFile(join(root, 'guide/index.html'), plainPage('Old'));
  const before = await auditSite(root);
  await rm(join(root, 'guide'), { recursive: true });
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.pages.removed, ['guide/index.html']);
});

test('refuses a deleted page that another page still links to', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'guide'));
  await mkdir(join(root, 'other'));
  await writeFile(join(root, 'guide/index.html'), plainPage('Old'));
  await writeFile(join(root, 'other/index.html'), plainPage('<a href="/footPrint/guide/">Guide</a>'));
  const before = await auditSite(root);
  assert.deepEqual(before.brokenLinks, []);
  await rm(join(root, 'guide'), { recursive: true });
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(report.linkCheck.introduced, [
    { page: 'other/index.html', reference: '/footPrint/guide/', reason: 'missing file' },
  ]);
  assert.ok(report.failures.includes('New broken local links: 1'));
});

test('refuses a new page with a broken link', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await mkdir(join(root, 'guide'));
  await writeFile(join(root, 'guide/index.html'), plainPage('<a href="/footPrint/gone/">Gone</a>'));
  assert.ok(compareSites(before, await auditSite(root)).failures.includes('New broken local links: 1'));
});

test('reports inherited broken links explicitly and refuses any newly introduced link', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'blog/index.html'), html.replace('#target', '#missing'));
  const before = await auditSite(root);
  assert.equal(before.brokenLinks.length, 1);
  const unchanged = compareSites(before, await auditSite(root));
  assert.equal(unchanged.passed, true);
  assert.equal(unchanged.linkCheck.inherited.length, 1);
  await writeFile(join(root, 'blog/index.html'), html.replace('#target', '#different'));
  assert.equal(compareSites(before, await auditSite(root)).linkCheck.introduced.length, 1);
});

test('refuses a double-prefixed link', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, 'blog/index.html'), html.replace('/footPrint/blog/', '/footPrint/footPrint/blog/'));
  assert.equal(compareSites(before, await auditSite(root)).passed, false);
});

test('resolves TypeDoc routes, assets and fragments after the merge', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'api/modules'), { recursive: true });
  await writeFile(
    join(root, 'api/modules/index.html'),
    '<html><head><title>API</title></head><body><h1 id="entry">API</h1></body></html>',
  );
  await writeFile(join(root, 'blog/index.html'), html.replace('#target', '/footPrint/api/modules/index.html#entry'));
  assert.deepEqual((await auditSite(root)).brokenLinks, []);
});

test('allows edited post text and a new channel description in the feed', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(
    join(root, 'blog/rss.xml'),
    feed(item({ body: 'Altered' })).replace('<description>Pitch</description>', '<description>New</description>'),
  );
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(report.failures, []);
  assert.notEqual(report.feeds.before['blog/rss.xml'].sha256, report.feeds.after['blog/rss.xml'].sha256);
});

test('allows a post and its feed item to leave together', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'blog/second'));
  const second = 'https://footprintjs.github.io/footPrint/blog/second/';
  await writeFile(join(root, 'blog/second/index.html'), html);
  await writeFile(join(root, 'blog/rss.xml'), feed(item(), item({ link: second })));
  const before = await auditSite(root);
  assert.deepEqual(before.posts.sort(), ['blog/index.html', 'blog/second/index.html']);
  await rm(join(root, 'blog/second'), { recursive: true });
  await writeFile(join(root, 'blog/rss.xml'), feed(item()));
  assert.deepEqual(compareSites(before, await auditSite(root)).failures, []);
});

test('refuses a removed feed path', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await mkdir(join(root, 'feeds'));
  await rm(join(root, 'blog/rss.xml'));
  await writeFile(join(root, 'feeds/rss.xml'), feed(item()));
  assert.ok(compareSites(before, await auditSite(root)).failures.includes('RSS feed path removed: blog/rss.xml'));
});

test('refuses a feed that lost every item', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, 'blog/rss.xml'), feed());
  const { failures } = compareSites(before, await auditSite(root));
  assert.ok(failures.includes('RSS feed has no items: blog/rss.xml'));
  assert.ok(failures.includes('RSS feed and posts disagree: post is in no feed: blog/index.html'));
});

test('refuses a new feed with no items', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, 'blog/second.xml'), feed());
  assert.deepEqual(compareSites(before, await auditSite(root)).failures, ['RSS feed has no items: blog/second.xml']);
});

test('refuses a changed date on an existing feed item', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, 'blog/rss.xml'), feed(item({ date: 'Mon, 12 Oct 2026 00:00:00 GMT' })));
  assert.ok(compareSites(before, await auditSite(root)).failures.includes(`RSS item date changed: ${postLink}`));
});

test('refuses a post page that is missing from the feed', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await mkdir(join(root, 'blog/second'));
  await writeFile(join(root, 'blog/second/index.html'), html);
  assert.ok(
    compareSites(before, await auditSite(root)).failures.includes(
      'RSS feed and posts disagree: post is in no feed: blog/second/index.html',
    ),
  );
});

test('refuses a feed item that leads to no page', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  const gone = 'https://footprintjs.github.io/footPrint/blog/gone/';
  await writeFile(join(root, 'blog/rss.xml'), feed(item(), item({ link: gone })));
  assert.ok(
    compareSites(before, await auditSite(root)).failures.includes(
      `RSS feed and posts disagree: blog/rss.xml item leads to no page: ${gone}`,
    ),
  );
});

test('refuses a feed item that leads to a file that is not a page', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  const stylesheet = 'https://footprintjs.github.io/footPrint/_astro/site.a123.css';
  await writeFile(join(root, 'blog/rss.xml'), feed(item(), item({ link: stylesheet })));
  assert.deepEqual(compareSites(before, await auditSite(root)).failures, [
    `RSS feed and posts disagree: blog/rss.xml item leads to no page: ${stylesheet}`,
  ]);
});

test('allows a new feed whose item leads to any generated page, post or not', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'guide'));
  await writeFile(join(root, 'guide/index.html'), plainPage('A page'));
  const before = await auditSite(root);
  await writeFile(
    join(root, 'blog/second.xml'),
    feed(item({ link: 'https://footprintjs.github.io/footPrint/guide/index.html' })),
  );
  assert.deepEqual(compareSites(before, await auditSite(root)).failures, []);
});

test('refuses one-byte growth in a shared asset and every affected page budget', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, '_astro/site.a123.css'), 'p{color:red} ');
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(
    report.budgetGrowth.map((growth) => growth.scope),
    ['entire site', 'blog/index.html'],
  );
  assert.ok(report.failures.includes('JS/CSS no-growth budgets exceeded: 2'));
});

// A page that drops a script app for the shared stylesheet: its own CSS grows, its JavaScript shrinks by more.
const homePage = (css, script) =>
  `<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="/footPrint/_astro/${css}"></head><body><main>Home</main>${
    script ? `<script type="module" src="/footPrint/_astro/${script}"></script>` : ''
  }</body></html>`;

async function homeFixture(t) {
  const root = await fixture(t);
  await writeFile(join(root, 'index.html'), homePage('home.css', 'home.js'));
  await writeFile(join(root, '_astro/home.css'), 'a{}');
  await writeFile(join(root, '_astro/home.js'), 'console.log("a large script application");');
  return root;
}

test('lets one page move bytes from scripts to styles while the site does not grow', async (t) => {
  const root = await homeFixture(t);
  const before = await auditSite(root);
  // The home page now loads the stylesheet every page shares (larger than its own was) and no script.
  await writeFile(join(root, 'index.html'), homePage('site.a123.css'));
  await rm(join(root, '_astro/home.css'));
  await rm(join(root, '_astro/home.js'));
  const after = await auditSite(root);
  assert.ok(after.budgets.perPage['index.html'].css.bytes > before.budgets.perPage['index.html'].css.bytes);
  const report = compareSites(before, after);
  assert.deepEqual(report.budgetGrowth, []);
  assert.deepEqual(report.failures, []);
});

test('refuses a page whose CSS grows by more than its JavaScript shrank', async (t) => {
  const root = await homeFixture(t);
  await writeFile(join(root, '_astro/site.a123.css'), 'p{color:red}' + ' '.repeat(200));
  const before = await auditSite(root);
  // One byte off the script, the whole shared stylesheet on.
  await writeFile(join(root, 'index.html'), homePage('site.a123.css', 'home.js'));
  await writeFile(join(root, '_astro/home.js'), 'console.log("a large script application")');
  await rm(join(root, '_astro/home.css'));
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(
    report.budgetGrowth.map((growth) => [growth.scope, growth.kind]),
    [['index.html', 'css']],
  );
  assert.ok(report.failures.includes('JS/CSS no-growth budgets exceeded: 1'));
});

test('the room is exact: CSS growth equal to the JavaScript shrink passes, one byte more fails', async (t) => {
  const root = await homeFixture(t);
  // A second page keeps the site totals from growing while the home page trades bytes.
  await mkdir(join(root, 'other'));
  await writeFile(
    join(root, 'other/index.html'),
    plainPage('Other').replace('</head>', '<link rel="stylesheet" href="/footPrint/_astro/other.css"></head>'),
  );
  await writeFile(join(root, '_astro/other.css'), 'b{}' + ' '.repeat(100));
  const before = await auditSite(root);
  const script = 'console.log("a large script application");';
  await writeFile(join(root, '_astro/other.css'), 'b{}');

  await writeFile(join(root, '_astro/home.js'), script.slice(10));
  await writeFile(join(root, '_astro/home.css'), 'a{}' + ' '.repeat(10));
  assert.deepEqual(compareSites(before, await auditSite(root)).budgetGrowth, []);

  await writeFile(join(root, '_astro/home.css'), 'a{}' + ' '.repeat(11));
  assert.deepEqual(
    compareSites(before, await auditSite(root)).budgetGrowth.map((growth) => [growth.scope, growth.kind]),
    [['index.html', 'css']],
  );
});

test('refuses JavaScript growth on a page whatever its CSS does, and CSS growth across the site', async (t) => {
  const root = await homeFixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, '_astro/home.css'), '');
  await writeFile(join(root, '_astro/home.js'), 'console.log("a large script application"); ');
  const jsGrew = compareSites(before, await auditSite(root));
  assert.deepEqual(
    jsGrew.budgetGrowth.map((growth) => [growth.scope, growth.kind]),
    [
      ['entire site', 'js'],
      ['index.html', 'js'],
    ],
  );

  // The site as a whole gets no room: a script made smaller does not buy a larger stylesheet.
  await writeFile(join(root, '_astro/home.js'), 'console.log("small");');
  await writeFile(join(root, '_astro/home.css'), 'a{}  ');
  const siteCssGrew = compareSites(before, await auditSite(root));
  assert.deepEqual(
    siteCssGrew.budgetGrowth.map((growth) => [growth.scope, growth.kind]),
    [['entire site', 'css']],
  );
});

test('reports TypeDoc data files without budgeting them, and still budgets TypeDoc code', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'api/assets'), { recursive: true });
  await writeFile(
    join(root, 'api/index.html'),
    plainPage('<script src="assets/search.js"></script><script src="assets/main.js"></script>'),
  );
  await writeFile(join(root, 'api/assets/search.js'), 'data');
  await writeFile(join(root, 'api/assets/main.js'), 'code');
  const before = await auditSite(root);
  await writeFile(join(root, 'api/assets/search.js'), 'more data');
  const dataGrew = compareSites(before, await auditSite(root));
  assert.deepEqual(dataGrew.failures, []);
  assert.equal(dataGrew.budgets.after.apiData['api/assets/search.js'].bytes, 9);
  await writeFile(join(root, 'api/assets/main.js'), 'more code');
  assert.deepEqual(
    compareSites(before, await auditSite(root)).budgetGrowth.map((growth) => growth.scope),
    ['entire site', 'api/index.html'],
  );
});

test('detects resources loaded through generated chunks', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '_astro/lazy.js'), '42');
  await writeFile(join(root, '_astro/app.abc123.js'), 'import("./lazy.js")');
  const before = await auditSite(root);
  await writeFile(join(root, '_astro/lazy.js'), '420');
  const report = compareSites(before, await auditSite(root));
  assert.equal(report.budgetGrowth.find((growth) => growth.scope === 'blog/index.html').kind, 'js');
});
