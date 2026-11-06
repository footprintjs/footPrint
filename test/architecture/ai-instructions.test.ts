/**
 * The AI instruction files come from one source, and `--check` goes red when they stop matching it or the code.
 *
 *   contract  the repository's own files pass; the rendered text is deterministic
 *   red       every problem code fires, on a copy of the files with one thing broken
 *   install   setup.sh puts each generated file where targets.json says
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const CLI = join(REPO, 'scripts/ai-instructions/generate.mjs');
const SOURCE = 'ai-instructions/source';

interface Problem {
  code: string;
  file: string;
  message: string;
}
interface Target {
  output: string;
  installsTo: string;
  maxBytes: number;
}
interface Rendered {
  target: Target;
  text: string;
}
interface Source {
  text: string;
  importMap: { door: string; job: string; names: string[] }[];
  tasks: { task: string; use: string; read: string[] }[];
  targets: Target[];
  snippets: Map<string, string>;
}
interface CodeFacts {
  doors: Map<string, Set<string>>;
  known: Set<string>;
}

let render: { readSource(root: string): Source; renderAll(source: Source): Rendered[] };
let facts: { readCodeFacts(root: string): CodeFacts; apiNamesIn(span: string): string[] };
let check: {
  findProblems(root: string, source: Source, rendered: Rendered[], code: CodeFacts): Problem[];
  writeAll(rendered: Rendered[], root: string): void;
};
let code: CodeFacts;

beforeAll(async () => {
  render = await import(join(REPO, 'scripts/ai-instructions/render.mjs'));
  facts = await import(join(REPO, 'scripts/ai-instructions/facts.mjs'));
  check = await import(CLI);
  code = facts.readCodeFacts(REPO);
}, 60_000);

const copies: string[] = [];
afterEach(() => {
  while (copies.length) rmSync(copies.pop() as string, { recursive: true, force: true });
});

/** A private copy of the instruction files. Everything a task may point at is linked, so paths still resolve. */
function copyOfFiles(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-instructions-'));
  copies.push(root);
  cpSync(join(REPO, 'ai-instructions'), join(root, 'ai-instructions'), { recursive: true });
  cpSync(join(REPO, 'AGENTS.md'), join(root, 'AGENTS.md'));
  for (const linked of ['docs', 'examples', 'src', 'node_modules']) symlinkSync(join(REPO, linked), join(root, linked));
  return root;
}

const problemsAt = (root: string): Problem[] => {
  const source = render.readSource(root);
  return check.findProblems(root, source, render.renderAll(source), code);
};
const codesAt = (root: string) => [...new Set(problemsAt(root).map((p) => p.code))];

function editJson<T>(root: string, file: string, edit: (value: T) => void): void {
  const path = join(root, SOURCE, file);
  const value = JSON.parse(readFileSync(path, 'utf8')) as T;
  edit(value);
  writeFileSync(path, JSON.stringify(value));
}
/** Change the source, then bring the generated files back in step, so only the wanted problem remains. */
function regenerate(root: string): void {
  check.writeAll(render.renderAll(render.readSource(root)), root);
}
const runCheck = (root: string) => spawnSync(process.execPath, [CLI, '--check', '--root', root], { encoding: 'utf8' });

describe('the repository', () => {
  it('passes its own check', () => {
    expect(problemsAt(REPO)).toEqual([]);
  });

  it('renders the same text twice', () => {
    const first = render.renderAll(render.readSource(REPO));
    const second = render.renderAll(render.readSource(REPO));
    expect(second.map((r) => r.text)).toEqual(first.map((r) => r.text));
  });

  it('leads with the pitch, keeps the advanced door visible and marks it as internals', () => {
    const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8');
    expect(agents.split('\n')[0]).toBe('# FootPrint: connected runtime logs for people and AI agents');
    expect(agents).toMatch(/\| `footprintjs\/advanced` \| Engine internals\./);
  });

  it('has a row for every door the code has, foottrace included', () => {
    const rows = render.readSource(REPO).importMap.map((row) => row.door);
    expect([...code.doors.keys()].sort()).toEqual([...rows].sort());
    expect(rows).toEqual(expect.arrayContaining(['footprintjs/sinks', 'foottrace/cause', 'foottrace/prov']));
  });

  it('runs the check advisory in CI, beside the documentation snippets', () => {
    const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(
      /check:doc-snippets\n[\s\S]{0,300}continue-on-error: true\n\s+run: npm run check:ai-instructions/,
    );
  });
});

describe('--check goes red', () => {
  it('exits 0 on a faithful copy', () => {
    const result = runCheck(copyOfFiles());
    expect(result.stdout).toContain('check:ai-instructions: OK');
    expect(result.status).toBe(0);
  });

  it('exits 1 and names the file when a generated file is edited by hand', () => {
    const root = copyOfFiles();
    writeFileSync(join(root, 'AGENTS.md'), `${readFileSync(join(root, 'AGENTS.md'), 'utf8')}\nA hand edit.\n`);
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md drift');
  });

  it('exits 1 when a generated file is missing', () => {
    const root = copyOfFiles();
    rmSync(join(root, 'ai-instructions/clinerules'));
    expect(runCheck(root).status).toBe(1);
    expect(problemsAt(root)).toEqual([expect.objectContaining({ code: 'drift', file: 'ai-instructions/clinerules' })]);
  });

  it('exits 1 when the source changes and nothing is regenerated', () => {
    const root = copyOfFiles();
    const path = join(root, SOURCE, 'instructions.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('The one law', 'The only law'));
    const drifted = problemsAt(root).filter((p) => p.code === 'drift');
    expect(drifted.length).toBe(render.readSource(root).targets.length);
    expect(runCheck(root).status).toBe(1);
  });

  it('exits 1 on a source that cannot render', () => {
    const root = copyOfFiles();
    const path = join(root, SOURCE, 'instructions.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n{{snippet:gone}}\n`);
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown placeholder {{snippet:gone}}');
  });

  it('reports a file nothing generates', () => {
    const root = copyOfFiles();
    writeFileSync(join(root, 'ai-instructions/cursor/footprint.md'), 'a hand-kept copy\n');
    expect(problemsAt(root)).toEqual([
      expect.objectContaining({ code: 'stray-file', file: 'ai-instructions/cursor/footprint.md' }),
    ]);
  });

  it('reports a door with no row', () => {
    const root = copyOfFiles();
    editJson<Source['importMap']>(root, 'import-map.json', (rows) => {
      rows.splice(
        rows.findIndex((row) => row.door === 'footprintjs/sinks'),
        1,
      );
    });
    regenerate(root);
    expect(codesAt(root)).toEqual(['door-missing']);
  });

  it('reports a row for a door that does not exist', () => {
    const root = copyOfFiles();
    editJson<Source['importMap']>(root, 'import-map.json', (rows) => {
      rows.push({ door: 'footprintjs/write', job: 'Gone.', names: [] });
    });
    regenerate(root);
    expect(codesAt(root)).toEqual(['door-unknown']);
  });

  it('reports a name its door does not export, even when another door does', () => {
    const root = copyOfFiles();
    editJson<Source['importMap']>(root, 'import-map.json', (rows) => {
      rows[0].names.push('fileSink');
    });
    regenerate(root);
    expect(problemsAt(root)).toEqual([
      expect.objectContaining({
        code: 'name-missing',
        message: expect.stringContaining('footprintjs does not export fileSink'),
      }),
    ]);
  });

  it('reports a task whose page is gone, and one whose heading is gone', () => {
    const root = copyOfFiles();
    editJson<Source['tasks']>(root, 'tasks.json', (rows) => {
      rows[0].read = ['docs/guides/no-such-page.md'];
    });
    regenerate(root);
    expect(codesAt(root)).toEqual(['path-missing']);

    editJson<Source['tasks']>(root, 'tasks.json', (rows) => {
      rows[0].read = ['docs/guides/patterns.md#no-such-heading'];
    });
    regenerate(root);
    expect(codesAt(root)).toEqual(['anchor-missing']);
  });

  it('reports an API in prose that no door declares, and a line citation', () => {
    const root = copyOfFiles();
    const path = join(root, SOURCE, 'instructions.md');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      text.replace('The one law:', 'Use `DeciderBuilder` and `.retryForever()`, see src/index.ts:12. The one law:'),
    );
    regenerate(root);
    const problems = problemsAt(root);
    expect(problems.map((p) => p.code)).toEqual(expect.arrayContaining(['name-unknown', 'line-citation']));
    expect(problems.filter((p) => p.code === 'name-unknown').map((p) => p.message)).toEqual([
      expect.stringContaining('DeciderBuilder'),
      expect.stringContaining('retryForever'),
    ]);
  });

  it('reports a file over its budget', () => {
    const root = copyOfFiles();
    editJson<Target[]>(root, 'targets.json', (targets) => {
      targets[0].maxBytes = 100;
    });
    regenerate(root);
    expect(problemsAt(root)).toEqual([expect.objectContaining({ code: 'over-budget', file: 'AGENTS.md' })]);
  });
});

describe('names a span claims', () => {
  it.each([
    ['.retry()', ['retry']],
    ['scope.$call()', ['$call']],
    ['flowChart<T>()', ['flowChart']],
    ["run({ delivery: 'deferred' })", ['run']],
    ['$break', ['$break']],
    ['onAttempt', ['onAttempt']],
    ['StageSnapshot.attention', ['StageSnapshot', 'attention']],
    ['RLENarrativeFlowRecorder', ['RLENarrativeFlowRecorder']],
  ])('%s', (span, names) => {
    expect(facts.apiNamesIn(span)).toEqual(names);
  });

  it.each(['CLAUDE.md', 'scope.amount', 'runs/<childId>/', 'foottrace/write', 'HONESTY_CODES', "'clone'"])(
    'leaves %s alone',
    (span) => {
      expect(facts.apiNamesIn(span)).toEqual([]);
    },
  );
});

describe('setup.sh', () => {
  const install = (project: string) =>
    execFileSync('bash', [join(REPO, 'ai-instructions/setup.sh')], { cwd: project, input: 'a\n', encoding: 'utf8' });
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-instructions-project-'));
    copies.push(dir);
    return dir;
  };

  it('installs each generated file exactly where targets.json says', () => {
    const dir = project();
    install(dir);
    for (const { target, text } of render.renderAll(render.readSource(REPO))) {
      expect(readFileSync(join(dir, target.installsTo), 'utf8')).toBe(text);
    }
  });

  it('adds to an older single-file .clinerules instead of replacing it', () => {
    const dir = project();
    writeFileSync(join(dir, '.clinerules'), 'my own rule\n');
    install(dir);
    const text = readFileSync(join(dir, '.clinerules'), 'utf8');
    expect(text.startsWith('my own rule\n')).toBe(true);
    expect(text).toContain('# FootPrint: Cline rules');
  });
});
