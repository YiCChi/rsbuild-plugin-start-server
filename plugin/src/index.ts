import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import type { RsbuildPlugin } from '@rsbuild/core';

const logger = {
  debug: (...msg: any[]) => {
    process.env.DEBUG && console.debug('[plugin-run-script] Debug', ...msg);
  },
  info: (...msg: any[]) => console.log('[plugin-run-script] Info: ', ...msg),
  error: (...msg: any[]) => console.log('[plugin-run-script] Error: ', ...msg),
};

function getSignal(sig?: NodeJS.Signals | boolean) {
  if (sig === false) return undefined;
  if (sig === true) return 'SIGUSR2' as const;
  return sig;
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
   * Custom kill signal or false to disable
   * @default false (use 'SIGTERM')
   */
  signal?: NodeJS.Signals | boolean;
  /**
   * Working directory for spawned process
   */
  cwd?: string;
  /**
   * Enable source maps support in the child process
   * @default true
   */
  enableSourceMaps?: boolean;
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
    cwd,
    enableSourceMaps = true,
  } = options;

  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let entryPoint = isAbsolute(script) ? script : join(process.cwd(), script);
  let keyboardSupportRegistered = false;

  function _startServer() {
    logger.info(`Run ${entryPoint}...`);
    logger.debug(`Script args: ${args.join(' ')}`);

    child = fork(entryPoint, args, {
      execArgv: [
        enableSourceMaps && '--enable-source-maps',
        ...nodeArgs,
      ].filter(Boolean) as string[],
      stdio: 'inherit',
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
    });
  }

  function _stopServer() {
    try {
      const sig = getSignal(signal) ?? 'SIGTERM';
      if (child?.pid) process.kill(child.pid, sig);
    } catch (e) {
      logger.error('Failed to kill child: \n', e);
    }
  }

  function _restartServer() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      logger.info('Restarting app...');
      _stopServer();
      if (clearOnRestart) {
        // ANSI clear screen
        process.stdout.write('\u001b[2J\u001b[0;0H');
      }
      _startServer();
    }, restartDebounceMs);
  }

  function afterBuild() {
    if (child && child.connected && child.pid) {
      if (autoRestart) {
        _restartServer();
        return;
      }
      return;
    }

    // first start
    _startServer();
  }

  // Handle parent termination so we don't leave orphan processes.
  (['SIGINT', 'SIGTERM', 'SIGQUIT'] as const).forEach((sig) => {
    process.on(sig, () => {
      _stopServer();
      process.exit();
    });
  });

  // Keyboard restart support
  try {
    if (!keyboardSupportRegistered) {
      process.stdin.setEncoding('utf8');
      if (process.stdin.isPaused()) process.stdin.resume();
      process.stdin.on('data', (data: string) => {
        if (data.trim() === 'rs') {
          logger.info('Received manual restart command (rs).');
          _restartServer();
        }
      });
      keyboardSupportRegistered = true;
    }
  } catch {
    /* ignore */
  }

  return {
    name: 'plugin-start-server',
    setup(api) {
      api.onAfterBuild(async (args) => {
        if (args.stats?.hasErrors()) return;

        if (keyboardSupportRegistered)
          logger.info('Type "rs" and press Enter to manually restart the app.');
        afterBuild();
      });
    },
  };
}
