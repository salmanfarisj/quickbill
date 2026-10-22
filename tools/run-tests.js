#!/usr/bin/env node
// QuickBill — test runner.
//
// better-sqlite3 is rebuilt against Electron's Node ABI (125) by the
// `postinstall` hook. Running scripts with the system Node (ABI 137)
// produces a noisy `NODE_MODULE_VERSION` mismatch error. To keep the
// smoke tests deterministic, this launcher re-execs each test file
// under Electron with `ELECTRON_RUN_AS_NODE=1`, which makes Electron
// behave as a plain Node runtime while still loading the prebuilt
// native module.
//
// Usage:
//   node tools/run-tests.js           # run every phase we know about
//   node tools/run-tests.js phase4    # Phase 4 sales ledger smoke test
//   node tools/run-tests.js phase5    # Phase 5 receipts / reports

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const PHASES = {
  phase4: 'tools/test-phase4-sales.js',
  phase5: 'tools/test-phase5-reports.js',
  demo:   'tools/test-demo-sales.js'
};

function resolveElectronBin() {
  // `electron` is installed under node_modules/.bin. Resolve via
  // `require.resolve` so the test runner doesn't depend on $PATH.
  try {
    const electronPath = require.resolve('electron/cli.js');
    // cli.js exports the binary path as argv when required on some
    // installs. Fall back to the conventional bin path otherwise.
    return electronPath;
  } catch (_e) {
    return path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
  }
}

function launchElectronAsNode(scriptPath) {
  const electronBin = require('electron');
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  const result = spawnSync(electronBin, [scriptPath], {
    stdio: 'inherit',
    env,
    cwd: REPO_ROOT
  });
  return result.status ?? 1;
}

function runPhase(name) {
  const relative = PHASES[name];
  if (!relative) {
    console.error(`Unknown phase: ${name}. Available: ${Object.keys(PHASES).join(', ')}`);
    process.exit(2);
  }
  const scriptPath = path.join(REPO_ROOT, relative);
  if (!require('node:fs').existsSync(scriptPath)) {
    console.error(`Test script not found: ${relative}`);
    process.exit(2);
  }
  console.log(`\n── running ${name}: ${relative} ──`);
  const code = launchElectronAsNode(scriptPath);
  if (code !== 0) {
    console.error(`✗ ${name} exited with status ${code}`);
    process.exit(code);
  }
  console.log(`✓ ${name} passed`);
}

function main() {
  const requested = process.argv.slice(2);
  const phases = requested.length === 0 ? Object.keys(PHASES) : requested;
  let failed = false;
  for (const phase of phases) {
    try {
      runPhase(phase);
    } catch (err) {
      console.error(`✗ ${phase} threw:`, err && err.message ? err.message : err);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log('\nAll requested test phases passed.');
}

main();
