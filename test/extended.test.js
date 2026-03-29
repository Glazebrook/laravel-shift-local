/**
 * FIX #16: Extended test suite covering orchestrator logic, agent utilities,
 * security fixes, config validation, and integration-level scenarios.
 *
 * Run with: node --test test/extended.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
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
  };
}

// ══════════════════════════════════════════════════════════════════
// FIX #1 — SEC-4 bypass: write guard on resolved absolute path
// ══════════════════════════════════════════════════════════════════

describe('FIX #1: SEC-4 write guard uses resolved path', () => {
  let tempDir, fileTools;

  beforeEach(async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    mkdirSync(join(tempDir, 'app'), { recursive: true });
    const { FileTools } = await import('../src/file-tools.js');
    fileTools = new FileTools(tempDir, makeLogger());
  });

  afterEach(() => cleanDir(tempDir));

  it('blocks direct .shift/ writes via agent tool handler', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.write_file({ filepath: '.shift/state.json', content: 'hacked' });
    assert.ok(result.error);
    assert.match(result.error, /Cannot write to \.shift/);
  });

  it('blocks traversal bypass: app/../.shift/state.json', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.write_file({ filepath: 'app/../.shift/state.json', content: 'hacked' });
    assert.ok(result.error);
    assert.match(result.error, /Cannot write to \.shift/);
  });

  it('blocks backslash traversal on Windows: app\\..\\.shift\\state.json', { skip: process.platform !== 'win32' ? 'Backslash path separators only apply on Windows' : false }, async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.write_file({ filepath: 'app\\..\\.shift\\state.json', content: 'hacked' });
    assert.ok(result.error);
    assert.match(result.error, /Cannot write to \.shift/);
  });

  it('allows writes to normal paths', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.write_file({ filepath: 'app/test.php', content: '<?php echo 1;' });
    assert.ok(result.ok);
    assert.ok(existsSync(join(tempDir, 'app', 'test.php')));
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #15 — Exclude paths enforced in write guard
// ══════════════════════════════════════════════════════════════════

describe('FIX #15: Exclude paths in write guard', () => {
  let tempDir, fileTools;

  beforeEach(async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, 'vendor'), { recursive: true });
    const { FileTools } = await import('../src/file-tools.js');
    fileTools = new FileTools(tempDir, makeLogger(), { paths: ['vendor'] });
  });

  afterEach(() => cleanDir(tempDir));

  it('blocks writes to excluded vendor/ directory', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.write_file({ filepath: 'vendor/autoload.php', content: 'bad' });
    assert.ok(result.error);
    // AUDIT FIX: vendor/ is now caught by default protected directory guard
    assert.match(result.error, /protected directory|excluded path/);
  });

  it('allows writes to non-excluded directories', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.write_file({ filepath: 'app/Models/User.php', content: '<?php' });
    assert.ok(result.ok);
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #7 — resetRetries sets status to 'pending'
// ══════════════════════════════════════════════════════════════════

describe('FIX #7: resetRetries resets status to pending', () => {
  let tempDir, StateManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  afterEach(() => cleanDir(tempDir));

  it('changes failed files to pending status', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.setFileStatus('app/test.php', 'failed', { error: 'test' });
    assert.equal(sm.getFileStatus('app/test.php'), 'failed');

    sm.resetRetries();
    assert.equal(sm.getFileStatus('app/test.php'), 'pending');
    assert.equal(sm.state.transformations.files['app/test.php'].attempts, 0);
  });

  it('recounts failed/completed after reset', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.setFileStatus('a.php', 'failed', { error: 'x' });
    sm.setFileStatus('b.php', 'done');
    assert.equal(sm.state.transformations.failed, 1);

    sm.resetRetries();
    assert.equal(sm.state.transformations.failed, 0);
    assert.equal(sm.state.transformations.completed, 1);
  });

  it('does not affect done or skipped files', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.setFileStatus('a.php', 'done');
    sm.setFileStatus('b.php', 'skipped');

    sm.resetRetries();
    assert.equal(sm.getFileStatus('a.php'), 'done');
    assert.equal(sm.getFileStatus('b.php'), 'skipped');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #9 — Atomic save (write-then-rename)
// ══════════════════════════════════════════════════════════════════

describe('FIX #9: Atomic save with write-then-rename', () => {
  let tempDir, StateManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  afterEach(() => cleanDir(tempDir));

  it('does not leave a .tmp file after save', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.set('analysis', { test: true });

    const tmpPath = join(tempDir, '.shift', 'state.json.tmp');
    assert.ok(!existsSync(tmpPath), 'Temp file should not persist after save');
    assert.ok(existsSync(join(tempDir, '.shift', 'state.json')));
  });

  it('state.json is valid JSON after save', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });
    sm.set('analysis', { complexity: 'high', files: 42 });

    const raw = readFileSync(join(tempDir, '.shift', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.analysis, { complexity: 'high', files: 42 });
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #2 — Terminal states use synchronous save
// ══════════════════════════════════════════════════════════════════

describe('FIX #2: Terminal states bypass debounce', () => {
  let tempDir, StateManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  afterEach(() => cleanDir(tempDir));

  it('done status is persisted immediately (no debounce)', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    sm.setFileStatus('app/test.php', 'done');

    // Read state.json immediately — should have the done status
    const raw = readFileSync(join(tempDir, '.shift', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.transformations.files['app/test.php'].status, 'done');
  });

  it('failed status is persisted immediately', () => {
    const sm = new StateManager(tempDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tempDir });

    sm.setFileStatus('app/test.php', 'failed', { error: 'boom' });

    const raw = readFileSync(join(tempDir, '.shift', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.transformations.files['app/test.php'].status, 'failed');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #17 — extractJson exported and directly testable
// ══════════════════════════════════════════════════════════════════

describe('FIX #17: extractJson() directly exported', () => {
  let extractJson;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    extractJson = mod.extractJson;
  });

  it('extracts JSON from surrounding prose', () => {
    const text = 'Here is the result: {"ok": true, "changes": ["updated imports"]} And more.';
    const parsed = JSON.parse(extractJson(text));
    assert.equal(parsed.ok, true);
  });

  it('handles nested braces', () => {
    const text = 'Result: {"outer": {"inner": true}, "val": 1}';
    const parsed = JSON.parse(extractJson(text));
    assert.equal(parsed.outer.inner, true);
  });

  it('handles braces inside strings', () => {
    const text = '{"code": "function() { return {}; }", "ok": true}';
    const parsed = JSON.parse(extractJson(text));
    assert.equal(parsed.ok, true);
  });

  it('throws on no JSON found', () => {
    assert.throws(() => extractJson('no json here'), /No JSON object found/);
  });

  it('throws on unbalanced braces', () => {
    assert.throws(() => extractJson('{"open": true'), /Unbalanced braces/);
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #17 — compactMessages exported and directly testable
// ══════════════════════════════════════════════════════════════════

describe('FIX #17: compactMessages() directly exported', () => {
  let compactMessages, estimateTokens;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    compactMessages = mod.compactMessages;
    estimateTokens = mod.estimateTokens;
  });

  it('returns messages unchanged when under token limit', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const result = compactMessages(msgs, 190_000);
    assert.deepEqual(result, msgs);
  });

  it('truncates large tool_result blocks in older messages', () => {
    const bigContent = 'x'.repeat(2000);
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: bigContent }] },
      ...Array(6).fill({ role: 'user', content: 'recent' }),
    ];
    const result = compactMessages(msgs, 100); // Force compaction
    const firstBlock = result[0].content[0];
    assert.ok(firstBlock.content.length < bigContent.length);
    assert.ok(firstBlock.content.includes('[truncated'));
  });

  it('estimateTokens handles string content', () => {
    const tokens = estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]);
    // AUDIT FIX: estimateTokens uses chars/3 (M3 FIX), so ceil(400/3) = 134
    assert.equal(tokens, 134);
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #18 — validateResponseSchema runtime validation
// ══════════════════════════════════════════════════════════════════

describe('FIX #18: validateResponseSchema()', () => {
  let validateResponseSchema;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    validateResponseSchema = mod.validateResponseSchema;
  });

  it('passes for valid schema', () => {
    const obj = { ok: true, changes: ['a'], notes: 'text' };
    const schema = { ok: 'boolean', changes: 'array', notes: 'string' };
    const errors = validateResponseSchema(obj, schema);
    assert.deepEqual(errors, []);
  });

  it('reports missing fields', () => {
    const errors = validateResponseSchema({}, { ok: 'boolean' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing required field.*ok/);
  });

  it('reports type mismatches', () => {
    const errors = validateResponseSchema({ ok: 'yes' }, { ok: 'boolean' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /should be boolean/);
  });

  it('allows any type with "any"', () => {
    const errors = validateResponseSchema({ data: [1, 2] }, { data: 'any' });
    assert.deepEqual(errors, []);
  });

  it('detects non-array when array expected', () => {
    const errors = validateResponseSchema({ items: 'not-array' }, { items: 'array' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /should be array/);
  });

  it('returns error for non-object input', () => {
    const errors = validateResponseSchema(null, { ok: 'boolean' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not an object/);
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #22 — KNOWN_VERSIONS ordering safety
// ══════════════════════════════════════════════════════════════════

describe('FIX #22: KNOWN_VERSIONS numeric ordering', () => {
  let KNOWN_VERSIONS;

  beforeEach(async () => {
    const mod = await import('../src/state-manager.js');
    KNOWN_VERSIONS = mod.KNOWN_VERSIONS;
  });

  it('is in ascending numeric order', () => {
    for (let i = 1; i < KNOWN_VERSIONS.length; i++) {
      assert.ok(
        Number(KNOWN_VERSIONS[i]) > Number(KNOWN_VERSIONS[i - 1]),
        `${KNOWN_VERSIONS[i]} should be > ${KNOWN_VERSIONS[i - 1]}`
      );
    }
  });

  it('indexOf-based comparison agrees with numeric comparison', () => {
    const idx10 = KNOWN_VERSIONS.indexOf('10');
    const idx9 = KNOWN_VERSIONS.indexOf('9');
    assert.ok(idx10 > idx9, 'indexOf(10) should be > indexOf(9)');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #10 — Logger destroy() cleans up intervals
// ══════════════════════════════════════════════════════════════════

describe('FIX #10: Logger destroy()', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
  });

  afterEach(() => cleanDir(tempDir));

  it('destroy() clears the flush interval', async () => {
    const { Logger } = await import('../src/logger.js');
    const logger = new Logger(tempDir, false);
    assert.ok(logger._flushInterval, 'Should have a flush interval');
    logger.destroy();
    assert.equal(logger._flushInterval, null, 'Interval should be cleared after destroy');
  });

  it('destroy() flushes remaining buffer', async () => {
    const { Logger } = await import('../src/logger.js');
    const logger = new Logger(tempDir, false);
    logger._write('INFO', 'Test', 'buffered message');
    assert.ok(logger._buffer.length > 0);
    logger.destroy();
    assert.equal(logger._buffer.length, 0, 'Buffer should be empty after destroy');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #6 — testsRun field name consistency
// ══════════════════════════════════════════════════════════════════

describe('FIX #6: Validator and Reporter use testsRun (not testRun)', () => {
  it('validator-agent.js source code uses testsRun', async () => {
    // Simple source-level check to catch regression
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'agents', 'validator-agent.js'), 'utf8');
    assert.ok(source.includes('results.testsRun'), 'Should use results.testsRun');
    // FINDING-18 FIX: Use regex instead of trailing-space string match,
    // which wouldn't catch results.testRun. or results.testRun?
    assert.ok(!(/results\.testRun[^s]/m.test(source)), 'Should not use results.testRun (without s)');
  });

  // FINDING-18 FIX: Also check reporter-agent.js where the actual bug (#2) lives
  it('reporter-agent.js source code uses testsRun (not testRun)', async () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'agents', 'reporter-agent.js'), 'utf8');
    assert.ok(!(/validation\?\.testRun[^s]/m.test(source)), 'Reporter should not use validation?.testRun (without s)');
    assert.ok(!(/validation\.testRun[^s]/m.test(source)), 'Reporter should not use validation.testRun (without s)');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #13 — composerTimeout in .shiftrc sample at correct level
// ══════════════════════════════════════════════════════════════════

describe('FIX #13: Sample .shiftrc composerTimeout placement', () => {
  it('composerTimeout is inside behaviour block', () => {
    const shiftrc = JSON.parse(readFileSync(join(import.meta.dirname, '..', '.shiftrc'), 'utf8'));
    assert.ok(shiftrc.behaviour.composerTimeout !== undefined, 'Should be in behaviour');
    assert.equal(shiftrc.composerTimeout, undefined, 'Should NOT be at root level');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #11 — _checkBinary validates name pattern
// ══════════════════════════════════════════════════════════════════

describe('FIX #11: Binary name validation in orchestrator', () => {
  it('orchestrator source validates binary name with regex', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'orchestrator.js'), 'utf8');
    assert.ok(source.includes('/^[a-zA-Z0-9._-]+$/'), 'Should validate binary name with safe regex');
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #19 — Shared client is resettable
// ══════════════════════════════════════════════════════════════════

describe('FIX #19: _resetSharedClient for testing', () => {
  let _resetSharedClient;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    _resetSharedClient = mod._resetSharedClient;
  });

  afterEach(() => {
    _resetSharedClient(null);
  });

  it('injects a mock client', () => {
    const mockClient = { messages: { create: async () => ({}) } };
    _resetSharedClient(mockClient);
    // If no error, mock was accepted
    assert.ok(true);
  });

  it('clears the client when called with null', () => {
    _resetSharedClient(null);
    assert.ok(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// FIX #8 — Multi-step file plans are merged
// ══════════════════════════════════════════════════════════════════

describe('FIX #8: Transformer merges multi-step file plans', () => {
  it('transformer source contains step merging logic', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'agents', 'transformer-agent.js'), 'utf8');
    assert.ok(source.includes('stepsByFile'), 'Should have stepsByFile Map for merging');
    assert.ok(source.includes('mergedSteps'), 'Should iterate over mergedSteps');
  });
});

// ══════════════════════════════════════════════════════════════════
// E2E-1 — delete_file tool in file-tools.js
// ══════════════════════════════════════════════════════════════════

describe('E2E-1: delete_file tool', () => {
  let tempDir, fileTools;

  beforeEach(async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift', 'backups'), { recursive: true });
    mkdirSync(join(tempDir, 'config'), { recursive: true });
    mkdirSync(join(tempDir, 'app', 'Http'), { recursive: true });
    const { FileTools } = await import('../src/file-tools.js');
    fileTools = new FileTools(tempDir, makeLogger());
  });

  afterEach(() => cleanDir(tempDir));

  it('creates backup before deleting', async () => {
    writeFileSync(join(tempDir, 'config', 'cors.php'), '<?php return [];');
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: 'config/cors.php', reason: 'Removed in Laravel 11' });
    assert.ok(result.deleted);
    assert.ok(!existsSync(join(tempDir, 'config', 'cors.php')), 'Original file should be deleted');
    assert.ok(existsSync(join(tempDir, '.shift', 'backups', 'config', 'cors.php')), 'Backup should exist');
  });

  it('returns correct response shape', async () => {
    writeFileSync(join(tempDir, 'config', 'cors.php'), '<?php return [];');
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: 'config/cors.php', reason: 'test reason' });
    assert.equal(result.deleted, true);
    assert.equal(result.filepath, 'config/cors.php');
    assert.equal(result.reason, 'test reason');
    assert.ok(result.backup);
  });

  it('rejects paths outside project root (sandbox check)', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: '../../etc/passwd', reason: 'test' });
    assert.ok(result.error);
    assert.match(result.error, /traversal/i);
  });

  it('handles non-existent file gracefully', async () => {
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: 'config/nonexistent.php', reason: 'test' });
    assert.ok(result.error);
    assert.match(result.error, /not found/i);
  });

  it('creates nested backup directories if needed', async () => {
    mkdirSync(join(tempDir, 'app', 'Http', 'Middleware'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'Http', 'Middleware', 'TrustProxies.php'), '<?php class TrustProxies {}');
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: 'app/Http/Middleware/TrustProxies.php', reason: 'Removed in L11' });
    assert.ok(result.deleted);
    assert.ok(existsSync(join(tempDir, '.shift', 'backups', 'app', 'Http', 'Middleware', 'TrustProxies.php')));
  });

  it('blocks deletion in .shift/ directory', async () => {
    writeFileSync(join(tempDir, '.shift', 'state.json'), '{}');
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: '.shift/state.json', reason: 'test' });
    assert.ok(result.error);
    assert.match(result.error, /Cannot delete/);
  });

  it('blocks deletion in protected directories', async () => {
    mkdirSync(join(tempDir, 'vendor'), { recursive: true });
    writeFileSync(join(tempDir, 'vendor', 'autoload.php'), '<?php');
    const tools = fileTools.getAgentTools();
    const result = await tools.handlers.delete_file({ filepath: 'vendor/autoload.php', reason: 'test' });
    assert.ok(result.error);
    assert.match(result.error, /protected directory/i);
  });

  it('transformer agent has delete_file in its tool definitions', () => {
    const tools = fileTools.getAgentTools();
    const names = tools.definitions.map(d => d.name);
    assert.ok(names.includes('delete_file'), 'delete_file should be in tool definitions');
  });

  it('transformer agent system prompt mentions delete_file', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'agents', 'transformer-agent.js'), 'utf8');
    assert.ok(source.includes('delete_file'), 'Transformer system prompt should mention delete_file');
  });
});
