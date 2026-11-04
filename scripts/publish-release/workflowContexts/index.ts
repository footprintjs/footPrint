type PathPart = string | number;
interface Policy {
  path: readonly string[];
  contexts: ReadonlySet<string>;
  implicit?: boolean;
}

const WORKFLOW = ['github', 'inputs', 'vars'];
const JOB_IF = ['github', 'needs', 'vars', 'inputs'];
const JOB = ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'];
const JOB_ENV = [...JOB, 'secrets'];
const NORMAL = [...JOB, 'job', 'runner', 'env', 'secrets', 'steps'];
const policy = (path: string, contexts: readonly string[], implicit = false): Policy => ({
  path: path.split('.'),
  contexts: new Set(contexts),
  implicit,
});

// More-specific positions precede their enclosing map. The table is the policy,
// from GitHub's context-availability reference; expression syntax is separate.
const POLICIES: readonly Policy[] = [
  policy('on.workflow_call.outputs.*.value.**', ['github', 'jobs', 'vars', 'inputs']),
  policy('on.workflow_call.inputs.*.default.**', WORKFLOW),
  policy(
    'jobs.*.steps.*.if',
    NORMAL.filter((context) => context !== 'secrets'),
    true,
  ),
  ...['env', 'name', 'run', 'with', 'working-directory', 'timeout-minutes', 'continue-on-error'].map((field) =>
    policy(`jobs.*.steps.*.${field}.**`, NORMAL),
  ),
  policy('jobs.*.outputs.**', NORMAL),
  policy(
    'jobs.*.environment.url.**',
    NORMAL.filter((context) => context !== 'secrets'),
  ),
  policy('jobs.*.container.credentials.**', [...JOB, 'env', 'secrets']),
  policy('jobs.*.services.*.credentials.**', [...JOB, 'env', 'secrets']),
  policy(
    'jobs.*.container.env.**',
    NORMAL.filter((context) => context !== 'steps'),
  ),
  policy(
    'jobs.*.services.*.env.**',
    NORMAL.filter((context) => context !== 'steps'),
  ),
  policy('jobs.*.defaults.run.**', [...JOB, 'env']),
  policy('jobs.*.env.**', JOB_ENV),
  policy('jobs.*.if', JOB_IF, true),
  policy('jobs.*.strategy.**', JOB_IF),
  policy('jobs.*.with.**', JOB),
  policy('jobs.*.secrets.**', JOB_ENV),
  ...['name', 'runs-on', 'timeout-minutes', 'continue-on-error', 'container', 'environment', 'concurrency'].map(
    (field) => policy(`jobs.*.${field}.**`, JOB),
  ),
  policy('jobs.*.services.*.**', JOB),
  policy('env.**', [...WORKFLOW, 'secrets']),
  policy('run-name.**', WORKFLOW),
  policy('concurrency.**', WORKFLOW),
  policy('defaults.run.**', []),
];

function matches(pattern: readonly string[], path: readonly PathPart[]): boolean {
  for (let index = 0; index < pattern.length; index++) {
    const part = pattern[index];
    if (part === '**') return true;
    if (index >= path.length || (part !== '*' && part !== String(path[index]))) return false;
  }
  return pattern.length === path.length;
}

/** Skip expression strings, including GitHub's doubled-single-quote escape. */
function afterString(text: string, start: number): number {
  const quote = text[start];
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === quote) {
      if (quote === "'" && text[at + 1] === "'") at += 2;
      else return at + 1;
    } else if (quote === '"' && text[at] === '\\') at += 2;
    else at++;
  }
  return at;
}

function expressions(text: string, implicit: boolean): string[] {
  const result: string[] = [];
  let after = 0;
  let start = text.indexOf('${{', after);
  if (start < 0) return implicit ? [text] : result;
  while (start >= 0) {
    let at = start + 3;
    while (at < text.length) {
      if (text[at] === "'" || text[at] === '"') at = afterString(text, at);
      else if (text[at] === '}' && text[at + 1] === '}') break;
      else at++;
    }
    // A malformed/unclosed expression belongs to actionlint's grammar check.
    if (at >= text.length) break;
    result.push(text.slice(start + 3, at));
    after = at + 2;
    start = text.indexOf('${{', after);
  }
  return result;
}

interface Token {
  value: string;
  identifier: boolean;
}
function contextRoots(expression: string): string[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < expression.length) {
    const character = expression[at];
    if (/\s/.test(character)) {
      at++;
      continue;
    }
    if (character === "'" || character === '"') {
      at = afterString(expression, at);
      tokens.push({ value: 'literal', identifier: false });
      continue;
    }
    const number = /^(?:-?(?:0[xX][0-9a-fA-F]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?))/.exec(
      expression.slice(at),
    );
    if (number) {
      tokens.push({ value: 'literal', identifier: false });
      at += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(expression.slice(at));
    if (identifier) {
      tokens.push({ value: identifier[0], identifier: true });
      at += identifier[0].length;
    } else {
      tokens.push({ value: character, identifier: false });
      at++;
    }
  }
  return [
    ...new Set(
      tokens.flatMap((token, index) => {
        if (!token.identifier || tokens[index - 1]?.value === '.' || tokens[index + 1]?.value === '(') return [];
        const root = token.value.toLowerCase();
        return ['true', 'false', 'null'].includes(root) ? [] : [root];
      }),
    ),
  ];
}

function displayPath(path: readonly PathPart[]): string {
  return path
    .map((part, index) =>
      typeof part === 'number'
        ? `[${part}]`
        : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part)
        ? index === 0
          ? part
          : '.' + part
        : `[${JSON.stringify(part)}]`,
    )
    .join('');
}

/** Context availability only; no expression evaluation, value output or schema claim. */
export function workflowContextProblems(workflow: unknown): string[] {
  const problems = new Set<string>();
  function visit(value: unknown, path: PathPart[]): void {
    if (typeof value === 'string') {
      const rule = POLICIES.find((candidate) => matches(candidate.path, path));
      if (rule)
        for (const expression of expressions(value, rule.implicit === true))
          for (const context of contextRoots(expression))
            if (!rule.contexts.has(context)) problems.add(`context:${context}:${displayPath(path)}`);
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
    else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
  }
  visit(workflow, []);
  return [...problems];
}
