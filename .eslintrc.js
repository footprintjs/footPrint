const { layerZones } = require('./scripts/layering.config.cjs');

module.exports = {
  // Stop config resolution here. Without this, eslint walks UP the directory
  // tree — a checkout nested inside another checkout of this repo (e.g. a git
  // worktree under .claude/worktrees/) loads BOTH copies of this file, and
  // the duplicate `plugins` definitions (resolved from two node_modules)
  // crash every lint/lint-staged run with "Cannot redefine plugin".
  root: true,
  env: {
    browser: true,
    es2021: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 12,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import', 'prettier', 'simple-import-sort'],
  extends: [
    'standard',
    'eslint:recommended',
    'plugin:@typescript-eslint/eslint-recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  settings: {
    'import/resolver': {
      typescript: true,
      node: true,
    },
  },
  overrides: [
    {
      // THE FENCE (src only — tests import whatever they test). The layer table lives in
      // scripts/layering.config.cjs; `layerZones` turns it into zones, so the table has one
      // owner and `npm run check:layering` reads the same one.
      //   - no-cycle: file-level value cycles (type-only imports are ignored by the rule).
      //   - no-restricted-paths: a file imports only its own layer or below, and a record file
      //     (RECORD_FILES, C6) imports only record files — by value or by type.
      // Three edges are deliberate and named (reasons in EXCEPTIONS there):
      //   builder  -> runner/RunnableChart.ts  (`makeRunnable`)
      //   engine   -> reactive/handles.ts      (the handle registry)
      //   scope    -> detach/spawn.ts          (`$detachAndJoinLater` / `$detachAndForget`)
      // plus a short TYPE_ONLY_ALLOWANCES list: upward imports that tsc erases, which this
      // rule cannot tell from runtime ones.
      files: ['src/**/*.ts'],
      rules: {
        'import/no-cycle': ['error', { ignoreExternal: true }],
        'no-restricted-imports': [
          'error',
          {
            paths: ['foottrace', 'foottrace/write', 'foottrace/paths'].map((name) => ({
              name,
              importNames: ['*', 'default'],
              message: 'Use named imports from the owning foottrace door.',
            })),
            patterns: [
              {
                group: ['foottrace/**', '!foottrace/write', '!foottrace/paths'],
                message: 'Only foottrace, foottrace/write and foottrace/paths are public doors.',
              },
            ],
          },
        ],
        'import/no-restricted-paths': ['error', { basePath: __dirname, zones: layerZones(__dirname) }],
      },
    },
    {
      files: ['test/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'no-proto': 'off',
      },
    },
  ],
  rules: {
    'prettier/prettier': 'error',
    'import/first': 'off',
    camelcase: 'off',
    'no-new': 'off',
    'no-useless-constructor': 'off',
    quotes: [2, 'single', { avoidEscape: true }],
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    'import/no-unresolved': [
      'error',
      {
        ignore: ['^aws-lambda$', '^vitest$'],
      },
    ],
    // Keep the v5 distinction: variable require declarations are refused, while
    // side-effect requires and TypeScript import-equals remain permitted.
    '@typescript-eslint/no-var-requires': 'error',
    '@typescript-eslint/no-require-imports': 'off',
    // Keep the established v5 policy while upgrading the parser and plugin. v8's
    // recommended defaults promote `any` to an error and replace Standard's
    // expression rule; those are policy changes, not security fixes.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/adjacent-overload-signatures': 'error',
    '@typescript-eslint/no-inferrable-types': 'error',
    '@typescript-eslint/no-duplicate-enum-values': 'off',
    '@typescript-eslint/no-unsafe-declaration-merging': 'off',
    // v8 split ban-types into narrower rules that exempt intersections and
    // shadowed names. Keep the old type-name policy through its supported port.
    '@typescript-eslint/no-restricted-types': [
      'error',
      {
        types: {
          String: { message: 'Use string instead', fixWith: 'string' },
          Boolean: { message: 'Use boolean instead', fixWith: 'boolean' },
          Number: { message: 'Use number instead', fixWith: 'number' },
          Symbol: { message: 'Use symbol instead', fixWith: 'symbol' },
          BigInt: { message: 'Use bigint instead', fixWith: 'bigint' },
          Function: true,
          Object: true,
          '{}': true,
        },
      },
    ],
    '@typescript-eslint/no-empty-interface': 'error',
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-unsafe-function-type': 'off',
    '@typescript-eslint/no-wrapper-object-types': 'off',
    'no-extra-semi': 'error',
    'no-class-assign': 'error',
    'no-with': 'error',
    'valid-typeof': 'off',
    'no-empty-function': 'off',
    '@typescript-eslint/no-empty-function': 'error',
    '@typescript-eslint/no-unused-expressions': [
      'error',
      { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
    ],
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    'no-unused-vars': 'off',
    'no-prototype-builtins': 'error',
    'no-restricted-syntax': ['error', "BinaryExpression[operator='in']"],
    'no-use-before-define': 'off',
  },
};
