# Workflow expression contexts

`workflowContextProblems(workflow)` is a pure position/context policy over parsed
repository YAML. Its declarative table follows GitHub's primary
[context-availability reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability).

Each diagnostic contains only the unavailable root context and the YAML value's
path, for example `context:runner:jobs.publish.env.ARTIFACT_DIRECTORY`. It never
prints an expression, property value or secret name from the expression.

The table distinguishes workflow, job, step, container/service, reusable-call
and workflow-call positions. Job outputs allow runner, env, job, steps and
secrets; job env does not allow runner, env, job or steps. More-specific nested
positions take precedence over enclosing maps. Nested input values inherit
their position's policy.

The lexer examines `${{ ... }}` spans, plus implicit expressions in job/step
`if`. It skips quoted strings (including doubled single quotes), numeric and
boolean/null literals, property names and function identifiers. Dot/bracket
access, bare objects passed to functions and multiline expressions expose their
root context. Text outside expressions is ordinary text.

This is a policy subset, not a complete GitHub expression parser, workflow
schema/type validator or Actions execution. Unlisted positions, syntax,
function signatures and value types remain the hosted pinned actionlint
layer's responsibility. The tests are adjacent; root executes them and the
integration/mutation controls.
