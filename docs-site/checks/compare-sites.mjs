import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { auditSite } from './site-audit.mjs';

export function compareSites(before, after) {
  const failures = [];
  if (!Object.keys(before.pages).length || !Object.keys(before.feeds).length) {
    failures.push('Baseline must contain generated HTML and an RSS feed');
  }
  const equal = (label, a, b) => {
    if (!isDeepStrictEqual(a, b)) failures.push(label);
  };
  equal('Generated HTML path inventory changed', Object.keys(before.pages).sort(), Object.keys(after.pages).sort());
  for (const [path, page] of Object.entries(before.pages)) {
    if (!after.pages[path]) continue;
    equal(`Visible text, navigation or head metadata changed: ${path}`, page.semantics, after.pages[path].semantics);
    equal(`Rendered post HTML changed: ${path}`, page.postBody, after.pages[path].postBody);
  }
  equal('RSS feed bytes or paths changed', before.feeds, after.feeds);
  const existing = new Set(before.brokenLinks.map((link) => JSON.stringify(link)));
  const newBrokenLinks = after.brokenLinks.filter((link) => !existing.has(JSON.stringify(link)));
  if (newBrokenLinks.length) failures.push(`New broken local links: ${newBrokenLinks.length}`);
  const budgetGrowth = [];
  for (const [scope, oldBudget, newBudget] of [
    ['entire site', before.budgets.totals, after.budgets.totals],
    ...Object.entries(before.budgets.perPage).map(([path, budget]) => [path, budget, after.budgets.perPage[path]]),
  ]) {
    if (!newBudget) continue;
    for (const kind of ['js', 'css']) {
      // Raw bytes are deterministic. Gzip figures are reported, not used as a
      // zero-byte threshold: content hashes alone change their compression.
      if (newBudget[kind].bytes > oldBudget[kind].bytes)
        budgetGrowth.push({ scope, kind, before: oldBudget[kind].bytes, after: newBudget[kind].bytes });
    }
  }
  if (budgetGrowth.length) failures.push(`JS/CSS no-growth budgets exceeded: ${budgetGrowth.length}`);
  return {
    passed: failures.length === 0,
    failures,
    pageCount: { before: Object.keys(before.pages).length, after: Object.keys(after.pages).length },
    postCount: Object.values(before.pages).filter((page) => page.postBody !== undefined).length,
    renderedPosts: Object.fromEntries(
      Object.entries(before.pages)
        .filter(([, page]) => page.postBody !== undefined)
        .map(([path, page]) => {
          const candidate = after.pages[path];
          const hash = (source) => (source === undefined ? null : createHash('sha256').update(source).digest('hex'));
          return [
            path,
            {
              beforeSha256: hash(page.postBodySource),
              afterSha256: hash(candidate?.postBodySource),
              beforeNormalizedSha256: hash(page.postBody),
              afterNormalizedSha256: hash(candidate?.postBody),
              normalizationRequired: page.postBodySource !== candidate?.postBodySource,
            },
          ];
        }),
    ),
    feeds: { before: before.feeds, after: after.feeds },
    normalization: [
      'Generated /_astro/ JS/CSS filename hashes',
      'Astro scoped class/attribute hashes',
      'Post metadata/footer excluded from the body comparison, but included in whole-page text/navigation/metadata checks',
    ],
    linkCheck: { inherited: before.brokenLinks, remaining: after.brokenLinks, introduced: newBrokenLinks },
    budgetGrowth,
    budgets: { before: before.budgets, after: after.budgets },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output] = process.argv.slice(2);
  if (!baseline || !candidate)
    throw new Error('Usage: node checks/compare-sites.mjs BASELINE_DIST CANDIDATE_DIST [REPORT_JSON]');
  const report = compareSites(await auditSite(baseline), await auditSite(candidate));
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
