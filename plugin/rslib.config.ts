import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      syntax: 'es2022',
      dts: {
        autoExtension: true,
      },
    },
  ],
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
  output: {
    cleanDistPath: true,
    sourceMap: true,
    target: 'node',
    // Keep the published bundle readable: this is a dev-time build plugin, so
    // stack traces / debugging matter far more than a few saved kilobytes.
    minify: false,
  },
  mode: 'production',
});
