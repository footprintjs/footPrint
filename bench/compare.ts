/**
 * fp-bench compare — diff two `fp-bench/1` result files, highlight regressions.
 *
 * Usage:
 *   npm run bench:compare                       # baseline.json vs latest.json
 *   npx tsx bench/compare.ts a.json b.json      # explicit files
 *   npm run bench:compare -- --threshold 10     # tighter relative gate (%)
 *
 * Workflow: `npm run bench` (+ `bench:heap`) writes the machine mirror to
 * bench/results/latest.json; this script diffs it against the committed
 * reference bench/results/baseline.json. A row REGRESSES (▲ red) when its
 * delta exceeds BOTH the relative threshold (default 25%) AND the unit's
 * absolute noise floor (0.5ms / 1MiB / 0.25 count — µs rows jitter by
 * integer factors, see compareCore). Improvements print ▼ green. Any
 * regression → exit 1, so CI can gate on it. Update the reference by
 * copying a reviewed latest.json over baseline.json in the perf PR.
 */

import { type RowComparison, assertResultFile, compareResults, DEFAULT_THRESHOLD_PCT } from './compareCore';
import { type ResultFile, BASELINE_RESULTS_PATH, formatBytes, formatMs, LATEST_RESULTS_PATH } from './util';

// ─── ANSI (honors NO_COLOR) ───

const useColor = process.env.NO_COLOR === undefined;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = (t: string) => paint('31', t);
const green = (t: string) => paint('32', t);
const dim = (t: string) => paint('2', t);

// ─── Args ───

function parseArgs(argv: string[]): { baselinePath: string; latestPath: string; thresholdPct: number } {
  const positional: string[] = [];
  let thresholdPct = DEFAULT_THRESHOLD_PCT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold') {
      const raw = argv[++i];
      thresholdPct = Number(raw);
      if (!Number.isFinite(thresholdPct) || thresholdPct < 0) {
        throw new Error(`--threshold expects a non-negative number, got '${raw}'`);
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return {
    baselinePath: positional[0] ?? BASELINE_RESULTS_PATH,
    latestPath: positional[1] ?? LATEST_RESULTS_PATH,
    thresholdPct,
  };
}

// ─── Rendering ───

function formatValue(value: number, unit: string): string {
  if (unit === 'bytes') return formatBytes(value);
  if (unit === 'ms') return formatMs(value);
  return value.toFixed(2);
}

function formatRow(c: RowComparison): string {
  const label = `${c.section} / ${c.name}`.padEnd(58);
  if (c.verdict === 'added') return `${label} ${dim(`(new row) → ${formatValue(c.latest!, c.unit)}`)}`;
  if (c.verdict === 'removed') return `${label} ${dim(`${formatValue(c.baseline!, c.unit)} → (row removed)`)}`;

  const values = `${formatValue(c.baseline!, c.unit)} → ${formatValue(c.latest!, c.unit)}`.padEnd(24);
  const pct =
    c.deltaPct === undefined
      ? `Δ ${formatValue(c.latest! - c.baseline!, c.unit)}` // zero/negative baseline — absolute delta
      : `${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct.toFixed(1)}%`;

  if (c.verdict === 'regression') return `${label} ${values} ${red(`▲ ${pct}`)}`;
  if (c.verdict === 'improvement') return `${label} ${values} ${green(`▼ ${pct}`)}`;
  return `${label} ${values} ${dim(`· ${pct}`)}`;
}

function fileStamp(f: ResultFile): string {
  return `${f.date.split('T')[0]} @ ${f.commit}, ${f.node}, ${f.platform}`;
}

// ─── Main ───

function main() {
  const { baselinePath, latestPath, thresholdPct } = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as { readFileSync(p: string, enc: string): string; existsSync(p: string): boolean };
  for (const [label, p] of [
    ['baseline', baselinePath],
    ['latest', latestPath],
  ] as const) {
    if (!fs.existsSync(p)) {
      throw new Error(`${label} results not found: ${p}\nRun \`npm run bench\` (and \`npm run bench:heap\`) first.`);
    }
  }
  const baseline = assertResultFile(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), baselinePath);
  const latest = assertResultFile(JSON.parse(fs.readFileSync(latestPath, 'utf8')), latestPath);

  console.log('# fp-bench compare\n');
  console.log(`baseline: ${baselinePath} ${dim(`(${fileStamp(baseline)})`)}`);
  console.log(`latest:   ${latestPath} ${dim(`(${fileStamp(latest)})`)}`);
  console.log(`gates:    >${thresholdPct}% relative AND above per-unit noise floor (0.5ms / 1MiB / 0.25)\n`);

  const report = compareResults(baseline, latest, { thresholdPct });

  let lastSection = '';
  for (const row of report.rows) {
    if (row.section !== lastSection) {
      if (lastSection !== '') console.log('');
      lastSection = row.section;
    }
    console.log(formatRow(row));
  }

  const summary =
    `\n${report.regressions} regression(s), ${report.improvements} improvement(s), ` +
    `${report.unchanged} unchanged, ${report.added} added, ${report.removed} removed`;
  if (report.regressions > 0) {
    console.log(red(summary));
    process.exitCode = 1;
  } else {
    console.log(green(summary));
  }
}

try {
  main();
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
}
