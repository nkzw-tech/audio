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
      'src/audio.core.js',
      'src/plugins',
    ],
    singleQuote: true,
    sortImports: { newlinesBetween: false },
    sortPackageJson: { sortScripts: true },
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: ['dist/', 'src/audio.core.js', 'src/plugins/'],
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
