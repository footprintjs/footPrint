# Contributing to FootPrint

Thank you for your interest in contributing to FootPrint!

## Development Setup

Use **Node.js 24 LTS** for development; `.nvmrc` selects the 24.x line. The library supports Node 22 and newer, with CI running the full suite on Node 22 and 24. Node 20 is no longer supported. Keep npm on the 11.x line to match the CI resolver and publishing tooling.

```bash
git clone https://github.com/footprintjs/footPrint.git
cd footPrint
nvm install
nvm use
npm install -g npm@11
npm ci
npm run build
npm test
```

If you do not use nvm, install Node 24 LTS with your preferred version manager before running the npm commands. Selecting this project's Node version does not require changing your global default or other projects.

Commit the root `package-lock.json`: it pins the development tree so a compatible release cannot silently change local or CI checks. Use `npm ci` for a clean install; ordinary `npm install` also honors this lock. FootPrint requires `foottrace ^1.11.1`. npm excludes the root lock from the library tarball.

For a deliberate compatible Foottrace update, run `npm update foottrace --package-lock-only --ignore-scripts`, review the resolved version and integrity in the lock, then run `npm ci` and the required checks on Node 22 and 24. Keep the published runtime range intentional. When the Foottrace export surface changes, review `test/architecture/absence-codes.test.ts` (its classification of Foottrace's exports) in the same PR as the lock/version change. Generate replacement locks from a dependency-free directory using npm 11; generating from an existing platform-specific `node_modules` can omit other platforms' optional native bindings (npm #4828). Verify the Linux and macOS bindings and CI before accepting a lock update. The docs-site application maintains its own separate lock.

Dependency updates use the existing weekly Renovate workflow in `.github/workflows/renovate.yml` and the reviewed rules in `renovate.json`. Native Dependabot security updates are enabled separately. Review each update and its lock diff; do not enable blanket lock-file refreshes that would advance the intentional Foottrace development pin. With the current `GITHUB_TOKEN` fallback, PRs created by Renovate do not trigger normal CI automatically. A maintainer must trigger the PR checks, for example by closing and reopening the PR from their own account, and confirm they pass before merging. Keep `footprintjs-baseline` as the immutable 9.28.0 runtime control. The published 10.1.0 declaration reference lives in `test/fixtures/published-reference` with its own normal registry lock; refresh its exact version and lock deliberately in a reviewed release-API comparison update. Every `npm test` installs that fixture through the unconditional strict `pretest` command. Its package metadata and declarations are data only, never runtime imports; its stable Foottrace does not belong to the main graph. Expand the generated root lock diff during review and verify package sources, integrity hashes and Linux/macOS optional native bindings.

## Project Structure

```
src/lib/
├── memory/    Engine state and policy; composes foottrace writer primitives
├── schema/    Validation abstraction (Zod optional, duck-typed)
├── builder/   Fluent flowchart construction DSL
├── budget/    Static time budget over the built graph
├── scope/     Scope facades, recorders, protection
├── reactive/  TypedScope<T> deep Proxy (typed property access)
├── decide/    decide()/select() decision evidence capture
├── filter/    The one filter-rule law (decide() and the attempt rule table)
├── attempt/   The one retry loop and its attempt records
├── timers/    The one long-timer law
├── capture/   Engine retention policies, bounded payload summaries, dev-mode helpers
├── ids/       Reserved-id and generated branch-segment rules
├── errors/    Thrown-value description, terminal failure context
├── recorder/  Recorder composition primitives + stores
├── pause/     Pause/Resume (checkpoints, PausableHandler)
├── engine/    DFS traversal engine, narrative generators
├── observer-queue/  Deferred observer delivery pipeline
├── runner/    Execution convenience layer
├── sinks/     Node-only file sink for the crash-safe record
├── contract/  I/O schema normalization (chart OpenAPI generation lives in runner/)
└── detach/    Fire-and-forget child flowcharts
```

The engine layers follow the dependency fence in `scripts/layering.config.cjs`.
The standalone `foottrace` package owns record definitions, writing, replay and
path rules. Import its named public doors directly; do not add local copies or
re-export its declarations from FootPrint. Changes to one layer should not break
others.

## Making Changes

1. **Fork** the repository and create a branch from `main`.
2. **Write tests** for any new functionality. We maintain high coverage (check `npm run test:coverage`).
3. **Run the full suite** before submitting:

```bash
npm test              # full test suite (vitest run)
npm run test:coverage # tests + coverage report
npm run build         # TypeScript compilation (CJS + ESM)
npm run lint          # ESLint
npm run format        # Prettier check (format:fix to apply)
npm run check:doc-snippets # strict TypeScript checks for FootPrint-importing documentation fences
npm run check:ai-instructions # generated AI instruction files match their source and the code
npm run docs && npm run check:api-doors # the generated API reference lists every door and name
```

4. **Submit a pull request** with a clear description of the change.

`AGENTS.md` and the files in `ai-instructions/` are generated. Edit `ai-instructions/source/`, then run `npm run ai:generate`.

Documentation examples that import FootPrint are checked as separate TypeScript modules. Include their setup or an explicitly typed application input; declarations in a different fence are not shared. Do not suppress compiler errors or relabel code to avoid checking. See [the checker guide](scripts/doc-snippets/README.md) for coverage and exclusions. Passing this check proves type correctness, not runtime output.

## Code Style

- TypeScript strict mode is enabled
- Follow existing patterns in the codebase
- In `TypedScope<T>` stages use typed property access (e.g. `scope.amount = 50000`); the lower-level `getValue`/`setValue` facade is internal — prefer TypedScope for new code
- Collect during traversal, never post-process the tree — use recorders
- One purpose per recorder: own a store (`KeyedStore`/`SequenceStore`/`BoundaryStateStore`) and implement the relevant channel interface, rather than mixing concerns
- Prefer small, focused functions over large monoliths

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add stage description support to builder
fix: prevent scope protection from blocking class getters
docs: update README with backtracking example
refactor: extract narrative builder from traverser
test: add coverage for loop-back edge cases
```

## Reporting Issues

Open an issue at [github.com/footprintjs/footPrint/issues](https://github.com/footprintjs/footPrint/issues) with:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Your Node.js and TypeScript versions

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
