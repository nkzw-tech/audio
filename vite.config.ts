import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      '.github/ISSUE_TEMPLATE',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'CHANGELOG.md',
      'dist',
      'pnpm-lock.yaml',
    ],
    singleQuote: true,
    sortImports: { newlinesBetween: false },
    sortPackageJson: { sortScripts: true },
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: ['dist/'],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        env: { browser: true },
        files: ['src/**/*.js'],
        rules: {
          'no-empty': ['error', { allowEmptyCatch: true }],
          'perfectionist/sort-objects': 'off',
          'unicorn/consistent-function-scoping': 'off',
        },
      },
      { env: { browser: true }, files: ['examples/**/*.js', 'tests/js/*.js'] },
      { env: { browser: true, node: true }, files: ['tests/*.mjs'] },
    ],
  },
  pack: [
    {
      dts: true,
      entry: { index: 'src/index.ts', music: 'src/music/index.ts' },
      format: ['esm', 'cjs'],
      minify: true,
      platform: 'neutral',
    },
    {
      clean: false,
      entry: { 'music-worker': 'src/music/adtsWorker.ts' },
      format: 'esm',
      minify: true,
      platform: 'browser',
    },
  ],
  staged: { '*': 'vp check --fix' },
});
