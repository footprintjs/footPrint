import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlContract } from './html-contract.mjs';
import { auditSite } from './site-audit.mjs';
import { compareSites } from './compare-sites.mjs';

const html = `<!doctype html><html><head><title>A post</title><meta property="og:type" content="article"><meta name="description" content="Summary"><link rel="stylesheet" href="/footPrint/_astro/site.a123.css"></head><body><nav><a href="/footPrint/blog/">Blog</a></nav><main><div class="sl-markdown-content"><div class="sl-blog-metadata astro-abc123"><time datetime="2026-10-11">11 October 2026</time><a href="https://example.org">Author</a></div><p class="authored astro-abc123">Original <strong>post</strong>.</p><a href="#target">Jump</a><h2 id="target">Target</h2><div class="sl-blog-post-footer"><a href="/footPrint/blog/">Back</a></div></div></main><script type="module" src="/footPrint/_astro/app.abc123.js"></script></body></html>`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'docs-site-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'blog'), { recursive: true });
  await mkdir(join(root, '_astro'));
  await writeFile(join(root, 'blog/index.html'), html);
  await writeFile(join(root, '_astro/site.a123.css'), 'p{color:red}');
  await writeFile(join(root, '_astro/app.abc123.js'), 'console.log("ok");');
  await writeFile(
    join(root, 'blog/rss.xml'),
    '<?xml version="1.0"?><rss><channel><item><title>A post</title></item></channel></rss>',
  );
  return root;
}

test('an unchanged build passes, with one post and the exact feed', async (t) => {
  const root = await fixture(t);
  const site = await auditSite(root);
  const report = compareSites(site, site);
  assert.equal(report.passed, true);
  assert.equal(report.postCount, 1);
  assert.equal(report.feeds.before['blog/rss.xml'].items, 1);
});

test('refuses an empty or incomplete baseline instead of comparing two empty outputs', async (t) => {
  const root = await fixture(t);
  const site = await auditSite(root);
  assert.equal(compareSites({ ...site, pages: {} }, { ...site, pages: {} }).passed, false);
  assert.equal(compareSites({ ...site, feeds: {} }, { ...site, feeds: {} }).passed, false);
});

for (const [label, from, to] of [
  ['changed post text', 'Original', 'Altered'],
  ['changed date attribute', 'datetime="2026-10-11"', 'datetime="2026-10-12"'],
  ['changed visible date', '11 October', '12 October'],
  ['changed navigation link', 'href="/footPrint/blog/"', 'href="/footPrint/gone/"'],
  ['changed title', '<title>A post</title>', '<title>Different</title>'],
  ['changed authored class', 'class="authored', 'class="hidden'],
  ['changed post markup', '<strong>post</strong>', '<em>post</em>'],
  ['removed executable script', '<script type="module" src="/footPrint/_astro/app.abc123.js"></script>', ''],
]) {
  test(`refuses ${label}`, async (t) => {
    const root = await fixture(t);
    const before = await auditSite(root);
    await writeFile(join(root, 'blog/index.html'), html.replace(from, to));
    assert.equal(compareSites(before, await auditSite(root)).passed, false);
  });
}

test('refuses even a one-byte RSS change', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(
    join(root, 'blog/rss.xml'),
    '<?xml version="1.0"?><rss><channel><item><title>B post</title></item></channel></rss>',
  );
  assert.ok(compareSites(before, await auditSite(root)).failures.includes('RSS feed bytes or paths changed'));
});

test('refuses a missing page', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await rm(join(root, 'blog/index.html'));
  assert.ok(compareSites(before, await auditSite(root)).failures.includes('Generated HTML path inventory changed'));
});

test('refuses one-byte growth in a shared asset and every affected page budget', async (t) => {
  const root = await fixture(t);
  const before = await auditSite(root);
  await writeFile(join(root, '_astro/site.a123.css'), 'p{color:red} ');
  const report = compareSites(before, await auditSite(root));
  assert.deepEqual(
    report.budgetGrowth.map((item) => item.scope),
    ['entire site', 'blog/index.html'],
  );
});

test('detects resources loaded through generated chunks', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '_astro/lazy.js'), '42');
  await writeFile(join(root, '_astro/app.abc123.js'), 'import("./lazy.js")');
  const before = await auditSite(root);
  await writeFile(join(root, '_astro/lazy.js'), '420');
  const report = compareSites(before, await auditSite(root));
  assert.equal(report.budgetGrowth.find((item) => item.scope === 'blog/index.html').kind, 'js');
});

test('allows only generated hashes without masking dates or authored classes', () => {
  const before = htmlContract(html);
  const after = htmlContract(
    html
      .replaceAll('astro-abc123', 'astro-def456')
      .replaceAll('site.a123.css', 'site.z789.css')
      .replaceAll('app.abc123.js', 'app.def456.js'),
  );
  assert.deepEqual(before.semantics, after.semantics);
  assert.equal(before.postBody, after.postBody);
});

test('metadata wrapper markup may change, but its contents are still checked', () => {
  const before = htmlContract(html);
  const wrapped = htmlContract(
    html
      .replace('<div class="sl-blog-metadata astro-abc123">', '<section class="sl-blog-metadata astro-abc123">')
      .replace('</a></div><p', '</a></section><p'),
  );
  assert.deepEqual(before.semantics, wrapped.semantics);
  assert.equal(before.postBody, wrapped.postBody);
  const altered = htmlContract(html.replace('>Author<', '>Someone else<'));
  assert.notDeepEqual(before.semantics, altered.semantics);
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

test('refuses lost aria-current or data-current sidebar selection', () => {
  const selected = html.replace('<nav><a ', '<nav><a aria-current="page" data-current="true" ');
  const before = htmlContract(selected).semantics;
  for (const attribute of ['aria-current="page" ', 'data-current="true" ']) {
    assert.notDeepEqual(before, htmlContract(selected.replace(attribute, '')).semantics);
  }
});

test('refuses double-prefixed blog links and newly added ordinary-docs pagination', () => {
  const before = htmlContract(html).semantics;
  assert.notDeepEqual(before, htmlContract(html.replace('/footPrint/blog/', '/footPrint/footPrint/blog/')).semantics);
  assert.notDeepEqual(
    before,
    htmlContract(html.replace('</main>', '<a rel="prev" href="/footPrint/blog/">Previous Blog</a></main>')).semantics,
  );
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
