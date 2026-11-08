import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      '.github/ISSUE_TEMPLATE',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'bower.json',
      'CHANGELOG.md',
      'dist',
      'examples',
      'pnpm-lock.yaml',
      'src/audio.core.js',
      'src/plugins',
      'tests/css',
      'tests/js',
      'tests/*.html',
    ],
    singleQuote: true,
    sortImports: { newlinesBetween: false },
    sortPackageJson: { sortScripts: true },
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: ['dist/', 'examples/', 'src/audio.core.js', 'src/plugins/', 'tests/js/'],
    options: { typeAware: true, typeCheck: true },
    overrides: [{ env: { browser: true, node: true }, files: ['tests/*.mjs'] }],
  },
  pack: {
    dts: true,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'neutral',
  },
  staged: { '*': 'vp check --fix' },
});
