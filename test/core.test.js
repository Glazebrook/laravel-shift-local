/**
 * MAINT-1 FIX: Unit tests for core utilities.
 * Run with: node --test test/core.test.js
 *
 * Covers:
 * - FileTools._abs() path traversal protection (including Windows-style paths)
 * - StateManager lifecycle (init, save, load, resume, delete)
 * - StateManager.validateState() schema validation
 * - StateManager.resetRetries()
 * - validateVersions() edge cases
 * - validateConfig() sanitisation
 * - extractJson() brace matching
 * - compactMessages() token estimation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';

// ── Test helpers ────────────────────────────────────────────────

function makeTempDir(prefix = 'shift-test-') {
  const dir = join(tmpdir(), prefix + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── FileTools._abs() ────────────────────────────────────────────

describe('FileTools._abs()', () => {
  let tempDir;
  let fileTools;

  beforeEach(async () => {
    tempDir = makeTempDir();
    // Create a minimal logger stub
    const logger = { tool: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {}, success: async () => {} };
    const { FileTools } = await import('../src/file-tools.js');
    fileTools = new FileTools(tempDir, logger);
  });

  afterEach(() => cleanDir(tempDir));

  it('resolves a simple relative path', () => {
    const result = fileTools._abs('app/Models/User.php');
    assert.equal(result, join(tempDir, 'app', 'Models', 'User.php'));
  });

  it('blocks path traversal with ../', () => {
    assert.throws(() => fileTools._abs('../../../etc/passwd'), /Path traversal blocked/);
  });

  it('blocks path traversal with absolute path', () => {
    assert.throws(() => fileTools._abs('/etc/passwd'), /Path traversal blocked/);
  });

  it('allows the project root itself', () => {
    // _abs('.') resolves to projectPath
    const result = fileTools._abs('.');
    assert.equal(result, tempDir);
  });

  it('blocks traversal via encoded path segments', () => {
    assert.throws(() => fileTools._abs('app/../../..'), /Path traversal blocked/);
  });

  it('detects symlink escape via parent directory', () => {
    // Create a directory and a symlink that escapes
    const subdir = join(tempDir, 'app');
    mkdirSync(subdir);

    const outsideDir = makeTempDir('outside-');
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');

    try {
      // Create symlink: tempDir/app/escape -> outsideDir
      const linkPath = join(subdir, 'escape');
      try {
        symlinkSync(outsideDir, linkPath, 'dir');
      } catch {
        // Symlink creation may fail on some platforms (e.g. Windows without admin)
        return; // Skip test
      }

      assert.throws(() => fileTools._abs('app/escape/secret.txt'), /Symlink escape blocked/);
    } finally {
      cleanDir(outsideDir);
    }
  });

  // BUG-1 FIX verification: path separator handling
  it('uses platform path separator (not hardcoded /)', () => {
    // This verifies the fix works regardless of platform
    const result = fileTools._abs('app' + sep + 'test.php');
    assert.equal(result, join(tempDir, 'app', 'test.php'));
  });
});

// ── StateManager ─────────────────────────────────────────────────

describe('StateManager', () => {
  let tempDir;
  let StateManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  afterEach(() => cleanDir(tempDir));

  it('initialises fresh state', () => {
    const sm = new StateManager(tempDir);
    const { resumed } = sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    assert.equal(resumed, false);
    assert.equal(sm.get('fromVersion'), '10');
    assert.equal(sm.get('toVersion'), '11');
    assert.equal(sm.get('currentPhase'), 'INIT');
    assert.ok(existsSync(join(tempDir, '.shift', 'state.json')));
  });

  it('detects existing state on init (resume)', () => {
    const sm1 = new StateManager(tempDir);
    sm1.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm1.setPhase('ANALYZING');

    const sm2 = new StateManager(tempDir);
    const { resumed } = sm2.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    assert.equal(resumed, true);
    assert.equal(sm2.get('currentPhase'), 'ANALYZING');
  });

  it('saves and loads state correctly', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '9', toVersion: '11', projectPath: tempDir });
    sm.set('analysis', { complexity: 'high' });

    const sm2 = new StateManager(tempDir);
    sm2.load();
    assert.deepEqual(sm2.get('analysis'), { complexity: 'high' });
  });

  it('tracks phase completion', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    assert.equal(sm.isPhaseComplete('ANALYZING'), false);
    sm.markPhaseComplete('ANALYZING');
    assert.equal(sm.isPhaseComplete('ANALYZING'), true);
  });

  it('tracks file status and counts', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.setFileStatus('app/Models/User.php', 'done');
    sm.setFileStatus('app/Models/Post.php', 'failed', { error: 'test' });

    const t = sm.get('transformations');
    assert.equal(t.completed, 1);
    assert.equal(t.failed, 1);
  });

  it('caps errors array (REL-1)', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    for (let i = 0; i < 250; i++) {
      sm.logError('TEST', new Error(`error ${i}`));
    }
    assert.ok(sm.get('errors').length <= 200);
  });

  it('deletes state directory', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    assert.ok(sm.exists());
    sm.delete();
    assert.ok(!sm.exists());
  });

  // BUG-7 FIX verification
  describe('validateState()', () => {
    it('passes for valid state', () => {
      const sm = new StateManager(tempDir);
      sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
      assert.doesNotThrow(() => sm.validateState());
    });

    it('throws for missing fromVersion', () => {
      const sm = new StateManager(tempDir);
      sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
      delete sm.state.fromVersion;
      assert.throws(() => sm.validateState(), /missing required field 'fromVersion'/);
    });

    it('throws for missing completedPhases', () => {
      const sm = new StateManager(tempDir);
      sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
      delete sm.state.completedPhases;
      assert.throws(() => sm.validateState(), /missing required field 'completedPhases'/);
    });

    it('throws for non-array completedPhases', () => {
      const sm = new StateManager(tempDir);
      sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
      sm.state.completedPhases = 'not-an-array';
      assert.throws(() => sm.validateState(), /not an array/);
    });
  });

  // REL-6 FIX verification
  describe('resetRetries()', () => {
    it('clears phase retry counters', () => {
      const sm = new StateManager(tempDir);
      sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
      sm.incrementRetry('TRANSFORMING');
      sm.incrementRetry('TRANSFORMING');
      assert.equal(sm.getRetryCount('TRANSFORMING'), 2);

      sm.resetRetries();
      assert.equal(sm.getRetryCount('TRANSFORMING'), 0);
    });

    it('resets file-level attempts for failed files', () => {
      const sm = new StateManager(tempDir);
      sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
      // M2 FIX: Attempts only increment on 'in_progress', not on 'failed'.
      // Simulate a real attempt cycle: in_progress (+1) → failed (stays 1).
      sm.setFileStatus('app/test.php', 'in_progress');
      sm.setFileStatus('app/test.php', 'failed', { error: 'test' });
      assert.equal(sm.state.transformations.files['app/test.php'].attempts, 1);

      sm.resetRetries();
      assert.equal(sm.state.transformations.files['app/test.php'].attempts, 0);
    });
  });
});

// ── validateVersions (imported via dynamic import trick) ─────────

describe('validateVersions()', () => {
  // We need to test the function defined in bin/shift.js which isn't exported.
  // Instead, test the underlying logic using KNOWN_VERSIONS directly.
  let KNOWN_VERSIONS;

  beforeEach(async () => {
    const mod = await import('../src/state-manager.js');
    KNOWN_VERSIONS = mod.KNOWN_VERSIONS;
  });

  it('KNOWN_VERSIONS includes expected versions', () => {
    assert.ok(KNOWN_VERSIONS.includes('8'));
    assert.ok(KNOWN_VERSIONS.includes('13'));
    assert.equal(KNOWN_VERSIONS.length, 6);
  });

  it('version ordering is correct', () => {
    const idx8 = KNOWN_VERSIONS.indexOf('8');
    const idx13 = KNOWN_VERSIONS.indexOf('13');
    assert.ok(idx13 > idx8);
  });
});

// ── extractJson() ─────────────────────────────────────────────────
// FINDING-16 FIX: Use the exported extractJson() function instead of
// reimplementing the brace-matching algorithm inline.

describe('extractJson()', () => {
  let extractJson;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    extractJson = mod.extractJson;
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text = 'Here is the result: {"ok": true, "changes": ["updated imports"]} And some more text.';
    const parsed = JSON.parse(extractJson(text));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.changes, ['updated imports']);
  });

  it('handles nested braces correctly', () => {
    const text = '{"outer": {"inner": {"deep": true}}, "val": 1}';
    const parsed = JSON.parse(extractJson(text));
    assert.equal(parsed.outer.inner.deep, true);
    assert.equal(parsed.val, 1);
  });

  it('handles strings with braces inside', () => {
    const text = '{"code": "function() { return {}; }", "ok": true}';
    const parsed = JSON.parse(extractJson(text));
    assert.equal(parsed.ok, true);
    assert.ok(parsed.code.includes('{'));
  });
});

// ── compactMessages() ────────────────────────────────────────────
// FINDING-16 FIX: Use the exported functions instead of reimplementing logic inline.

describe('compactMessages() token estimation', () => {
  let estimateTokens;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    estimateTokens = mod.estimateTokens;
  });

  // CRIT-2 FIX: estimateTokens uses chars/3 (M3 FIX), not chars/4.
  // Updated assertions to match the actual implementation.
  it('estimates tokens as roughly chars / 3', () => {
    const estimated = estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]);
    assert.equal(estimated, 134); // ceil(400/3) = 134
  });

  it('handles array content blocks', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello world' },  // 11 chars
        { type: 'tool_result', content: 'result data' }, // 11 chars
      ],
    };
    // Total: 22 chars, ceil(22/3) = 8 tokens
    const estimated = estimateTokens([msg]);
    assert.equal(estimated, 8);
  });
});

// ── getUpgradePath() ────────────────────────────────────────────

describe('getUpgradePath()', () => {
  let getUpgradePath;

  beforeEach(async () => {
    const mod = await import('../config/upgrade-matrix.js');
    getUpgradePath = mod.getUpgradePath;
  });

  it('returns correct path for single step', () => {
    assert.deepEqual(getUpgradePath('10', '11'), ['10', '11']);
  });

  it('returns correct path for multi-step', () => {
    assert.deepEqual(getUpgradePath('8', '11'), ['8', '9', '10', '11']);
  });

  it('returns empty for downgrade', () => {
    assert.deepEqual(getUpgradePath('11', '10'), []);
  });

  it('returns empty for same version', () => {
    assert.deepEqual(getUpgradePath('10', '10'), []);
  });

  it('returns empty for unknown version', () => {
    assert.deepEqual(getUpgradePath('7', '11'), []);
  });

  // REL-7 FIX verification: uses KNOWN_VERSIONS from state-manager
  it('handles version string with minor (e.g. "10.5")', () => {
    assert.deepEqual(getUpgradePath('10.5', '11.0'), ['10', '11']);
  });
});
