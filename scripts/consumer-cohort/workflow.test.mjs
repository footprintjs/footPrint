import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('same-run artifact route', () => {
  it('uploads under a real name and downloads the exact producer ID, without a self-needs join', () => {
    const workflow = parse(readFileSync('.github/workflows/consumers.yml', 'utf8'));
    const pack = workflow.jobs.pack;
    const consumer = workflow.jobs.consumer;
    const upload = pack.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    const download = consumer.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(upload.with.name).toBe('candidate');
    expect(upload.with['artifact-ids']).toBeUndefined();
    expect(pack.outputs.artifact_id).toBe('${{ steps.candidate.outputs.artifact-id }}');
    expect(consumer.needs).toBe('pack');
    expect(download.with['artifact-ids']).toBe('${{ needs.pack.outputs.artifact_id }}');
    expect(download.with.name).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });
});
