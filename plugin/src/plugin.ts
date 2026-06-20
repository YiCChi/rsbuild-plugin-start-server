import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import type { RsbuildPlugin } from '@rsbuild/core';

const CLEAR_SCREEN = '\u001b[2J\u001b[0;0H';

/**
 * Resolve the user-facing `signal` option into a concrete Node signal.
 * - `false` (default) -> SIGTERM (full kill + re-fork)
 * - `true`            -> SIGUSR2 (in-place reload; the script is expected to
 *                        handle it and refresh itself, so we do NOT re-fork)
 * - string            -> that exact signal, treated as a kill + re-fork
 */
export function resolveSignal(sig: NodeJS.Signals | boolean): {
  signal: NodeJS.Signals;
  reload: boolean;
} {
  if (sig === true) return { signal: 'SIGUSR2', reload: true };
  if (sig === false) return { signal: 'SIGTERM', reload: false };
  return { signal: sig, reload: false };
}

export interface PluginStartServerOptions {
  /** Relative path (from project root) to the built entry file. */
  script: string;
  /**
   * Extra Node.js args, e.g. ['--inspect=9229']
   */
  nodeArgs?: string[];
  /**
   *  Arguments passed to the application script.
   */
  args?: string[];
  /**
   * Environment variables to merge into process.env
   */
  env?: Record<string, string | undefined>;
  /**
   * Clear console before each restart
   * @default true
   */
  clearOnRestart?: boolean;
  /**
   * Debounce time (ms) between rapid rebuilds
   * @default 150
   */
  restartDebounceMs?: number;
  /**
   * Auto restart on rebuild if process already running
   * @default true
   */
  autoRestart?: boolean;
  /**
   * How to stop the child process before a restart.
   *
   * - `false` (default): send `SIGTERM` and re-fork a fresh process once the
   *   old one has exited.
   * - `true`: send `SIGUSR2` and let the running process reload itself
   *   in-place (nodemon-style). No new process is spawned.
   * - any signal string (e.g. `'SIGINT'`): send that signal and re-fork.
   *
   * Use `true` only when your script installs a `SIGUSR2` handler.
   */
  signal?: NodeJS.Signals | boolean;
  /**
   * Grace period (ms) after sending the kill signal before force-killing
   * the child with `SIGKILL`. Only relevant when not in reload mode.
   * @default 1500
   */
  killTimeoutMs?: number;
  /**
   * Working directory for spawned process
   */
  cwd?: string;
  /**
   * Enable source maps support in the child process
   * @default true
   */
  enableSourceMaps?: boolean;
  /**
   * Enable the `rs` + Enter manual restart shortcut on stdin.
   * @default true
   */
  manualRestart?: boolean;
}

export function pluginStartServer(
  options: PluginStartServerOptions,
): RsbuildPlugin {
  const {
    script,
    nodeArgs = [],
    args = [],
    env = {},
    clearOnRestart = true,
    restartDebounceMs = 150,
    autoRestart = true,
    signal = false,
    killTimeoutMs = 1500,
    cwd,
    enableSourceMaps = true,
    manualRestart = true,
  } = options;

  return {
    name: 'plugin-start-server',
    setup(api) {
      const { logger, context } = api;

      // Resolve relative script paths against Rsbuild's project root rather
      // than process.cwd(), so custom roots (`--root`, monorepos) work.
      const entryPoint = isAbsolute(script)
        ? script
        : join(context.rootPath, script);

      let child: ChildProcess | undefined;
      let timer: NodeJS.Timeout | undefined;
      let restarting = false;
      // Once cleanup has run we must never spawn another process.
      let closed = false;
      // Serialize restarts so rapid rebuilds can't run stop/start concurrently
      // (which would orphan processes and cause EADDRINUSE).
      let restartQueue: Promise<void> = Promise.resolve();

      function startServer() {
        if (closed) return;
        logger.info(`Run ${entryPoint}...`);

        const execArgv = enableSourceMaps
          ? ['--enable-source-maps', ...nodeArgs]
          : nodeArgs;

        child = fork(entryPoint, args, {
          execArgv,
          stdio: 'inherit',
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...env },
        });

        // Track the child lifecycle so we can clear stale state, surface
        // crashes, and avoid treating a dead process as "running" on the
        // next build.
        child.on('exit', (code, sig) => {
          // `restarting` means we initiated the exit; otherwise it crashed.
          if (restarting) {
            restarting = false;
          } else if (child) {
            logger.warn(
              `App exited unexpectedly (code=${code}, signal=${sig}). It will be relaunched on the next successful build.`,
            );
          }
          child = undefined;
        });
      }

      /**
       * Stop the current child and resolve once it has actually exited
       * (or after the kill timeout). This closes the race where a new
       * process is forked before the old one has released its port.
       */
      function stopServer(): Promise<void> {
        return new Promise((resolve) => {
          const target = child;
          const pid = target?.pid;
          if (!target || !pid) {
            child = undefined;
            return resolve();
          }

          const { signal: sig, reload } = resolveSignal(signal);
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            resolve();
          };

          // In reload mode (SIGUSR2) the process stays alive on purpose,
          // so there is nothing to wait for.
          if (reload) {
            try {
              process.kill(pid, sig);
            } catch (e) {
              logger.error('Failed to signal child:\n', e);
            }
            return resolve();
          }

          target.once('exit', done);
          try {
            process.kill(pid, sig);
          } catch (e) {
            logger.error('Failed to kill child:\n', e);
            return done();
          }

          // Force-kill fallback so a misbehaving process can't block a
          // restart forever.
          const forceTimer = setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already gone */
            }
            done();
          }, killTimeoutMs);
        });
      }

      function restartServer() {
        if (closed) return;
        if (timer) clearTimeout(timer);
        // Debounce so a burst of rebuilds collapses into a single restart,
        // then chain onto restartQueue so only one restart runs at a time.
        timer = setTimeout(() => {
          timer = undefined;
          // Reassigns the queue tail to serialize restarts; the previous value
          // is read on the right-hand side, so this is not an unused write.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          restartQueue = restartQueue
            .then(async () => {
              if (closed) return;
              const { reload } = resolveSignal(signal);
              if (reload) {
                // In-place reload: the process reloads itself, no re-fork.
                logger.info('Reloading app (SIGUSR2)...');
                restarting = true;
                await stopServer();
                return;
              }

              logger.info('Restarting app...');
              restarting = true;
              await stopServer();
              if (closed) return;
              if (clearOnRestart) process.stdout.write(CLEAR_SCREEN);
              startServer();
            })
            .catch((err) => {
              logger.error('Failed to restart server:\n', err);
            });
        }, restartDebounceMs);
      }

      function afterBuild() {
        if (closed) return;
        if (child && child.pid) {
          if (autoRestart) {
            restartServer();
          }
          return;
        }

        // First start (or previous process has died).
        startServer();
      }

      // --- Manual restart shortcut ("rs" + Enter) ----------------------
      let stdinRegistered = false;
      const onStdin = (data: string) => {
        if (data.trim() === 'rs') {
          logger.info('Received manual restart command (rs).');
          restartServer();
        }
      };
      if (manualRestart && process.stdin.isTTY) {
        try {
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', onStdin);
          stdinRegistered = true;
        } catch {
          /* stdin not usable in this environment */
        }
      }

      // --- Lifecycle hooks ---------------------------------------------
      // Backend dev uses `rsbuild build --watch`: the first build starts the
      // server, and each subsequent successful rebuild restarts it.
      // (Rsbuild's built-in dev server targets front-end HMR and is not used
      // for back-end workflows.)
      api.onAfterBuild((buildArgs) => {
        if (buildArgs.stats?.hasErrors()) return;
        // Only advertise the shortcut once, on the first successful build.
        if (buildArgs.isFirstCompile && stdinRegistered) {
          logger.info('Type "rs" and press Enter to manually restart the app.');
        }
        afterBuild();
      });

      // Rsbuild-managed cleanup hooks. These are preferred over manually
      // hijacking process signals because they integrate with the CLI and
      // the JS API (build.close()).
      const cleanup = () => {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (stdinRegistered) {
          process.stdin.removeListener('data', onStdin);
          // Release stdin so it can't keep the event loop alive on exit, but
          // only if nothing else is reading it (other plugins, prompts, etc.).
          if (
            process.stdin.listenerCount('data') === 0 &&
            process.stdin.listenerCount('readable') === 0
          ) {
            process.stdin.pause();
          }
        }
        // Drop our process signal listeners so they don't accumulate when
        // Rsbuild is run multiple times in the same process (e.g. tests, JS API).
        for (const sig of signals) {
          process.removeListener(sig, onSignal);
        }
        if (child?.pid) {
          // On shutdown the child must actually terminate. In reload mode the
          // configured signal is SIGUSR2 (reload, not exit), which would leave
          // an orphan — so fall back to SIGTERM to really kill it.
          const { reload, signal: sig } = resolveSignal(signal);
          try {
            process.kill(child.pid, reload ? 'SIGTERM' : sig);
          } catch {
            /* already gone */
          }
          child = undefined;
        }
      };

      api.onCloseBuild(cleanup);
      // onExit is synchronous-only; use it as a last-resort fallback for
      // cases where the close hooks don't run (e.g. SIGKILL of the parent).
      api.onExit(cleanup);

      // Best-effort signal fallback. Use `once` and remove listeners so we
      // never leak handlers across multiple Rsbuild instances in the same
      // process, and so we don't preempt Rsbuild's own shutdown logic.
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
      const onSignal = (sig: NodeJS.Signals) => {
        cleanup();
        // Re-raise to default behavior so the process actually terminates
        // and other handlers (incl. Rsbuild's) can react.
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      };
      for (const sig of signals) {
        process.once(sig, onSignal);
      }
    },
  };
}
