/**
 * render.mjs: the one source to every generated file. Pure text work: it reads the source folder and
 * returns strings, so the same function serves writing, `--check` and the tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const SOURCE_DIR = 'ai-instructions/source';
const BANNER =
  '<!-- Generated from ai-instructions/source by scripts/ai-instructions/generate.mjs. Edit the source, then run npm run ai:generate. -->';

export function readSource(root) {
  const dir = join(root, SOURCE_DIR);
  const json = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const snippetDir = join(dir, 'snippets');
  const snippets = new Map(
    readdirSync(snippetDir)
      .filter((file) => file.endsWith('.mts'))
      .sort()
      .map((file) => [basename(file, '.mts'), readFileSync(join(snippetDir, file), 'utf8').trim()]),
  );
  return {
    text: readFileSync(join(dir, 'instructions.md'), 'utf8'),
    importMap: json('import-map.json'),
    tasks: json('tasks.json'),
    targets: json('targets.json'),
    snippets,
  };
}

const span = (text) => `\`${text}\``;
const row = (cells) => `| ${cells.join(' | ')} |`;

const importMapTable = (rows) =>
  [
    row(['Import', 'What it is for', 'Common names']),
    row(['---', '---', '---']),
    ...rows.map(({ door, job, names }) => row([span(door), job, names.map(span).join(', ')])),
  ].join('\n');

/** The short form for always-on editor rules: which door does what, with the names left to the full guide. */
const doorList = (rows) => rows.map(({ door, job }) => `- ${span(door)}: ${job}`).join('\n');

const taskTable = (rows) =>
  [
    row(['Task', 'Use', 'Read']),
    row(['---', '---', '---']),
    ...rows.map(({ task, use, read }) => row([task, use, read.map(span).join(', ')])),
  ].join('\n');

/** `## Name` to its body. A heading inside a code fence is not a section. */
function sectionsOf(text) {
  const sections = new Map();
  let name;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) {
      name = line.slice(3).trim();
      sections.set(name, []);
    } else if (name) sections.get(name).push(line);
  }
  return new Map([...sections].map(([key, lines]) => [key, lines.join('\n').trim()]));
}

/** Fill one section's placeholders. An unknown placeholder is an error, never literal output. */
function fill(body, source, target) {
  return body.replace(/\{\{([^}]+)\}\}/g, (_, slot) => {
    if (slot === 'import-map') return (target.importMap === 'doors' ? doorList : importMapTable)(source.importMap);
    if (slot === 'tasks') return taskTable(source.tasks);
    if (slot.startsWith('snippet:')) {
      const code = source.snippets.get(slot.slice('snippet:'.length));
      if (code !== undefined) return `\`\`\`typescript\n${code}\n\`\`\``;
    }
    throw new Error(`unknown placeholder {{${slot}}} in ${SOURCE_DIR}/instructions.md`);
  });
}

const frontmatterOf = (fields) =>
  fields
    ? `---\n${Object.entries(fields)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n')}\n---\n\n`
    : '';

function renderTarget(target, sections, source) {
  const body = target.sections.map((name) => {
    if (!sections.has(name)) throw new Error(`${target.output} asks for a section that does not exist: "${name}"`);
    return `## ${name}\n\n${fill(sections.get(name), source, target)}`;
  });
  return `${frontmatterOf(target.frontmatter)}# ${target.heading}\n\n${BANNER}\n\n${body.join('\n\n')}\n`;
}

/** Every target as `{ target, text }`, in the order the source lists them. */
export function renderAll(source) {
  const sections = sectionsOf(source.text);
  return source.targets.map((target) => ({ target, text: renderTarget(target, sections, source) }));
}
