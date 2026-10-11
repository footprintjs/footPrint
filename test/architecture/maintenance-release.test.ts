import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { maintenanceChannel } from '../../scripts/maintenance-release.mjs';

describe('9.x maintenance publishing', () => {
  it('selects only the legacy channel for a matching stable maintenance version', () => {
    expect(maintenanceChannel({ name: 'footprintjs', version: '9.48.4' }, 'v9.48.4')).toBe('legacy-9');
    expect(maintenanceChannel({ name: 'footprintjs', version: '9.49.0' }, 'v9.49.0')).toBe('legacy-9');
  });

  it.each(['10.0.0', '8.99.0', '9.48.4-rc.1', '9.48.4+build', '9.048.4', '9.48.04', '', 'latest'])(
    'refuses non-maintenance or noncanonical version %s',
    (version) => {
      expect(() => maintenanceChannel({ name: 'footprintjs', version }, `v${version}`)).toThrow();
    },
  );

  it.each(['v9.48.3', '9.48.4', 'refs/tags/v9.48.4', undefined])('refuses tag mismatch %s', (tag) => {
    expect(() => maintenanceChannel({ name: 'footprintjs', version: '9.48.4' }, tag)).toThrow();
  });

  it('refuses another package and missing metadata', () => {
    expect(() => maintenanceChannel({ name: 'foottrace', version: '9.48.4' }, 'v9.48.4')).toThrow();
    expect(() => maintenanceChannel(undefined, 'v9.48.4')).toThrow();
  });

  it('wires the validated channel into the only npm publish command', () => {
    const workflow = readFileSync(resolve(__dirname, '../../.github/workflows/publish.yml'), 'utf8');
    const expression = (body: string) => '$' + '{{ ' + body + ' }}';
    expect(workflow).toContain(`dist-tag: ${expression('steps.channel.outputs.dist_tag')}`);
    expect(workflow).toContain(`RELEASE_TAG: ${expression('github.event.release.tag_name')}`);
    expect(workflow).toContain('node scripts/maintenance-release.mjs >> "$GITHUB_OUTPUT"');
    const publishes = workflow.split('\n').filter((line) => /^\s*run: npm publish /.test(line));
    expect(publishes).toEqual([
      `        run: npm publish ./package.tgz --provenance --access public --tag "${expression(
        'needs.build.outputs.dist-tag',
      )}"`,
    ]);
  });
});
