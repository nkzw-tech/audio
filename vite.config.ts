import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      '.github/ISSUE_TEMPLATE',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'CHANGELOG.md',
      'lib',
      'pnpm-lock.yaml',
    ],
    singleQuote: true,
    sortImports: { newlinesBetween: false },
    sortPackageJson: { sortScripts: true },
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: ['lib/'],
    options: { typeAware: true, typeCheck: true },
    overrides: [
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
      outDir: 'lib',
      platform: 'neutral',
      target: 'es2022',
    },
    {
      clean: false,
      entry: { 'music-worker': 'src/music/adtsWorker.ts' },
      format: 'esm',
      minify: true,
      outDir: 'lib',
      platform: 'browser',
      target: 'es2022',
    },
  ],
  staged: { '*': 'vp check --fix' },
});
