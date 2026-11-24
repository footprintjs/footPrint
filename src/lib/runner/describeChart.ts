import type { FlowChart, SerializedPipelineStructure } from '../builder/types.js';
import type { RunnableFlowChart } from './RunnableChart.js';

/** One declared subflow placement, with a chart-local path suitable for a documentation index. */
export interface ChartMount {
  readonly subflowId: string;
  readonly subflowName: string;
  /** Slash-separated mount IDs from the chart being described. */
  readonly subflowPath: string;
  readonly isLazy: boolean;
  /** Entry stage of an eagerly mounted chart, when its structure is present. */
  readonly entryStageId?: string;
  /** Description declared on the mount or its eager entry stage. */
  readonly description?: string;
}

function* walkStages(root: SerializedPipelineStructure): Generator<SerializedPipelineStructure> {
  const pending = [root];
  const seen = new Set<SerializedPipelineStructure>();
  for (let stage = pending.pop(); stage !== undefined; stage = pending.pop()) {
    if (stage.isLoopReference || stage.type === 'loop' || seen.has(stage)) continue;
    seen.add(stage);
    yield stage;
    if (stage.next) pending.push(stage.next);
    const children = stage.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
}

function mountOf(stage: SerializedPipelineStructure, parentPath: string): ChartMount | undefined {
  if (!stage.isSubflowRoot) return undefined;
  const subflowId = stage.subflowId ?? stage.id;
  const child = stage.isLazy ? undefined : stage.subflowStructure;
  const description = stage.description ?? child?.description;
  return {
    subflowId,
    subflowName: stage.subflowName ?? stage.name,
    subflowPath: parentPath === '' ? subflowId : `${parentPath}/${subflowId}`,
    isLazy: stage.isLazy === true,
    ...(child && { entryStageId: child.id }),
    ...(description && { description }),
  };
}

/**
 * List mount placements in graph order, descending into each eager mount.
 * Lazy mounts appear without resolving them. Runtime fan-out creates its branches during a run.
 */
export function listMounts(chart: Pick<FlowChart, 'buildTimeStructure'>): readonly ChartMount[] {
  const root = chart.buildTimeStructure;
  const mounts: ChartMount[] = [];
  const active = new Set([root]);
  const stack = [{ root, path: '', stages: walkStages(root) }];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const next = current.stages.next();
    if (next.done) {
      active.delete(current.root);
      stack.pop();
      continue;
    }
    const mount = mountOf(next.value, current.path);
    if (!mount) continue;
    mounts.push(mount);
    const child = next.value.subflowStructure;
    // The same definition may appear at several paths. Only an ancestor is a cycle.
    if (mount.isLazy || !child || active.has(child)) continue;
    active.add(child);
    stack.push({ root: child, path: mount.subflowPath, stages: walkStages(child) });
  }
  return mounts;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/gu, ' ').trim();
}

function markdownText(text: string): string {
  return oneLine(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]#!|~]/g, '\\$&');
}

function backticks(text: string, minimum: number): string {
  let length = minimum;
  for (const [run] of text.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  return '`'.repeat(length);
}

function code(text: string): string {
  const line =
    text === oneLine(text)
      ? text
      : JSON.stringify(text)
          .replace(/\u2028/gu, '\\u2028')
          .replace(/\u2029/gu, '\\u2029');
  const delimiter = backticks(line, 1);
  const pad = line.startsWith('`') || line.endsWith('`') ? ' ' : '';
  return `${delimiter}${pad}${line}${pad}${delimiter}`;
}

function stageKind(stage: SerializedPipelineStructure): string {
  if (stage.isDynamicParallel) return 'parallelForEach';
  if (stage.hasDecider || stage.type === 'decider') return 'decision';
  if (stage.hasSelector || stage.type === 'selector') return 'selector';
  return stage.type ?? 'stage';
}

function stageLine(stage: SerializedPipelineStructure, mount?: ChartMount): string {
  const entry = mount?.entryStageId === undefined ? '' : `, entry ${code(mount.entryStageId)}`;
  const kind = mount ? (mount.isLazy ? 'lazy' : 'eager') : stageKind(stage);
  const id = mount?.subflowPath ?? stage.id;
  const label = `**${markdownText(mount?.subflowName ?? stage.name)}** (${code(id)}, ${kind}${entry})`;
  const description = markdownText(mount?.description ?? stage.description ?? '');
  const parts = [`- ${label} — ${description || 'No description.'}`];
  if (stage.tags?.length) parts.push(`Tags ${stage.tags.map(code).join(', ')}.`);
  if (stage.outsideInputs?.length) parts.push(`Outside inputs ${stage.outsideInputs.map(code).join(', ')}.`);
  if (stage.retryAttempts !== undefined) {
    parts.push(`Retry policy allows ${stage.retryAttempts} total attempt${stage.retryAttempts === 1 ? '' : 's'}.`);
  }
  if (stage.timeoutMs !== undefined) parts.push(`Timeout ${stage.timeoutMs} ms per attempt.`);
  return parts.join(' ');
}

/**
 * Generate a Markdown README for one built chart. The drawing uses the chart's
 * default Mermaid export. Stage and loop details describe this chart, with eager
 * child charts represented by their mounts. No stage or lazy resolver is called.
 */
export function describeChart(
  chart: Pick<RunnableFlowChart, 'buildTimeStructure' | 'description' | 'toMermaid'>,
): string {
  const root = chart.buildTimeStructure;
  const drawing = chart.toMermaid();
  const fence = backticks(drawing, 3);
  const lines = [`# ${markdownText(root.name)}`];
  // The builder's numbered step prose repeats these stage, mount and loop sections.
  const customDescription = chart.description.startsWith(`FlowChart: ${root.name}\nSteps:\n`)
    ? ''
    : markdownText(chart.description);
  if (customDescription) lines.push('', customDescription);
  lines.push('', `${fence}mermaid`, drawing, fence, '', '## Stages', '');

  const mounts: string[] = [];
  const loops: string[] = [];
  for (const stage of walkStages(root)) {
    const mount = mountOf(stage, '');
    (mount ? mounts : lines).push(stageLine(stage, mount));
    if (stage.loopTarget !== undefined) loops.push(`- ${code(stage.id)} → ${code(stage.loopTarget)}`);
  }
  if (mounts.length > 0) lines.push('', '## Subflow mounts', '', ...mounts);
  if (loops.length > 0) lines.push('', '## Loops', '', ...loops);
  return `${lines.join('\n')}\n`;
}
