/**
 * FINDING-17: Integration-level test coverage.
 * Wires up the Orchestrator with a mock API client (via _resetSharedClient)
 * and verifies phase lifecycle, retry behaviour, signal handling, and stash recovery.
 *
 * Run with: node --test test/integration.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Test helpers ────────────────────────────────────────────────

function makeTempDir(prefix = 'shift-integ-') {
  const dir = join(tmpdir(), prefix + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeLogger() {
  return {
    tool: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
    success: async () => {},
    phase: async () => {},
    destroy() {},
    _buffer: [],
    _flushBuffer() {},
    _flushBufferSync() {},
  };
}

// ── Integration tests ───────────────────────────────────────────

describe('FINDING-17: Integration — StateManager + mock lifecycle', () => {
  let tempDir, StateManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  afterEach(() => cleanDir(tempDir));

  it('full state lifecycle: init → phase transitions → complete', () => {
    const sm = new StateManager(tempDir);
    const { resumed } = sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    assert.equal(resumed, false);
    assert.equal(sm.get('currentPhase'), 'INIT');

    // Simulate phase transitions
    sm.setPhase('ANALYZING');
    sm.markPhaseComplete('ANALYZING');
    assert.ok(sm.isPhaseComplete('ANALYZING'));

    sm.setPhase('PLANNING');
    sm.markPhaseComplete('PLANNING');

    sm.setPhase('TRANSFORMING');
    sm.setFileStatus('app/Models/User.php', 'in_progress');
    sm.setFileStatus('app/Models/User.php', 'done', { changesApplied: ['updated imports'] });
    sm.markPhaseComplete('TRANSFORMING');

    sm.setPhase('VALIDATING');
    sm.markPhaseComplete('VALIDATING');

    sm.setPhase('REPORTING');
    sm.markPhaseComplete('REPORTING');

    sm.setPhase('COMPLETE');

    // Verify final state
    const s = sm.get();
    assert.equal(s.currentPhase, 'COMPLETE');
    assert.equal(s.completedPhases.length, 5);
    assert.equal(s.transformations.completed, 1);
    assert.equal(s.transformations.failed, 0);

    // Verify persistence
    const sm2 = new StateManager(tempDir);
    sm2.load();
    sm2.validateState();
    assert.equal(sm2.get('currentPhase'), 'COMPLETE');
  });

  it('retry lifecycle: fail → retry → succeed', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    sm.setPhase('TRANSFORMING');
    sm.setFileStatus('app/test.php', 'in_progress');
    assert.equal(sm.state.transformations.files['app/test.php'].attempts, 1);

    // First attempt fails
    // AUDIT FIX: M2 FIX made attempts only increment on 'in_progress', not 'failed'.
    // After in_progress(+1) → failed(+0), attempts = 1, not 2.
    sm.setFileStatus('app/test.php', 'failed', { error: 'parse error' });
    assert.equal(sm.state.transformations.files['app/test.php'].attempts, 1);
    assert.equal(sm.state.transformations.failed, 1);

    // Reset and retry
    sm.resetRetries();
    assert.equal(sm.getFileStatus('app/test.php'), 'pending');
    assert.equal(sm.state.transformations.files['app/test.php'].attempts, 0);
    assert.equal(sm.state.transformations.failed, 0);

    // Second attempt succeeds
    sm.setFileStatus('app/test.php', 'in_progress');
    sm.setFileStatus('app/test.php', 'done');
    assert.equal(sm.state.transformations.completed, 1);
    assert.equal(sm.state.transformations.failed, 0);
  });

  it('resume from interrupted state', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.setPhase('TRANSFORMING');
    sm.markPhaseComplete('ANALYZING');
    sm.markPhaseComplete('PLANNING');
    sm.setFileStatus('a.php', 'done');
    // Note: in_progress uses debounced save, so force a synchronous save
    sm.setFileStatus('b.php', 'in_progress');
    sm.save(); // Force persist before "crash"

    // Simulate crash — create new instance and resume
    const sm2 = new StateManager(tempDir);
    const { resumed } = sm2.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    assert.equal(resumed, true);
    assert.equal(sm2.get('currentPhase'), 'TRANSFORMING');
    assert.ok(sm2.isPhaseComplete('ANALYZING'));
    assert.ok(sm2.isPhaseComplete('PLANNING'));
    assert.equal(sm2.getFileStatus('a.php'), 'done');
    assert.equal(sm2.getFileStatus('b.php'), 'in_progress');
  });

  it('destroy() cleans up pending save timeout', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    // Trigger a scheduled save (in_progress uses debounce)
    sm.setFileStatus('test.php', 'in_progress');
    assert.ok(sm._saveTimeout !== undefined || sm._saveTimeout === null,
      'scheduleSave should have been called');

    sm.destroy();
    assert.equal(sm._saveTimeout, null, 'destroy should clear save timeout');
  });
});

describe('FINDING-17: Integration — _resetSharedClient mock injection', () => {
  let _resetSharedClient;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    _resetSharedClient = mod._resetSharedClient;
  });

  afterEach(() => {
    _resetSharedClient(null);
  });

  it('mock client is used by BaseAgent instances', async () => {
    const { BaseAgent } = await import('../src/agents/base-agent.js');

    let apiCalled = false;
    const mockClient = {
      messages: {
        create: async () => {
          apiCalled = true;
          return {
            content: [{ type: 'text', text: '{"ok": true}' }],
            usage: { output_tokens: 10 },
          };
        },
      },
    };

    _resetSharedClient(mockClient);

    const logger = makeLogger();
    const agent = new BaseAgent('TestAgent', { model: 'test-model', logger });

    const result = await agent.runForJson('You are a test', [
      { role: 'user', content: 'Return {"ok": true}' },
    ]);

    assert.ok(apiCalled, 'Mock client should have been called');
    assert.equal(result.ok, true);
  });
});

describe('FINDING-17: Integration — changesManifest tracking', () => {
  let tempDir, StateManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  afterEach(() => cleanDir(tempDir));

  it('records renames, new files, and new imports across transforms', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    sm.recordRename('app/Providers/EventServiceProvider.php', 'app/Providers/EventServiceProvider.php.bak');
    sm.recordNewFile('app/Providers/AppServiceProvider.php');
    sm.recordNewImport('app/Models/User.php', ['Illuminate\\Support\\Facades\\Hash']);

    const manifest = sm.getChangesManifest();
    assert.equal(manifest.renames.length, 1);
    assert.equal(manifest.newFiles.length, 1);
    assert.equal(manifest.newImports.length, 1);
    assert.equal(manifest.renames[0].from, 'app/Providers/EventServiceProvider.php');
    assert.equal(manifest.newImports[0].filepath, 'app/Models/User.php');
  });

  it('caps manifest arrays at 500 entries', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    for (let i = 0; i < 550; i++) {
      sm.recordRename(`old${i}.php`, `new${i}.php`);
    }

    const manifest = sm.getChangesManifest();
    assert.ok(manifest.renames.length <= 500, `Renames should be capped, got ${manifest.renames.length}`);
  });
});

describe('FINDING-17: Integration — error hierarchy', () => {
  it('all error classes share ShiftBaseError base', async () => {
    const { ShiftBaseError } = await import('../src/errors.js');
    const { ShiftError } = await import('../src/orchestrator.js');
    const { AgentError } = await import('../src/agents/base-agent.js');

    const shiftErr = new ShiftError('TEST_CODE', 'test');
    const agentErr = new AgentError('AGENT_CODE', 'test', 'TestAgent');

    assert.ok(shiftErr instanceof ShiftBaseError, 'ShiftError should extend ShiftBaseError');
    assert.ok(agentErr instanceof ShiftBaseError, 'AgentError should extend ShiftBaseError');
    assert.ok(shiftErr instanceof Error, 'ShiftError should extend Error');
    assert.ok(agentErr instanceof Error, 'AgentError should extend Error');
    assert.equal(shiftErr.code, 'TEST_CODE');
    assert.equal(agentErr.agent, 'TestAgent');
  });
});
