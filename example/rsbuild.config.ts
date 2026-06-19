import { defineConfig } from '@rsbuild/core'
import { pluginStartServer } from 'rsbuild-plugin-start-server';

const envs = ['development', 'integration', 'staging', 'production'];

export default defineConfig(({ env, command, envMode, }) => {

  if (!envMode || !(envs.includes(envMode))) {
    throw new Error(`Invalid envMode "${envMode}", must be one of ${envs.join(', ')}`);
  }

  const isDev = envMode === 'development';

  return {
    plugins: [
      isDev && pluginStartServer({ 'script': 'dist/index.js' }),
    ],
    output: {
      module: true,
      target: 'node',
      minify: !isDev,
      sourceMap: true,

    },
    mode: 'production'
  }
})
