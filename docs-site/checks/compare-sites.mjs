import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditSite } from './site-audit.mjs';

const added = (from, to) => to.filter((item) => !from.includes(item));
const hasContent = (site) => site.pages.length > 0 && Object.keys(site.feeds).length > 0;

// A feed reader knows a post by its guid and date. Changing either re-delivers or
// reorders an old post, so they stay fixed while the post's text is free to change.
function feedFailures(before, after) {
  const failures = [];
  for (const [path, feed] of Object.entries(after.feeds)) {
    if (!feed.items.length) failures.push(`RSS feed has no items: ${path}`);
  }
  for (const [path, feed] of Object.entries(before.feeds)) {
    const current = after.feeds[path];
    if (!current) {
      failures.push(`RSS feed path removed: ${path}`);
      continue;
    }
    const dates = new Map(current.items.map((item) => [item.guid, item.pubDate]));
    for (const item of feed.items) {
      if (dates.has(item.guid) && dates.get(item.guid) !== item.pubDate)
        failures.push(`RSS item date changed: ${item.guid}`);
    }
  }
  for (const problem of after.feedProblems) failures.push(`RSS feed and posts disagree: ${problem}`);
  return failures;
}

export function compareSites(before, after) {
  const failures = [];
  if (!hasContent(before)) failures.push('Baseline must contain generated HTML and an RSS feed');
  if (!hasContent(after)) failures.push('Candidate must contain generated HTML and an RSS feed');
  failures.push(...feedFailures(before, after));
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
    // Reported for the reviewer, never a failure. Content work adds and removes pages.
    pages: {
      before: before.pages.length,
      after: after.pages.length,
      added: added(before.pages, after.pages),
      removed: added(after.pages, before.pages),
    },
    posts: { before: before.posts.length, after: after.posts.length },
    feeds: { before: before.feeds, after: after.feeds },
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
