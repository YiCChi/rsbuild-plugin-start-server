import { defineConfig } from '@rslib/core'

export default defineConfig({
  lib: [
    {
      syntax: 'es2022',
      dts: {
        autoExtension: true
      },
      redirect: {
        dts: {
          extension: true
        }
      }
    }
  ],
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
  output: {
    cleanDistPath: true,
    sourceMap: true,
    target: 'node',
    minify: true
  },
  mode: 'production'
})
