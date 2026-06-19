# rsbuild-plugin-start-server

Automatically (re)start a Node.js server whenever an **Rsbuild** build finishes — with manual restart, debouncing, and clean shutdown.

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
- Waits for the old process to exit before relaunching (no `EADDRINUSE` races), with a `SIGKILL` fallback
- In-place reload mode via `SIGUSR2` (nodemon-style, no re-fork)
- Clears the console between restarts (configurable)
- Merges custom environment variables
- Supports custom Node.js exec arguments (e.g. `--inspect`)
- Optional source maps (`--enable-source-maps`, on by default)
- Graceful shutdown via Rsbuild's `onExit` / `onCloseBuild` hooks
- Works with absolute or working-directory-relative script paths

## Installation

```bash
pnpm add -D rsbuild-plugin-start-server @rsbuild/core
# or
npm install -D rsbuild-plugin-start-server @rsbuild/core
# or
yarn add -D rsbuild-plugin-start-server @rsbuild/core
```

`@rsbuild/core` (^1.5.0) is a peer dependency and must be installed alongside the plugin.

Requires **Node.js >= 22.22.0** (see `engines` in `package.json`).

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
      // Relative to the current working directory, OR an absolute path.
      // In a monorepo sub-package, prefer an absolute path built from
      // `__dirname` / `import.meta.dirname` so the resolved location does
      // not depend on where you invoke the CLI from.
      script: 'dist/server/index.js',
    }),
  ],
});
```

Run Rsbuild in watch mode (the standard back-end dev workflow — Rsbuild's built-in dev server targets front-end HMR and is not used here):

```bash
pnpm rsbuild build --watch
```

On the first successful build the server starts. On later successful rebuilds it restarts. Type `rs` + Enter at any time for a manual restart.

## Manual Restart Shortcut

Inside the same terminal where Rsbuild runs you can type:

```text
rs
```

The plugin prints a message and restarts the child process. The restart always honors `restartDebounceMs` (so a flurry of `rs` presses collapses into one restart) and, in the default `SIGTERM` mode, waits for the old process to exit before relaunching. Requires an interactive TTY (it is skipped automatically in CI / piped stdin).

## API

```ts
import type { RsbuildPlugin } from '@rsbuild/core';

function pluginStartServer(options: PluginStartServerOptions): RsbuildPlugin;
```

`RsbuildPlugin` is re-exported from `@rsbuild/core`.

### `PluginStartServerOptions`

| Option              | Type                                  | Default         | Description                                                                                                                                                    |
| ------------------- | ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script`            | `string`                              | (required)      | Built entry file to execute (relative to the current working directory, or absolute).                                                                          |
| `nodeArgs`          | `string[]`                            | `[]`            | Extra Node.js exec arguments (e.g. `['--inspect=9229']`).                                                                                                      |
| `args`              | `string[]`                            | `[]`            | Arguments passed to your application script.                                                                                                                   |
| `env`               | `Record<string, string \| undefined>` | `{}`            | Extra environment vars merged into `process.env`.                                                                                                              |
| `clearOnRestart`    | `boolean`                             | `true`          | Clear the console before each restart. Applies to `SIGTERM`/signal restarts only — not to the first start or to `SIGUSR2` reloads.                             |
| `restartDebounceMs` | `number`                              | `150`           | Debounce interval for back‑to‑back rebuilds (and manual `rs` restarts).                                                                                        |
| `autoRestart`       | `boolean`                             | `true`          | Restart on each successful rebuild. If `false`, rebuilds are ignored while the process is alive; a crashed process is relaunched on the next successful build. |
| `signal`            | `NodeJS.Signals \| boolean`           | `false`         | How to stop the child. `false` = `SIGTERM` (kill + re-fork); `true` = `SIGUSR2` (in-place reload, no re-fork); or a signal string.                             |
| `killTimeoutMs`     | `number`                              | `1500`          | Grace period before force-killing (`SIGKILL`) the child after the kill signal. Ignored in reload mode.                                                         |
| `cwd`               | `string`                              | `process.cwd()` | Working directory for the child process.                                                                                                                       |
| `enableSourceMaps`  | `boolean`                             | `true`          | Adds `--enable-source-maps` to `execArgv` for better stack traces.                                                                                             |
| `manualRestart`     | `boolean`                             | `true`          | Enable the `rs` + Enter manual restart shortcut on stdin.                                                                                                      |

### Signals

- **`signal: false` (default)** — the plugin sends `SIGTERM`, waits for the child to actually exit (then force-kills with `SIGKILL` after `killTimeoutMs`), and forks a fresh process. Use this when your server binds ports/files that must be released before restart. Each successful rebuild repeats this whole cycle.
- **`signal: true`** — the plugin sends `SIGUSR2` and **does not re-fork**. Your script is expected to install a `SIGUSR2` handler and reload itself in place (nodemon-style). Each successful rebuild re-sends `SIGUSR2`; the process stays alive across rebuilds. Useful for zero-downtime reloads where you don't want the process to restart.
- **`signal: '<sig>'`** — sends that signal and re-forks (same as `false`, just with a different signal).

In kill + re-fork modes, the plugin awaits the old process's exit before relaunching, so you won't see `EADDRINUSE`-style races on restart.

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

### 6. In-place reload via `SIGUSR2`

With `signal: true`, the plugin sends `SIGUSR2` instead of restarting the process. Your server must handle the signal and refresh itself:

```ts
// rsbuild.config.ts
pluginStartServer({
  script: 'dist/server/index.js',
  signal: true, // SIGUSR2 in-place reload
});
```

```ts
// src/server/index.ts
let server = startApp();

process.on('SIGUSR2', () => {
  // Tear down current connections / close ports, then re-initialize.
  server.close(() => {
    server = startApp();
    process.emit('SIGUSR2'); // some frameworks expect the signal to keep propagating
  });
});
```

Use this when you want zero-downtime reloads and your app can hot-swap its handlers. If in doubt, leave `signal: false`.

## Tips

- Ensure your build actually outputs the script before the first restart attempt. If you use incremental / partial builds, point `script` at the final emitted file.
- If you see stale processes after killing the terminal, verify your shell forwards signals properly. The plugin also uses Rsbuild's `onExit` / `onCloseBuild` / `onCloseDevServer` hooks and a `SIGKILL` fallback to clean up children.
- To see plugin diagnostics, raise Rsbuild's log level (e.g. `RSBUILD_LOG_LEVEL=verbose`); the plugin logs through `api.logger`.

## Limitations

- Not intended for production process management. Use a mature supervisor (pm2, systemd, containers, etc.) in production.
- Assumes a single server process; does not manage clusters.

## Troubleshooting

| Symptom                            | Possible Cause                   | Fix                                                                                      |
| ---------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Child never starts                 | Wrong `script` path              | Check the emitted file path in `dist`.                                                   |
| `EADDRINUSE` / port in use         | Old process did not exit in time | Increase `killTimeoutMs`, or make sure your app closes the port on `SIGTERM`.            |
| Rapid multiple restarts            | Very fast rebuilds               | Increase `restartDebounceMs`.                                                            |
| No manual restart on `rs`          | Terminal not forwarding stdin    | Run in an interactive TTY; the shortcut is auto-disabled in CI / piped stdin.            |
| `signal: true` has no effect       | App ignores `SIGUSR2`            | Install a `SIGUSR2` handler in your server (see Example 6).                              |
| `autoRestart: false` won't restart | Process still alive              | With auto-restart off, rebuilds are ignored while the process runs; use `rs` to restart. |
| No source map traces               | Node version / maps disabled     | Ensure Node >= 22.22 and `enableSourceMaps: true`.                                       |

## Contributing

PRs and issues welcome. Please keep changes small and focused. Before submitting:

1. Run build: `pnpm build`
2. Ensure TypeScript passes
3. Describe behavior changes in the PR

## License

MIT © YiCChi (2025–present)

## Acknowledgements

This plugin was inspired by and borrows some implementation ideas from:

- [start-server-webpack-plugin](https://github.com/ericclemmons/start-server-webpack-plugin)
- [run-script-webpack-plugin](https://github.com/atassis/run-script-webpack-plugin)

Thanks to the authors & contributors of those projects for their prior art in simplifying server (re)start workflows during development.
