import type { ForkOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { RsbuildPluginAPI } from '@rsbuild/core';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rs,
} from '@rstest/core';

import { pluginStartServer, resolveSignal } from './plugin';

// `rs.mock` factories are hoisted, so any shared mock objects they reference
// must be created via `rs.hoisted` to be available when the factory runs.
const mocks = rs.hoisted(() => {
  let pidCounter = 1000;
  return {
    fork: rs.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        killed: boolean;
        kill: () => boolean;
      };
      child.pid = ++pidCounter;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      return child;
    }),
  };
});

rs.mock('node:child_process', () => ({ fork: mocks.fork }));

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  kill: () => boolean;
};

/**
 * The subset of `RsbuildPluginAPI` the plugin actually touches. We construct
 * only these members and pass the fake to `setup()`; everything else is left
 * out because the plugin never reads it.
 */
type FakeApi = Pick<
  RsbuildPluginAPI,
  'logger' | 'context' | 'onAfterBuild' | 'onCloseBuild' | 'onExit'
>;

/** Build a fake Rsbuild plugin API that records registered hook callbacks. */
function createFakeApi(): FakeApi {
  return {
    context: { rootPath: '/project' },
    logger: {
      info: rs.fn(),
      warn: rs.fn(),
      error: rs.fn(),
      debug: rs.fn(),
    },
    onAfterBuild: rs.fn(),
    onCloseBuild: rs.fn(),
    onExit: rs.fn(),
  } as unknown as FakeApi;
}

/** A minimal "build succeeded" payload compatible with onAfterBuild. */
type BuildArgs = { stats?: { hasErrors: () => boolean } };

/** Shorthand to read the first (and only) handler registered for a hook. */
function onAfterBuildHandler(api: FakeApi): (args: BuildArgs) => void {
  const handler = rs.mocked(api.onAfterBuild).mock.calls[0]?.[0];
  return handler as (args: BuildArgs) => void;
}
function onCloseBuildHandler(api: FakeApi): () => void {
  const handler = rs.mocked(api.onCloseBuild).mock.calls[0]?.[0];
  return handler as () => void;
}

/** Shorthand to read the n-th fork() call's arguments. */
function forkCall(index: number) {
  const call = mocks.fork.mock.calls[index] as unknown as
    | [string, string[], ForkOptions]
    | undefined;
  if (!call) throw new Error(`fork was not called ${index + 1} time(s)`);
  return call;
}

/** Shorthand to read the n-th fork() result (the fake child). */
function forkResult(index: number): FakeChild {
  const result = mocks.fork.mock.results[index];
  if (!result) throw new Error(`fork produced no result ${index + 1}`);
  return result.value as FakeChild;
}

const EXIT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

beforeEach(() => {
  mocks.fork.mockClear();
});

afterEach(() => {
  rs.restoreAllMocks();
  rs.useRealTimers();
  for (const sig of EXIT_SIGNALS) process.removeAllListeners(sig);
});

afterAll(() => {
  for (const sig of EXIT_SIGNALS) process.removeAllListeners(sig);
});

// ---------------------------------------------------------------------------
// Group A — resolveSignal (pure)
// ---------------------------------------------------------------------------

describe('resolveSignal', () => {
  it('maps false to SIGTERM (kill + re-fork)', () => {
    expect(resolveSignal(false)).toEqual({ signal: 'SIGTERM', reload: false });
  });

  it('maps true to SIGUSR2 (in-place reload)', () => {
    expect(resolveSignal(true)).toEqual({ signal: 'SIGUSR2', reload: true });
  });

  it('passes a custom signal string through as a kill signal', () => {
    expect(resolveSignal('SIGINT')).toEqual({
      signal: 'SIGINT',
      reload: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Group B — first successful build starts the server
// ---------------------------------------------------------------------------

describe('onAfterBuild — first build', () => {
  it('forks the entry script with source maps and inherited stdio', () => {
    const api = createFakeApi();
    const plugin = pluginStartServer({ script: 'dist/server/index.js' });
    plugin.setup(api as RsbuildPluginAPI);

    onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    expect(mocks.fork).toHaveBeenCalledTimes(1);
    const [entry, args, opts] = forkCall(0);
    expect(entry).toMatch(/dist[\\/+]server[\\/+]index\.js$/);
    expect(args).toEqual([]);
    expect(opts.execArgv).toContain('--enable-source-maps');
    expect(opts.stdio).toBe('inherit');
    expect(api.logger.info).toHaveBeenCalled();
  });

  it('forwards nodeArgs and script args', () => {
    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      nodeArgs: ['--inspect=9229'],
      args: ['--port', '4000'],
    }).setup(api as RsbuildPluginAPI);

    onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    const [, args, opts] = forkCall(0);
    expect(args).toEqual(['--port', '4000']);
    expect(opts.execArgv).toContain('--inspect=9229');
  });

  it('omits --enable-source-maps when disabled', () => {
    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      enableSourceMaps: false,
    }).setup(api as RsbuildPluginAPI);

    onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    expect(forkCall(0)[2].execArgv).not.toContain('--enable-source-maps');
  });
});

// ---------------------------------------------------------------------------
// Group C — restart after rebuild (SIGTERM default): kill -> exit -> fork
// ---------------------------------------------------------------------------

describe('onAfterBuild — rebuild restart', () => {
  it('kills the old process, waits for exit, then forks a new one', async () => {
    const killSpy = rs.spyOn(process, 'kill').mockImplementation(() => true);
    rs.useFakeTimers();

    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      restartDebounceMs: 150,
    }).setup(api as RsbuildPluginAPI);

    const fire = (hasErrors: boolean) =>
      onAfterBuildHandler(api)({ stats: { hasErrors: () => hasErrors } });

    // First build: start the server.
    fire(false);
    expect(mocks.fork).toHaveBeenCalledTimes(1);
    const firstChild = forkResult(0);

    // Second build: schedules a restart (debounced).
    fire(false);
    expect(mocks.fork).toHaveBeenCalledTimes(1); // not yet

    await rs.advanceTimersByTimeAsync(150);

    // After the debounce, SIGTERM must have been sent to the old pid, but
    // the new process is NOT forked until the old one emits 'exit'.
    expect(killSpy).toHaveBeenCalledWith(firstChild.pid, 'SIGTERM');
    expect(mocks.fork).toHaveBeenCalledTimes(1);

    // Now simulate the old process actually exiting.
    firstChild.emit('exit', 0, null);
    await rs.advanceTimersByTimeAsync(0);

    expect(mocks.fork).toHaveBeenCalledTimes(2);
  });

  it('force-kills with SIGKILL after killTimeoutMs if the child ignores the signal', async () => {
    const killSpy = rs.spyOn(process, 'kill').mockImplementation(() => true);
    rs.useFakeTimers();

    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      restartDebounceMs: 0,
      killTimeoutMs: 1000,
    }).setup(api as RsbuildPluginAPI);

    const fire = () =>
      onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    fire(); // start
    fire(); // schedule restart
    await rs.advanceTimersByTimeAsync(0); // flush debounce

    // Child never emits 'exit' -> after killTimeoutMs it should be SIGKILLed.
    await rs.advanceTimersByTimeAsync(1000);

    expect(killSpy).toHaveBeenCalledWith(forkResult(0).pid, 'SIGKILL');
    expect(mocks.fork).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Group D — SIGUSR2 reload mode does NOT re-fork
// ---------------------------------------------------------------------------

describe('onAfterBuild — SIGUSR2 reload', () => {
  it('sends SIGUSR2 and keeps the same process (no re-fork)', async () => {
    const killSpy = rs.spyOn(process, 'kill').mockImplementation(() => true);
    rs.useFakeTimers();

    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      signal: true,
      restartDebounceMs: 0,
    }).setup(api as RsbuildPluginAPI);

    const fire = () =>
      onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    fire(); // start
    expect(mocks.fork).toHaveBeenCalledTimes(1);
    const firstPid = forkResult(0).pid;

    fire(); // schedule reload
    await rs.advanceTimersByTimeAsync(0);

    expect(killSpy).toHaveBeenCalledWith(firstPid, 'SIGUSR2');
    expect(mocks.fork).toHaveBeenCalledTimes(1); // still just the original
  });
});

// ---------------------------------------------------------------------------
// Group E — build errors are ignored
// ---------------------------------------------------------------------------

describe('onAfterBuild — errors', () => {
  it('does not start anything when the build has errors', () => {
    const api = createFakeApi();
    pluginStartServer({ script: 'dist/server/index.js' }).setup(
      api as RsbuildPluginAPI,
    );

    onAfterBuildHandler(api)({ stats: { hasErrors: () => true } });

    expect(mocks.fork).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group F — onCloseBuild cleanup
// ---------------------------------------------------------------------------

describe('onCloseBuild', () => {
  it('kills the running child', () => {
    const killSpy = rs.spyOn(process, 'kill').mockImplementation(() => true);

    const api = createFakeApi();
    pluginStartServer({ script: 'dist/server/index.js' }).setup(
      api as RsbuildPluginAPI,
    );

    onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });
    const pid = forkResult(0).pid;

    onCloseBuildHandler(api)();

    expect(killSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
  });

  it('kills with SIGTERM (not SIGUSR2) on shutdown in reload mode', () => {
    const killSpy = rs.spyOn(process, 'kill').mockImplementation(() => true);

    const api = createFakeApi();
    pluginStartServer({ script: 'dist/server/index.js', signal: true }).setup(
      api as RsbuildPluginAPI,
    );

    onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });
    const pid = forkResult(0).pid;

    onCloseBuildHandler(api)();

    // A SIGUSR2 here would only reload the child, leaving an orphan process.
    expect(killSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(pid, 'SIGUSR2');
  });

  it('aborts a pending restart so nothing is forked after cleanup', async () => {
    rs.spyOn(process, 'kill').mockImplementation(() => true);
    rs.useFakeTimers();

    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      restartDebounceMs: 150,
    }).setup(api as RsbuildPluginAPI);

    const fire = () =>
      onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    fire(); // start
    fire(); // schedule restart (debounced)
    onCloseBuildHandler(api)(); // cleanup before the debounce fires

    await rs.advanceTimersByTimeAsync(1000);

    expect(mocks.fork).toHaveBeenCalledTimes(1);
  });

  it('removes its process signal listeners on cleanup', () => {
    rs.spyOn(process, 'kill').mockImplementation(() => true);

    const before = EXIT_SIGNALS.map((sig) => process.listenerCount(sig));

    const api = createFakeApi();
    pluginStartServer({ script: 'dist/server/index.js' }).setup(
      api as RsbuildPluginAPI,
    );

    // setup() adds exactly one listener per signal.
    EXIT_SIGNALS.forEach((sig, i) => {
      expect(process.listenerCount(sig)).toBe(before[i] + 1);
    });

    onCloseBuildHandler(api)();

    // cleanup() removes them again, so repeated runs don't leak.
    EXIT_SIGNALS.forEach((sig, i) => {
      expect(process.listenerCount(sig)).toBe(before[i]);
    });
  });
});

// ---------------------------------------------------------------------------
// Group G2 — restarts are serialized (no concurrent stop/start)
// ---------------------------------------------------------------------------

describe('restart serialization', () => {
  it('does not double-fork when a rebuild arrives while stopping', async () => {
    rs.spyOn(process, 'kill').mockImplementation(() => true);
    rs.useFakeTimers();

    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      restartDebounceMs: 0,
      killTimeoutMs: 1000,
    }).setup(api as RsbuildPluginAPI);

    const fire = () =>
      onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    fire(); // fork #1
    const first = forkResult(0);

    fire(); // restart A: enters stopServer, awaiting #1 exit
    await rs.advanceTimersByTimeAsync(0);

    fire(); // restart B arrives mid-stop -> must queue behind A
    await rs.advanceTimersByTimeAsync(0);

    // A is still waiting for #1 to exit; nothing new forked yet.
    expect(mocks.fork).toHaveBeenCalledTimes(1);

    // #1 exits -> A re-forks (#2). B must NOT also fire here (it would if both
    // restarts were listening on #1's exit concurrently).
    first.emit('exit', 0, null);
    await rs.advanceTimersByTimeAsync(0);
    expect(mocks.fork).toHaveBeenCalledTimes(2);

    // Only once #2 exits does the queued B restart re-fork (#3).
    forkResult(1).emit('exit', 0, null);
    await rs.advanceTimersByTimeAsync(0);
    expect(mocks.fork).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Group G — autoRestart disabled
// ---------------------------------------------------------------------------

describe('autoRestart: false', () => {
  it('keeps the running process across rebuilds', async () => {
    rs.useFakeTimers();
    const api = createFakeApi();
    pluginStartServer({
      script: 'dist/server/index.js',
      autoRestart: false,
    }).setup(api as RsbuildPluginAPI);

    const fire = () =>
      onAfterBuildHandler(api)({ stats: { hasErrors: () => false } });

    fire();
    fire();
    await rs.advanceTimersByTimeAsync(1000);

    expect(mocks.fork).toHaveBeenCalledTimes(1);
  });
});
