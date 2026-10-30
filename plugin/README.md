# rsbuild-plugin-start-server

Start your Node.js server after an **Rsbuild** build, and restart it on every rebuild.

## Why?

If you build a backend, an API or an SSR server with [Rsbuild](https://rsbuild.rs/), the dev loop usually looks like this:

1. Run `rsbuild build --watch`
2. Start the emitted bundle with Node, and restart it after each rebuild
3. Make sure no server process is left behind when you stop

This plugin does steps 2 and 3 inside the Rsbuild process, so you only run one command.

## Features

- Starts the server after the first successful build
- Restarts it after each successful rebuild (can be turned off)
- Debounces bursts of rebuilds (150ms by default)
- Type `rs` + Enter to restart by hand
- Waits for the old process to exit before starting a new one, so restarts don't hit `EADDRINUSE`; falls back to `SIGKILL` if it hangs
- Optional in-place reload with `SIGUSR2`, nodemon style, without forking a new process
- Clears the console between restarts (configurable)
- Custom environment variables, Node.js flags (e.g. `--inspect`) and script arguments
- `--enable-source-maps` on by default
- Stops the server when Rsbuild exits, through Rsbuild's `onCloseBuild` / `onExit` hooks

## Installation

```bash
pnpm add -D rsbuild-plugin-start-server
# or
npm install -D rsbuild-plugin-start-server
# or
yarn add -D rsbuild-plugin-start-server
```

The plugin needs an Rsbuild to run in, and Rslib and Rstest both ship one. Any of these satisfies the peer requirement:

| Peer            | Range      | When                                                      |
| --------------- | ---------- | --------------------------------------------------------- |
| `@rsbuild/core` | `>=1.5.0`  | You use Rsbuild directly                                  |
| `@rslib/core`   | `>=0.12.0` | You use [Rslib](https://rslib.rs/) (it bundles Rsbuild)   |
| `@rstest/core`  | `>=0.2.2`  | You use [Rstest](https://rstest.rs/) (it bundles Rsbuild) |

All three are **optional** peers. Install the one you already use; you don't need `@rsbuild/core` on top of Rslib or Rstest, and you won't get missing-peer warnings.

Requires **Node.js >= 22.22.0**.

## Quick Start

A typical layout:

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
      // Relative to the Rsbuild project root, or an absolute path.
      script: 'dist/server/index.js',
    }),
  ],
});
```

Run Rsbuild in watch mode. Rsbuild's dev server is built for front-end HMR, so a backend uses `build --watch` instead:

```bash
pnpm rsbuild build --watch
```

The server starts after the first successful build and restarts after each successful rebuild. Type `rs` + Enter to restart it yourself.

## Manual Restart Shortcut

In the terminal where Rsbuild runs, type:

```text
rs
```

and press Enter. The restart goes through the same debounce as rebuilds, so pressing `rs` several times in a row restarts once. In the default `SIGTERM` mode it also waits for the old process to exit first. The shortcut needs an interactive TTY and is off in CI or when stdin is piped.

## API

```ts
import type { RsbuildPlugin } from '@rsbuild/core';

function pluginStartServer(options: PluginStartServerOptions): RsbuildPlugin;
```

The package exports `pluginStartServer` and the `PluginStartServerOptions` type.

### `PluginStartServerOptions`

| Option              | Type                                  | Default         | Description                                                                                                                                                    |
| ------------------- | ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script`            | `string`                              | (required)      | Built entry file to run. Relative paths resolve against the Rsbuild project root.                                                                              |
| `nodeArgs`          | `string[]`                            | `[]`            | Extra Node.js flags (e.g. `['--inspect=9229']`).                                                                                                               |
| `args`              | `string[]`                            | `[]`            | Arguments passed to your script.                                                                                                                               |
| `env`               | `Record<string, string \| undefined>` | `{}`            | Environment variables merged into `process.env`.                                                                                                               |
| `clearOnRestart`    | `boolean`                             | `true`          | Clear the console before each restart. Only applies to kill-and-restart; not to the first start or to `SIGUSR2` reloads.                                       |
| `restartDebounceMs` | `number`                              | `150`           | Debounce window for back-to-back rebuilds and `rs` restarts.                                                                                                   |
| `autoRestart`       | `boolean`                             | `true`          | Restart on each successful rebuild. If `false`, rebuilds are ignored while the process is alive; a crashed process is relaunched on the next successful build. |
| `signal`            | `NodeJS.Signals \| boolean`           | `false`         | How to stop the child. `false` = `SIGTERM` (kill and fork again); `true` = `SIGUSR2` (reload in place, no fork); or any signal name.                           |
| `killTimeoutMs`     | `number`                              | `1500`          | How long to wait after the kill signal before sending `SIGKILL`. Ignored in reload mode.                                                                       |
| `cwd`               | `string`                              | `process.cwd()` | Working directory of the child process.                                                                                                                        |
| `enableSourceMaps`  | `boolean`                             | `true`          | Add `--enable-source-maps` so stack traces point at your source.                                                                                               |
| `manualRestart`     | `boolean`                             | `true`          | Enable the `rs` + Enter shortcut.                                                                                                                              |

### Signals

- **`signal: false` (default)**: the plugin sends `SIGTERM`, waits for the child to exit (sending `SIGKILL` after `killTimeoutMs` if it doesn't), then forks a new process. Use this when the server holds ports or files that must be released before it starts again.
- **`signal: true`**: the plugin sends `SIGUSR2` and **does not fork a new process**. Your script has to handle `SIGUSR2` and reload itself, as with nodemon. The process stays alive across rebuilds.
- **`signal: '<sig>'`**: sends that signal, then forks a new process, same as `false` with a different signal.

## Examples

### 1. Basic usage

```ts
pluginStartServer({ script: 'dist/server/index.js' });
```

### 2. Debugger and script arguments

```ts
pluginStartServer({
  script: 'dist/server/index.js',
  nodeArgs: ['--inspect=9229'],
  args: ['--port', '4000'],
});
```

### 3. Custom environment, keep console output

```ts
pluginStartServer({
  script: 'dist/server/index.js',
  env: { NODE_ENV: 'development', FEATURE_FLAG_X: '1' },
  clearOnRestart: false,
});
```

### 4. Restart by hand only

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
  script: join(import.meta.dirname, 'dist/server/index.js'),
});
```

### 6. Reload in place with `SIGUSR2`

With `signal: true` the plugin sends `SIGUSR2` instead of restarting the process. Your server handles the signal and refreshes itself:

```ts
// rsbuild.config.ts
pluginStartServer({
  script: 'dist/server/index.js',
  signal: true,
});
```

```ts
// src/server/index.ts
let server = startApp();

process.on('SIGUSR2', () => {
  // Close the current server, then start it again.
  server.close(() => {
    server = startApp();
  });
});
```

Only use this if your app can swap its handlers in place. Otherwise keep `signal: false`.

## Tips

- `script` must point at the file Rsbuild emits. With partial or multi-entry builds, point it at the final server entry.
- If server processes survive after you close the terminal, check that your shell forwards signals. The plugin stops the child from Rsbuild's `onCloseBuild` / `onExit` hooks and falls back to `SIGKILL`.
- The plugin logs through Rsbuild's logger, so `--log-level` (or `logLevel` in the config) also controls its messages.

## Limitations

- This is a dev tool. In production, use a process manager such as pm2, systemd or a container runtime.
- It runs a single server process and does not manage clusters.

## Troubleshooting

| Symptom                            | Possible Cause                   | Fix                                                                                      |
| ---------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Child never starts                 | Wrong `script` path              | Check the emitted file path in `dist`.                                                   |
| `EADDRINUSE` / port in use         | Old process did not exit in time | Increase `killTimeoutMs`, or close the port in your app's `SIGTERM` handler.             |
| Several restarts in a row          | Very fast rebuilds               | Increase `restartDebounceMs`.                                                            |
| `rs` does nothing                  | stdin is not a TTY               | Run in an interactive terminal; the shortcut is off in CI and with piped stdin.          |
| `signal: true` has no effect       | App ignores `SIGUSR2`            | Add a `SIGUSR2` handler to your server (see Example 6).                                  |
| `autoRestart: false` won't restart | Process still alive              | With auto-restart off, rebuilds are ignored while the process runs; use `rs` to restart. |
| No source-mapped stack traces      | Old Node or maps disabled        | Use Node >= 22.22 and keep `enableSourceMaps: true`.                                     |

## Contributing

Issues and PRs are welcome. Keep changes small and focused. Before you open a PR, run these in `plugin/`:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```

and describe any behavior change in the PR.

## License

MIT © YiCChi (2025-present)

## Acknowledgements

Inspired by, and borrowing ideas from:

- [start-server-webpack-plugin](https://github.com/ericclemmons/start-server-webpack-plugin)
- [run-script-webpack-plugin](https://github.com/atassis/run-script-webpack-plugin)
