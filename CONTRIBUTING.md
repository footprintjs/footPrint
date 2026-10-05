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
npm install
npm run build
npm test
```

If you do not use nvm, install Node 24 LTS with your preferred version manager before running the npm commands. Selecting this project's Node version does not require changing your global default or other projects.

## Project Structure

```
src/lib/
├── memory/    Transactional state primitives
├── schema/    Validation abstraction (Zod optional, duck-typed)
├── builder/   Fluent flowchart construction DSL
├── scope/     Scope facades, recorders, protection
├── reactive/  TypedScope<T> deep Proxy (typed property access)
├── decide/    decide()/select() decision evidence capture
├── recorder/  Recorder composition primitives + stores
├── pause/     Pause/Resume (checkpoints, PausableHandler)
├── engine/    DFS traversal engine, narrative generators
├── runner/    Execution convenience layer
├── contract/  I/O schema normalization (chart OpenAPI generation lives in runner/)
└── detach/    Fire-and-forget child flowcharts
```

Each library is independently usable. Changes to one should not break others.

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
```

4. **Submit a pull request** with a clear description of the change.

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
