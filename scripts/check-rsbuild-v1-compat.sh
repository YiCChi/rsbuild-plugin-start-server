#!/usr/bin/env bash
# Smoke-test the packed plugin against an Rsbuild 1.x consumer.
#
# The plugin is built with Rsbuild 2 (via Rslib) but declares
# `@rsbuild/core >=1.5.0` as a peer. This script packs `plugin/`, installs the
# tarball into a throwaway project that depends on the requested Rsbuild 1.x
# version, runs `rsbuild build --watch`, and asserts that:
#   1. the plugin forks the built script (a marker file appears), and
#   2. SIGINT to Rsbuild cleans the child up (no orphaned process).
#
# Usage: scripts/check-rsbuild-v1-compat.sh <rsbuild-version-or-dist-tag>
#   e.g. scripts/check-rsbuild-v1-compat.sh 1.5.0
#        scripts/check-rsbuild-v1-compat.sh latest-v1
#
# Expects `pnpm install` to have run and `plugin/dist` to be built.
set -euo pipefail

RSBUILD_VERSION="${1:?usage: $0 <rsbuild-version-or-dist-tag>}"
START_TIMEOUT_S="${START_TIMEOUT_S:-30}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill "${RSBUILD_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

echo "==> packing plugin"
TGZ="$(cd "$ROOT/plugin" && pnpm pack --pack-destination "$WORK" | tail -1)"
[[ -f "$TGZ" ]] || { echo "pack failed: $TGZ"; exit 1; }

echo "==> creating consumer project on @rsbuild/core@$RSBUILD_VERSION in $WORK"
mkdir -p "$WORK/app/src"
cd "$WORK/app"

# Reuse the repo's pnpm pin so pnpm does not try to resolve "latest".
PM="$(node -p 'require(process.argv[1]).packageManager' "$ROOT/package.json")"
node - "$RSBUILD_VERSION" "$TGZ" "$PM" <<'JS'
const [version, tgz, packageManager] = process.argv.slice(2);
require('node:fs').writeFileSync(
  'package.json',
  JSON.stringify(
    {
      name: 'rsbuild-v1-compat',
      private: true,
      type: 'module',
      packageManager,
      devDependencies: {
        '@rsbuild/core': version,
        'rsbuild-plugin-start-server': `file:${tgz}`,
      },
    },
    null,
    2,
  ),
);
JS

# Standalone workspace so the repo's minimumReleaseAge / catalog do not apply.
cat > pnpm-workspace.yaml <<'YAML'
minimumReleaseAge: 0
allowBuilds:
  core-js: false
YAML

# The child records its pid so we can prove it started and was cleaned up.
cat > src/index.ts <<'TS'
import { writeFileSync } from 'node:fs';
writeFileSync('started.txt', String(process.pid));
setInterval(() => {}, 60_000);
TS

cat > rsbuild.config.mjs <<'MJS'
import { defineConfig } from '@rsbuild/core';
import { pluginStartServer } from 'rsbuild-plugin-start-server';

export default defineConfig({
  plugins: [pluginStartServer({ script: 'dist/index.js', manualRestart: false })],
  output: { target: 'node', module: true },
});
MJS

pnpm install --silent

INSTALLED="$(node -p 'require("@rsbuild/core/package.json").version')"
echo "==> installed @rsbuild/core@$INSTALLED"
[[ "$INSTALLED" == 1.* ]] || { echo "expected an Rsbuild 1.x version, got $INSTALLED"; exit 1; }

echo "==> rsbuild build --watch"
# Invoke the CLI entry directly rather than through `pnpm exec`: the wrapper
# process does not forward a scripted SIGINT, so Rsbuild (and the plugin's
# cleanup) would never see it.
node node_modules/@rsbuild/core/bin/rsbuild.js build --watch >rsbuild.log 2>&1 &
RSBUILD_PID=$!

for ((i = 0; i < START_TIMEOUT_S * 10; i++)); do
  [[ -s started.txt ]] && break
  if ! kill -0 "$RSBUILD_PID" 2>/dev/null; then
    echo "rsbuild exited before the child started:"; cat rsbuild.log; exit 1
  fi
  sleep 0.1
done
if [[ ! -s started.txt ]]; then
  echo "child did not start within ${START_TIMEOUT_S}s:"; cat rsbuild.log; exit 1
fi
CHILD_PID="$(cat started.txt)"
echo "==> child started (pid $CHILD_PID)"

grep -q "Run .*dist/index.js" rsbuild.log || { echo "plugin did not log the fork:"; cat rsbuild.log; exit 1; }

echo "==> SIGINT rsbuild, expecting the child to be cleaned up"
kill -INT "$RSBUILD_PID"
wait "$RSBUILD_PID" || true
RSBUILD_PID=""

for ((i = 0; i < 50; i++)); do
  kill -0 "$CHILD_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$CHILD_PID" 2>/dev/null; then
  echo "child $CHILD_PID is still alive after rsbuild exited:"; cat rsbuild.log
  kill -KILL "$CHILD_PID" 2>/dev/null || true
  exit 1
fi

echo "==> OK: plugin works on @rsbuild/core@$INSTALLED"
cat rsbuild.log
