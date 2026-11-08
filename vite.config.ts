import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: [
    {
      entry: { audio: 'src/index.js' },
      format: 'cjs',
      outExtensions: () => ({ js: '.cjs' }),
      platform: 'neutral',
    },
    ...Object.entries({
      audio: 'src/index.js',
      'audio.min': 'src/index.js',
      'audio.core.min': 'src/audio.core.js',
      'audio.spatial.min': 'src/plugins/audio.spatial.js',
    }).map(([name, entry]) => ({
      clean: false,
      entry: { [name]: entry },
      format: 'iife' as const,
      globalName: 'NkzwAudioBundle',
      minify: name.endsWith('.min'),
      outputOptions: { entryFileNames: '[name].js' },
      platform: 'browser' as const,
    })),
  ],
});
