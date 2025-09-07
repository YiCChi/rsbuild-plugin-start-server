# rsbuild-plugin-start-server

Automatically (re)start (and manually restart) a Node.js server whenever an **Rsbuild** build finishes.

## Why?

When building a backend (or SSR / API layer) with [Rsbuild](https://rsbuild.dev/), you often need to:

1. Run a build (sometimes in watch mode)
2. Start / restart a Node process pointing at the freshly emitted bundle
3. Avoid leaving orphan processes around when you stop the dev session

This plugin automates that loop: after every successful build it (re)launches your server script, with debouncing, clean console (optional), source maps, custom env / args, and a quick manual restart command.

## Features

- Auto start after the first successful build
- Auto restart after subsequent successful rebuilds (configurable)
- Debounce rapid rebuild storms (default 150ms)
- Manual restart shortcut: type `rs` + Enter in the terminal
- Clears the console between restarts (configurable)
- Merges custom environment variables
- Supports custom Node.js exec arguments (e.g. `--inspect`)
- Optional source maps (`--enable-source-maps`, on by default)
- Graceful shutdown with configurable signal
- Works with absolute or project-root relative script paths

## Installation

```bash
pnpm add -D rsbuild-plugin-start-server
# or
npm install -D rsbuild-plugin-start-server
# or
yarn add -D rsbuild-plugin-start-server
```

Peer dependency:

```text
@rsbuild/core ^1.5.0
```

Requires **Node.js >= 18.12.0**.

## Quick Start

Your typical file layout (simplified):

```text
src/server/index.ts   --> (compiled by Rsbuild) --> dist/server/index.js
```

Add the plugin to `rsbuild.config.ts` (or `rsbuild.config.mjs`):

```ts
import { defineConfig } from '@rsbuild/core';
import { pluginStartServer } from 'rsbuild-plugin-start-server';

export default defineConfig({
  plugins: [
    pluginStartServer({
      // Relative to project root OR absolute path
      script: 'dist/server/index.js',
    }),
  ],
});
```

Run Rsbuild in watch mode (or however you normally iterate):

```bash
pnpm rsbuild build --watch
```

On the first successful build the server starts. On later successful rebuilds it restarts. Type `rs` + Enter at any time for a manual restart.

## Manual Restart Shortcut

Inside the same terminal where Rsbuild runs you can type:

```text
rs
```

The plugin will print a message and restart the child process immediately (still honoring the debounce timer if one is in flight).

## API

```ts
pluginStartServer(options: PluginStartServerOptions): RsbuildPlugin
```

### `PluginStartServerOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `script` | `string` | (required) | Built entry file to execute (relative to project root or absolute). |
| `nodeArgs` | `string[]` | `[]` | Extra Node.js exec arguments (e.g. `['--inspect=9229']`). |
| `args` | `string[]` | `[]` | Arguments passed to your application script. |
| `env` | `Record<string, string \| undefined>` | `{}` | Extra environment vars merged into `process.env`. |
| `clearOnRestart` | `boolean` | `true` | Clear console before each restart. |
| `restartDebounceMs` | `number` | `150` | Debounce interval for back‑to‑back rebuilds. |
| `autoRestart` | `boolean` | `true` | If `false`, only the first build starts the process (no auto restarts). |
| `signal` | `NodeJS.Signals \| boolean` | `false` | Custom kill signal. `false` = `SIGTERM`; `true` = `SIGUSR2`; or pass a signal string. |
| `cwd` | `string` | `process.cwd()` | Working directory for the child process. |
| `enableSourceMaps` | `boolean` | `true` | Adds `--enable-source-maps` to `execArgv` for better stack traces. |

### Signals

By default (`signal: false`) the plugin uses `SIGTERM`. Setting `signal: true` switches to `SIGUSR2` (handy with some reload workflows). You may supply any valid NodeJS signal string (e.g. `SIGINT`).

## Examples

### 1. Basic usage

```ts
pluginStartServer({ script: 'dist/server/index.js' });
```

### 2. With inspect & custom args

```ts
pluginStartServer({
	script: 'dist/server/index.js',
	nodeArgs: ['--inspect=9229'],
	args: ['--port', '4000'],
});
```

### 3. Custom environment & no console clear

```ts
pluginStartServer({
	script: 'dist/server/index.js',
	env: { NODE_ENV: 'development', FEATURE_FLAG_X: '1' },
	clearOnRestart: false,
});
```

### 4. Manual restart only (disable auto)

```ts
pluginStartServer({
	script: 'dist/server/index.js',
	autoRestart: false,
});
```

### 5. Absolute script path

```ts
import { join } from 'node:path';

pluginStartServer({
	script: join(process.cwd(), 'dist/server/index.js'),
});
```

## Tips

- Ensure your build actually outputs the script before the first restart attempt. If you use incremental / partial builds, point `script` at the final emitted file.
- If you see stale processes after killing the terminal, verify your shell forwards signals properly.
- To diagnose plugin internals, run with `DEBUG=1` in your environment.

## Limitations

- Not intended for production process management. Use a mature supervisor (pm2, systemd, containers, etc.) in production.
- Assumes a single server process; does not manage clusters.

## Troubleshooting

| Symptom | Possible Cause | Fix |
|---------|----------------|-----|
| Child never starts | Wrong `script` path | Check emitted file path in `dist` folder. |
| Rapid multiple restarts | Very fast rebuilds | Increase `restartDebounceMs`. |
| No manual restart on `rs` | Terminal not forwarding stdin | Run outside of an environment that detaches stdin (e.g. some CI logs). |
| No source map traces | Node version / maps disabled | Ensure Node >= 18.12 and `enableSourceMaps: true`. |

## Contributing

PRs and issues welcome. Please keep changes small and focused. Before submitting:

1. Run build: `pnpm build`
2. Ensure TypeScript passes
3. Describe behavior changes in the PR

## License

MIT © YiCChi

## Acknowledgements

This plugin was inspired by and borrows some implementation ideas from:

- [start-server-webpack-plugin](https://github.com/ericclemmons/start-server-webpack-plugin)
- [run-script-webpack-plugin](https://github.com/atassis/run-script-webpack-plugin)

Thanks to the authors & contributors of those projects for their prior art in simplifying server (re)start workflows during development.
