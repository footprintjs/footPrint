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
    '@typescript-eslint/no-var-requires': 'error',
    "@typescript-eslint/ban-ts-comment": "off",
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-unused-vars': 'off',
    'no-prototype-builtins': 'error',
    'no-restricted-syntax': ['error', "BinaryExpression[operator='in']"],
    'no-use-before-define': 'off',
  },
};
