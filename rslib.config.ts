import { defineConfig } from '@rslib/core'

export default defineConfig({
  lib: [
    {
      syntax: 'es2022',
      dts: true,
    }
  ],
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
  output: {
    cleanDistPath: true,
    sourceMap: true,
    target: 'node'
  }
})
