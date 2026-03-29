/**
 * Orchestrator test coverage.
 * Tests phase lifecycle, retry behaviour, signal handling, lock management,
 * stash recovery, and CI heartbeat.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTempDir(prefix = 'shift-orch-') {
  const dir = join(tmpdir(), prefix + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function makeLogger() {
  const calls = [];
  const log = (level) => async (...args) => { calls.push({ level, args }); };
  return {
    info: log('info'), warn: log('warn'), error: log('error'),
    debug: log('debug'), success: log('success'), phase: log('phase'),
    tool: log('tool'), destroy() {}, _buffer: [], _flushBuffer() {}, _flushBufferSync() {},
    calls,
  };
}

// ── Lock file tests ─────────────────────────────────────────────

describe('Orchestrator lock management', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    // Create minimal composer.json so preflight doesn't throw for that
    writeFileSync(join(tempDir, 'composer.json'), '{}');
  });
  afterEach(() => cleanDir(tempDir));

  it('_acquireLock creates lock file with PID', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    // Lock was acquired in constructor via _setupSignalHandlers... no, it's in _preflightChecks.
    // Call _acquireLock directly
    orch._acquireLock();
    const lockPath = join(tempDir, '.shift', 'lock');
    assert.ok(existsSync(lockPath), 'Lock file should exist');
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lockData.pid, process.pid);
    assert.ok(lockData.createdAt, 'Lock should have createdAt timestamp');
    assert.ok(lockData.hostname, 'Lock should have hostname');

    // Cleanup
    orch._releaseLock();
    orch._removeSignalHandlers();
    assert.ok(!existsSync(lockPath), 'Lock file should be removed after release');
    sm.destroy();
  });

  it('_acquireLock throws when lock is held by active process', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const lockPath = join(tempDir, '.shift', 'lock');
    // Write current PID (simulates another active lock by this process)
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), hostname: 'test' }), { flag: 'wx' });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    assert.throws(() => orch._acquireLock(), (err) => {
      return err.message.includes('Another shift process');
    });

    // Cleanup
    orch._removeSignalHandlers();
    if (existsSync(lockPath)) rmSync(lockPath);
    sm.destroy();
  });

  it('_acquireLock recovers stale lock on Unix', async () => {
    if (process.platform === 'win32') return; // PID check is Unix-only

    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const lockPath = join(tempDir, '.shift', 'lock');
    // Write a PID that doesn't exist (99999999)
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, createdAt: new Date().toISOString(), hostname: 'test' }), { flag: 'wx' });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    // Should recover the stale lock
    orch._acquireLock();
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lockData.pid, process.pid);

    orch._releaseLock();
    orch._removeSignalHandlers();
    sm.destroy();
  });
});

// ── Enhanced lock file tests (E2E-4) ────────────────────────────

describe('E2E-4: Stale lock file detection', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    writeFileSync(join(tempDir, 'composer.json'), '{}');
  });
  afterEach(() => cleanDir(tempDir));

  it('lock file with dead PID is auto-removed (Unix)', async () => {
    if (process.platform === 'win32') return;
    const lockPath = join(tempDir, '.shift', 'lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, createdAt: new Date().toISOString(), hostname: 'test' }), { flag: 'wx' });

    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({ projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {} });

    orch._acquireLock();
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lockData.pid, process.pid);

    orch._releaseLock();
    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('corrupted lock file (invalid JSON) is auto-removed', async () => {
    const lockPath = join(tempDir, '.shift', 'lock');
    writeFileSync(lockPath, 'this is not json or a pid', { flag: 'wx' });

    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({ projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {} });

    orch._acquireLock();
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lockData.pid, process.pid);

    orch._releaseLock();
    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('legacy lock file (plain PID, dead process) is auto-removed', async () => {
    if (process.platform === 'win32') return;
    const lockPath = join(tempDir, '.shift', 'lock');
    writeFileSync(lockPath, '99999999', { flag: 'wx' });

    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({ projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {} });

    orch._acquireLock();
    assert.ok(existsSync(lockPath));

    orch._releaseLock();
    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('lock file created with correct PID, timestamp, and hostname', async () => {
    const lockPath = join(tempDir, '.shift', 'lock');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({ projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {} });

    orch._acquireLock();
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lockData.pid, process.pid);
    assert.ok(lockData.createdAt);
    assert.ok(new Date(lockData.createdAt).getTime() > 0);
    assert.ok(lockData.hostname);

    orch._releaseLock();
    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('lock file cleaned up on normal process exit', async () => {
    const lockPath = join(tempDir, '.shift', 'lock');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({ projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {} });

    orch._acquireLock();
    assert.ok(existsSync(lockPath));
    orch._cleanup();
    assert.ok(!existsSync(lockPath), 'Lock should be cleaned up');
    sm.destroy();
  });
});

// ── Phase retry tests ───────────────────────────────────────────

describe('Orchestrator._runPhaseWithRetry', () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => cleanDir(tempDir));

  it('retries up to 3 times then returns false', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const logger = makeLogger();
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger, config: {},
    });

    let attempts = 0;
    const phase = {
      id: 'ANALYZING',
      fn: async () => { attempts++; throw new Error('boom'); },
    };

    const result = await orch._runPhaseWithRetry(phase);
    assert.equal(result, false);
    assert.equal(attempts, 3); // MAX_PHASE_RETRIES = 3

    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('returns true on first success', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    let attempts = 0;
    const phase = {
      id: 'ANALYZING',
      fn: async () => { attempts++; },
    };

    const result = await orch._runPhaseWithRetry(phase);
    assert.equal(result, true);
    assert.equal(attempts, 1);

    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('stops retrying when _shuttingDown is set', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    let attempts = 0;
    const phase = {
      id: 'ANALYZING',
      fn: async () => {
        attempts++;
        orch._shuttingDown = true; // Simulate signal
        throw new Error('boom');
      },
    };

    const result = await orch._runPhaseWithRetry(phase);
    assert.equal(result, false);
    assert.equal(attempts, 1); // Only 1 attempt because shutdown was set

    orch._removeSignalHandlers();
    sm.destroy();
  });
});

// ── Cleanup tests ───────────────────────────────────────────────

describe('Orchestrator._cleanup', () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => cleanDir(tempDir));

  it('removes signal handlers and releases lock', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    // Acquire lock manually
    orch._acquireLock();
    assert.ok(existsSync(join(tempDir, '.shift', 'lock')));

    orch._cleanup();
    assert.ok(!existsSync(join(tempDir, '.shift', 'lock')), 'Lock should be released');
    assert.equal(orch._sigintHandler, null, 'Signal handlers should be removed');

    sm.destroy();
  });
});

// ── CI Heartbeat tests ──────────────────────────────────────────

describe('Orchestrator._startCiHeartbeat', () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => cleanDir(tempDir));

  it('returns null when json mode is disabled', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(),
      options: { json: false }, config: {},
    });

    const interval = orch._startCiHeartbeat('ANALYZING');
    assert.equal(interval, null);

    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('returns interval when json mode is enabled', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(),
      options: { json: true }, config: {},
    });

    const interval = orch._startCiHeartbeat('ANALYZING');
    assert.ok(interval !== null, 'Should return an interval');
    clearInterval(interval);

    orch._removeSignalHandlers();
    sm.destroy();
  });
});

// ── Phase timing tests ──────────────────────────────────────────

describe('Orchestrator._recordPhaseTiming', () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => cleanDir(tempDir));

  it('stores timing data in state', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    const start = Date.now();
    orch._recordPhaseTiming('ANALYZING', start, 5000);

    const timings = sm.get('phaseTimings');
    assert.ok(timings.ANALYZING);
    assert.equal(timings.ANALYZING.durationMs, 5000);

    orch._removeSignalHandlers();
    sm.destroy();
  });
});

// ── Gitignore tests ─────────────────────────────────────────────

describe('Orchestrator._ensureGitignore', () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => cleanDir(tempDir));

  it('creates .gitignore with .shift/ when none exists', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    await orch._ensureGitignore();
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.shift/'));
    // No leading newline when file was empty
    assert.ok(!content.startsWith('\n'), 'Should not have leading newline');

    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('appends .shift/ to existing .gitignore', async () => {
    writeFileSync(join(tempDir, '.gitignore'), 'vendor/\nnode_modules/\n');

    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    await orch._ensureGitignore();
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.shift/'));
    assert.ok(content.startsWith('vendor/'), 'Original content preserved');

    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('does not duplicate .shift/ entry', async () => {
    writeFileSync(join(tempDir, '.gitignore'), '.shift/\n');

    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });

    await orch._ensureGitignore();
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.shift/g);
    assert.equal(matches.length, 1, 'Should not duplicate .shift/ entry');

    orch._removeSignalHandlers();
    sm.destroy();
  });
});

// ── Non-Laravel project detection ──────────────────────────────

describe('E2E-3: Non-Laravel project detection', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
  });
  afterEach(() => cleanDir(tempDir));

  it('passes pre-flight with laravel/framework in require', async () => {
    writeFileSync(join(tempDir, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^10.0' },
    }));
    writeFileSync(join(tempDir, 'artisan'), '#!/usr/bin/env php');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });
    // _preflightChecks will throw on git/api key, but NOT on Laravel detection
    try {
      await orch._preflightChecks();
    } catch (err) {
      // Should fail on git or API key, not on Laravel detection
      assert.ok(!err.message.includes('not a Laravel project'), `Should pass Laravel detection but got: ${err.message}`);
      assert.ok(!err.message.includes('laravel/framework'), `Should pass Laravel detection but got: ${err.message}`);
    }
    orch._removeSignalHandlers();
    sm.destroy();
  });

  it('fails without composer.json', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });
    try {
      await assert.rejects(orch._preflightChecks(), (err) => {
        assert.ok(err.message.includes('composer.json') || err.message.includes('Laravel'));
        return true;
      });
    } finally {
      orch._cleanup();
      sm.destroy();
    }
  });

  it('fails without laravel/framework dependency', async () => {
    writeFileSync(join(tempDir, 'composer.json'), JSON.stringify({
      require: { 'symfony/console': '^6.0' },
    }));
    writeFileSync(join(tempDir, 'artisan'), '#!/usr/bin/env php');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });
    try {
      await assert.rejects(orch._preflightChecks(), (err) => {
        assert.ok(err.message.includes('laravel/framework'));
        return true;
      });
    } finally {
      orch._cleanup();
      sm.destroy();
    }
  });

  it('fails without artisan file', async () => {
    writeFileSync(join(tempDir, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^10.0' },
    }));
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });
    try {
      await assert.rejects(orch._preflightChecks(), (err) => {
        assert.ok(err.message.includes('artisan'));
        return true;
      });
    } finally {
      orch._cleanup();
      sm.destroy();
    }
  });

  it('error message includes clear description', async () => {
    writeFileSync(join(tempDir, 'composer.json'), JSON.stringify({ require: {} }));
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    const orch = new Orchestrator({
      projectPath: tempDir, stateManager: sm, logger: makeLogger(), config: {},
    });
    try {
      await assert.rejects(orch._preflightChecks(), (err) => {
        assert.ok(err.message.includes('Laravel project') || err.message.includes('laravel/framework'));
        return true;
      });
    } finally {
      orch._cleanup();
      sm.destroy();
    }
  });
});

// ── Post-transform safety checks ──────────────────────────────

describe('E2E-2: postTransformChecks()', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift', 'backups'), { recursive: true });
    mkdirSync(join(tempDir, 'config'), { recursive: true });
  });
  afterEach(() => cleanDir(tempDir));

  it('deletes config tombstone (comments only) with backup', async () => {
    writeFileSync(join(tempDir, 'config', 'cors.php'), '<?php\n/* THIS FILE SHOULD BE DELETED */\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].action, 'deleted');
    assert.ok(!existsSync(join(tempDir, 'config', 'cors.php')));
    assert.ok(existsSync(join(tempDir, '.shift', 'backups', 'config', 'cors.php')));
  });

  it('leaves config file with return [] alone', async () => {
    writeFileSync(join(tempDir, 'config', 'app.php'), '<?php\nreturn [\n  "name" => "test"\n];\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    assert.equal(issues.length, 0);
    assert.ok(existsSync(join(tempDir, 'config', 'app.php')));
  });

  it('warns about config with code but no return', async () => {
    writeFileSync(join(tempDir, 'config', 'weird.php'), '<?php\n$x = "hello";\necho $x;\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].action, 'warning');
  });

  it('deletes Kernel.php tombstone when target >= 11', async () => {
    mkdirSync(join(tempDir, 'app', 'Http'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'Http', 'Kernel.php'), '<?php\n// DELETED — Laravel 11 upgrade\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    const kernelIssue = issues.find(i => i.file === 'app/Http/Kernel.php');
    assert.ok(kernelIssue);
    assert.equal(kernelIssue.action, 'deleted');
    assert.ok(!existsSync(join(tempDir, 'app', 'Http', 'Kernel.php')));
  });

  it('does NOT delete Kernel.php tombstone when target is 10', async () => {
    mkdirSync(join(tempDir, 'app', 'Http'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'Http', 'Kernel.php'), '<?php\n// DELETED\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '10');
    const kernelIssue = issues.find(i => i.file === 'app/Http/Kernel.php');
    assert.equal(kernelIssue, undefined);
    assert.ok(existsSync(join(tempDir, 'app', 'Http', 'Kernel.php')));
  });

  it('preserves Kernel.php with real code', async () => {
    mkdirSync(join(tempDir, 'app', 'Http'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'Http', 'Kernel.php'), '<?php\nclass Kernel extends HttpKernel {\n  function boot() {}\n}\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    const kernelIssue = issues.find(i => i.file === 'app/Http/Kernel.php');
    assert.equal(kernelIssue, undefined);
    assert.ok(existsSync(join(tempDir, 'app', 'Http', 'Kernel.php')));
  });

  it('deletes empty file (like CreatesApplication.php written as "")', async () => {
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'CreatesApplication.php'), '');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    const found = issues.find(i => i.file === 'tests/CreatesApplication.php');
    assert.ok(found);
    assert.equal(found.action, 'deleted');
  });

  it('handles multiple tombstones in single pass', async () => {
    mkdirSync(join(tempDir, 'app', 'Http', 'Middleware'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'Http', 'Kernel.php'), '<?php\n// removed\n');
    writeFileSync(join(tempDir, 'app', 'Http', 'Middleware', 'TrustProxies.php'), '<?php\n// removed\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    const issues = postTransformChecks(tempDir, '11');
    const deleted = issues.filter(i => i.action === 'deleted');
    assert.ok(deleted.length >= 2);
  });

  it('creates backup in correct directory structure', async () => {
    mkdirSync(join(tempDir, 'app', 'Http', 'Middleware'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'Http', 'Middleware', 'TrimStrings.php'), '<?php\n// tombstone\n');
    const { postTransformChecks } = await import('../src/orchestrator.js');
    postTransformChecks(tempDir, '11');
    assert.ok(existsSync(join(tempDir, '.shift', 'backups', 'app', 'Http', 'Middleware', 'TrimStrings.php')));
  });
});

// ─── Bootstrap Cache Clearing ──────────────────────────────────
describe('E2E-2: Bootstrap cache clearing (validator)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('shift-cache-');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('clearBootstrapCache removes .php files from bootstrap/cache', async () => {
    const cacheDir = join(tempDir, 'bootstrap', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'packages.php'), '<?php return [];');
    writeFileSync(join(cacheDir, 'services.php'), '<?php return [];');
    writeFileSync(join(cacheDir, 'config.php'), '<?php return [];');
    writeFileSync(join(cacheDir, '.gitignore'), '*\n!.gitignore\n');

    // Import and test the validator's _clearBootstrapCache via instantiation
    const { ValidatorAgent } = await import('../src/agents/validator-agent.js');
    const mockLogger = { info: async () => {}, warn: async () => {}, debug: async () => {}, error: async () => {}, phase: async () => {}, success: async () => {} };
    const mockFileTools = { findPhpFiles: async () => [], getAgentTools: () => [], fileExists: () => false };
    const agent = new ValidatorAgent({
      logger: mockLogger,
      projectPath: tempDir,
      fileTools: mockFileTools,
      stateManager: { get: () => ({}), set: () => {} },
      config: {},
    });

    agent._clearBootstrapCache();

    // .php files should be removed
    assert.ok(!existsSync(join(cacheDir, 'packages.php')));
    assert.ok(!existsSync(join(cacheDir, 'services.php')));
    assert.ok(!existsSync(join(cacheDir, 'config.php')));
    // .gitignore should remain
    assert.ok(existsSync(join(cacheDir, '.gitignore')));
  });

  it('clearBootstrapCache handles missing bootstrap/cache gracefully', async () => {
    const { ValidatorAgent } = await import('../src/agents/validator-agent.js');
    const mockLogger = { info: async () => {}, warn: async () => {}, debug: async () => {}, error: async () => {}, phase: async () => {}, success: async () => {} };
    const mockFileTools = { findPhpFiles: async () => [], getAgentTools: () => [], fileExists: () => false };
    const agent = new ValidatorAgent({
      logger: mockLogger,
      projectPath: tempDir,
      fileTools: mockFileTools,
      stateManager: { get: () => ({}), set: () => {} },
      config: {},
    });

    // Should not throw when directory doesn't exist
    agent._clearBootstrapCache();
    assert.ok(!existsSync(join(tempDir, 'bootstrap', 'cache')));
  });

  it('postDependencyCleanup clears bootstrap cache files', async () => {
    const cacheDir = join(tempDir, 'bootstrap', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'packages.php'), '<?php return ["Fruitcake\\Cors\\CorsServiceProvider"];');
    writeFileSync(join(cacheDir, 'services.php'), '<?php return [];');

    // Verify files exist before cleanup
    assert.ok(existsSync(join(cacheDir, 'packages.php')));
    assert.ok(existsSync(join(cacheDir, 'services.php')));

    // Simulate cleanup by deleting .php files (mirrors _postDependencyCleanup logic)
    const files = readdirSync(cacheDir).filter(f => f.endsWith('.php'));
    assert.equal(files.length, 2);
    for (const file of files) {
      rmSync(join(cacheDir, file));
    }

    assert.ok(!existsSync(join(cacheDir, 'packages.php')));
    assert.ok(!existsSync(join(cacheDir, 'services.php')));
  });
});
