import type { Workflow } from './workflowRules';

/**
 * The CLASS "this step publishes", found by what the step says, not by one exact text.
 *
 * WHY a class: a rule that finds the publication by one exact string (`run.sh" publish`) cannot see
 * a second publishing command added by a later edit, so the hold step could end up AFTER a publish
 * it was meant to guard. Examples that must all count: `env npm publish tarball.tgz`,
 * `npx --yes some-tool publish`, `pnpm publish`, `yarn npm publish`, and the route's own
 * `bash "$TRUSTED_SOURCE/scripts/publish-release/run.sh" publish` placed inside a multi-line block.
 *
 * It is a text rule, not a shell parser: it reads each `run:` block with line continuations joined
 * and comment lines dropped, and looks for a package-manager command followed by the word `publish`
 * within the same command (no `;`, `&`, `|` or newline between them), at any position and under any
 * prefix (`env`, `sudo`, `time`, a path). A step that hides the word (`npm "$VERB"`) is not seen:
 * the other publish rules (the absolute helper, no floating npm/npx in the publish job) still apply.
 * A step that `uses:` an action whose name says `publish` counts too.
 */

const PACKAGE_MANAGER_PUBLISH = /(?:^|[\s"'(`=/])(?:npm|npx|pnpm|yarn)(?:\.cmd)?\b[^\n;&|]*?\bpublish\b/;
const ROUTE_PUBLISH = /\brun\.sh["']?\s+publish\b/;

/** True when a `run:` block (or a `uses:` name) contains publishing text. */
export function publishes(step: { run?: string; uses?: string }): boolean {
  if (typeof step.uses === 'string' && /publish/i.test(step.uses.split('@')[0])) return true;
  if (typeof step.run !== 'string') return false;
  const text = step.run
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  return PACKAGE_MANAGER_PUBLISH.test(text) || ROUTE_PUBLISH.test(text);
}

export interface PublishingStep {
  job: string;
  index: number;
}

/** Every step of every job of the workflow that publishes. A job that calls a workflow has no steps. */
export function publishingSteps(workflow: Workflow): PublishingStep[] {
  const found: PublishingStep[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs)) {
    const steps = (definition as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, index) => {
      if (step && typeof step === 'object' && publishes(step as { run?: string; uses?: string }))
        found.push({ job, index });
    });
  }
  return found;
}
