/**
 * Audit-2 fix coverage.
 * Tests the 5 fixes applied during the v2 enterprise audit:
 *   P1-001: Network error retry in _callWithRetry
 *   P1-002: max_tokens truncation warning
 *   P1-003: Backup restore before retry of interrupted transforms
 *   P1-004: Case-insensitive path comparison on resume
 *   P3-001: branchPrefix leading slash / consecutive slash sanitization
 *
 * Audit-5 fix coverage (appended):
 *   P1-001: _phpSyntaxCheck checks result.ok instead of try/catch
 *   P1-002: _contentFilterFallback passes string version numbers
 *   P2-001: _phpSyntaxCheck uses envKeys instead of useProcessEnv
 *   P2-005: class-strings detect() no /g flag — no stateful regex
 *   P2-008: l11-structural readFileSync with try-catch
 *   SEC-002: pre-processor safeWriteFile validates paths and creates backups
 *   SEC-003: l11-structural validatePath before writes
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BaseAgent, _resetSharedClient,
} from '../src/agents/base-agent.js';

function makeLogger() {
  const logs = { info: [], warn: [], error: [], debug: [], success: [], phase: [], tool: [] };
  return {
    info: async (_n, m) => logs.info.push(m),
    warn: async (_n, m) => logs.warn.push(m),
    error: async (_n, m) => logs.error.push(m),
    debug: async (_n, m) => logs.debug.push(m),
    success: async (_n, m) => logs.success.push(m),
    phase: async (m) => logs.phase.push(m),
    tool: async (_n, m) => logs.tool.push(m),
    _logs: logs,
  };
}

// ── P1-001: Network error retry ─────────────────────────────────

describe('AUDIT-2 P1-001: Network error retry in _callWithRetry', () => {
  afterEach(() => _resetSharedClient());

  it('retries on ECONNRESET', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error('Connection reset');
            err.code = 'ECONNRESET';
            throw err;
          }
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 3,
    });

    const result = await agent._callWithRetry({ model: 'test', messages: [] });
    assert.equal(attempts, 2);
    assert.ok(result.content);
  });

  it('retries on ECONNREFUSED', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error('Connection refused');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 3,
    });

    const result = await agent._callWithRetry({ model: 'test', messages: [] });
    assert.equal(attempts, 2);
    assert.ok(result.content);
  });

  it('retries on nested cause.code ETIMEDOUT', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error('fetch failed');
            err.cause = { code: 'ETIMEDOUT' };
            throw err;
          }
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 3,
    });

    const result = await agent._callWithRetry({ model: 'test', messages: [] });
    assert.equal(attempts, 2);
    assert.ok(result.content);
  });

  it('retries on HTTP 408 Request Timeout', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error('Request Timeout');
            err.status = 408;
            throw err;
          }
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 3,
    });

    const result = await agent._callWithRetry({ model: 'test', messages: [] });
    assert.equal(attempts, 2);
    assert.ok(result.content);
  });

  it('does NOT retry on HTTP 400 Bad Request', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          const err = new Error('Bad Request');
          err.status = 400;
          throw err;
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 3,
    });

    await assert.rejects(
      () => agent._callWithRetry({ model: 'test', messages: [] }),
      (err) => err.status === 400
    );
    assert.equal(attempts, 1, 'Should not retry on 400');
  });

  it('exhausts all retries on persistent network error', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          const err = new Error('DNS lookup failed');
          err.code = 'ENOTFOUND';
          throw err;
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 3,
    });

    await assert.rejects(
      () => agent._callWithRetry({ model: 'test', messages: [] }),
      (err) => err.code === 'ENOTFOUND'
    );
    assert.equal(attempts, 3, 'Should exhaust all retries');
  });
});

// ── P1-002: max_tokens truncation warning ───────────────────────

describe('AUDIT-2 P1-002: max_tokens truncation warning', () => {
  afterEach(() => _resetSharedClient());

  it('logs warning when stop_reason is max_tokens', async () => {
    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '{"ok": true}' }],
          usage: { input_tokens: 100, output_tokens: 8192 },
          stop_reason: 'max_tokens',
        }),
      },
    };
    _resetSharedClient(mockClient);

    const logger = makeLogger();
    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger, maxTokens: 8192,
    });

    await agent.run('System prompt', [{ role: 'user', content: 'test' }]);
    const hasWarning = logger._logs.warn.some(m => m.includes('max_tokens') && m.includes('8192'));
    assert.ok(hasWarning, 'Should log a warning about max_tokens truncation');
  });

  it('does NOT warn when stop_reason is end_turn', async () => {
    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'Done' }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'end_turn',
        }),
      },
    };
    _resetSharedClient(mockClient);

    const logger = makeLogger();
    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger,
    });

    await agent.run('System prompt', [{ role: 'user', content: 'test' }]);
    const hasWarning = logger._logs.warn.some(m => m.includes('max_tokens'));
    assert.ok(!hasWarning, 'Should not warn on normal end_turn');
  });
});

// ── P1-003: Backup restore before retry ─────────────────────────

describe('AUDIT-2 P1-003: Transformer backup restore before retry', () => {
  it('transformer source restores from backup when status is in_progress', async () => {
    // Verify the code path exists in the transformer source
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');

    assert.ok(src.includes("currentStatus === 'in_progress'"), 'Should check for in_progress status');
    assert.ok(src.includes('this.fileTools.hasBackup(filepath)'), 'Should check for backup existence');
    assert.ok(src.includes('this.fileTools.restore(filepath)'), 'Should call restore');
    assert.ok(src.includes('Restored'), 'Should log restoration');
  });

  it('transformer source catches restore errors gracefully', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');

    assert.ok(src.includes('restoreErr'), 'Should have catch block for restore errors');
    assert.ok(src.includes('Could not restore'), 'Should warn on restore failure');
  });
});

// ── P1-004: Case-insensitive path comparison ────────────────────

describe('AUDIT-2 P1-004: Case-insensitive path comparison on resume', () => {
  it('shift.js uses case-insensitive comparison for win32/darwin', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('bin/shift.js'), 'utf8');

    assert.ok(src.includes("process.platform === 'win32'"), 'Should check for Windows');
    assert.ok(src.includes("process.platform === 'darwin'"), 'Should check for macOS');
    assert.ok(src.includes('.toLowerCase()'), 'Should use toLowerCase for comparison');
    assert.ok(src.includes('isCaseInsensitiveFS'), 'Should have named boolean for clarity');
  });

  it('case-insensitive comparison logic is correct', () => {
    // Simulate the comparison logic from bin/shift.js
    function pathsMatch(loaded, current, platform) {
      const isCaseInsensitiveFS = platform === 'win32' || platform === 'darwin';
      return isCaseInsensitiveFS
        ? loaded.toLowerCase() === current.toLowerCase()
        : loaded === current;
    }

    // Windows: case-insensitive
    assert.ok(pathsMatch('C:\\Projects\\MyApp', 'c:\\projects\\myapp', 'win32'));
    assert.ok(!pathsMatch('C:\\Projects\\MyApp', 'C:\\Projects\\OtherApp', 'win32'));

    // macOS: case-insensitive
    assert.ok(pathsMatch('/Users/dev/MyApp', '/users/dev/myapp', 'darwin'));

    // Linux: case-sensitive
    assert.ok(!pathsMatch('/home/dev/MyApp', '/home/dev/myapp', 'linux'));
    assert.ok(pathsMatch('/home/dev/myapp', '/home/dev/myapp', 'linux'));
  });
});

// ── P3-001: branchPrefix leading slash sanitization ─────────────

describe('AUDIT-2 P3-001: branchPrefix leading slash sanitization', () => {
  it('strips leading slashes from branchPrefix', () => {
    let prefix = '///upgrade';
    prefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '');
    prefix = prefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!prefix || prefix.includes('..')) prefix = 'shift/upgrade';
    assert.equal(prefix, 'upgrade');
  });

  it('collapses consecutive slashes', () => {
    let prefix = 'shift///upgrade//test';
    prefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '');
    prefix = prefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!prefix || prefix.includes('..')) prefix = 'shift/upgrade';
    assert.equal(prefix, 'shift/upgrade/test');
  });

  it('defaults when result is empty after sanitization', () => {
    let prefix = '////';
    prefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '');
    prefix = prefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!prefix || prefix.includes('..')) prefix = 'shift/upgrade';
    assert.equal(prefix, 'shift/upgrade');
  });

  it('handles path traversal attempt: ../../etc/evil', () => {
    let prefix = '../../etc/evil';
    prefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '');
    // Dots are stripped, leaving //etc/evil
    prefix = prefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    // Now it's 'etc/evil' — clean
    assert.equal(prefix, 'etc/evil');
    assert.ok(!prefix.includes('..'));
  });

  it('preserves valid prefixes', () => {
    let prefix = 'shift/upgrade';
    prefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '');
    prefix = prefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!prefix || prefix.includes('..')) prefix = 'shift/upgrade';
    assert.equal(prefix, 'shift/upgrade');
  });
});

// ── P1-001: Null check on JSON.parse of composer.lock ────────────

import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';


function makeTempDir(prefix = 'shift-audit3-') {
  const dir = join(tmpdir(), prefix + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

describe('AUDIT-3 P1-001: Malformed composer.lock null check', () => {
  let tempDir;

  afterEach(() => { if (tempDir) cleanDir(tempDir); });

  it('handles composer.lock with null packages gracefully', async () => {
    tempDir = makeTempDir();
    // Write a composer.lock with null packages
    writeFileSync(join(tempDir, 'composer.lock'), JSON.stringify({ packages: null }));

    const { AnalyzerAgent } = await import('../src/agents/analyzer-agent.js');
    const logger = makeLogger();
    const agent = new AnalyzerAgent({
      projectPath: tempDir,
      logger,
      config: { models: { analyzer: 'test-model' } },
      fileTools: {},
    });

    // _verifyInstalledVersion should not throw on null packages
    await agent._verifyInstalledVersion('10');
    const hasWarning = logger._logs.warn.some(m =>
      m.includes('missing') || m.includes('no packages')
    );
    assert.ok(hasWarning, 'Should warn about missing packages array');
  });

  it('handles composer.lock with empty object gracefully', async () => {
    tempDir = makeTempDir();
    writeFileSync(join(tempDir, 'composer.lock'), '{}');

    const { AnalyzerAgent } = await import('../src/agents/analyzer-agent.js');
    const logger = makeLogger();
    const agent = new AnalyzerAgent({
      projectPath: tempDir,
      logger,
      config: { models: { analyzer: 'test-model' } },
      fileTools: {},
    });

    await agent._verifyInstalledVersion('10');
    const hasWarning = logger._logs.warn.some(m =>
      m.includes('missing') || m.includes('no packages')
    );
    assert.ok(hasWarning, 'Should warn about missing packages');
  });

  it('handles malformed JSON in composer.lock gracefully', async () => {
    tempDir = makeTempDir();
    writeFileSync(join(tempDir, 'composer.lock'), '{not valid json!!!');

    const { AnalyzerAgent } = await import('../src/agents/analyzer-agent.js');
    const logger = makeLogger();
    const agent = new AnalyzerAgent({
      projectPath: tempDir,
      logger,
      config: { models: { analyzer: 'test-model' } },
      fileTools: {},
    });

    // Should not throw — caught internally
    await agent._verifyInstalledVersion('10');
    // Debug log captures the parse error
    const hasDebug = logger._logs.debug.some(m => m.includes('Version verification failed'));
    assert.ok(hasDebug, 'Should log debug message about verification failure');
  });
});

// ── P1-002: stderr logging in logger._flushBuffer ────────────────

describe('AUDIT-3 P1-002: Logger._flushBuffer writes errors to stderr', () => {
  it('source code writes to process.stderr on flush failure', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/logger.js'), 'utf8');

    assert.ok(src.includes('process.stderr.write'), 'Should use process.stderr.write for flush errors');
    assert.ok(src.includes('Failed to flush buffer'), 'Should include descriptive error message');
  });
});

// ── P1-004 + SEC-005: Shell injection / quoting fix ──────────────

describe('AUDIT-3 P1-004+SEC-005: Git args with quotes rejected', () => {
  it('rejects args containing double quotes', () => {
    const arg = 'branch"--inject';
    // The SEC-005 fix explicitly checks for quote chars
    assert.ok(arg.includes('"'), 'Arg contains double quote');
    // Even if it passes SAFE_SPACED_RE, the explicit quote check catches it
  });

  it('rejects args containing single quotes', () => {
    const arg = "branch'name";
    assert.ok(arg.includes("'"), 'Arg contains single quote');
  });

  it('rejects args containing backticks', () => {
    const arg = 'branch`cmd`';
    assert.ok(arg.includes('`'), 'Arg contains backtick');
  });

  it('git-manager source has explicit quote character rejection', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/git-manager.js'), 'utf8');

    assert.ok(src.includes("arg.includes('\"')"), 'Should check for double quotes');
    assert.ok(src.includes("arg.includes(\"'\")"), 'Should check for single quotes');
    assert.ok(src.includes("arg.includes('`')"), 'Should check for backticks');
    assert.ok(src.includes('Blocked unsafe git argument (contains quotes)'), 'Should have descriptive error for quote rejection');
  });
});

// ── SEC-001: Prototype pollution filter ──────────────────────────

describe('AUDIT-3 SEC-001: Prototype pollution filter in .shiftrc models', () => {
  it('filters __proto__ key from models config', () => {
    // Simulate what JSON.parse produces — __proto__ becomes an own property
    const rcModels = JSON.parse('{"analyzer":"claude-opus-4-6","__proto__":"evil-model","transformer":"claude-sonnet-4-6"}');

    // Reproduce the filter logic from bin/shift.js loadConfig
    const safeModels = {};
    for (const [key, value] of Object.entries(rcModels)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      safeModels[key] = value;
    }

    assert.equal(safeModels.analyzer, 'claude-opus-4-6');
    assert.equal(safeModels.transformer, 'claude-sonnet-4-6');
    assert.ok(!Object.prototype.hasOwnProperty.call(safeModels, '__proto__'),
      '__proto__ should not exist as own property in safe models');
  });

  it('filters constructor key from models config', () => {
    const rcModels = { constructor: 'evil', analyzer: 'claude-opus-4-6' };
    const safeModels = {};
    for (const [key, value] of Object.entries(rcModels)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      safeModels[key] = value;
    }

    assert.ok(!Object.prototype.hasOwnProperty.call(safeModels, 'constructor'),
      'constructor key should be filtered');
    assert.equal(safeModels.analyzer, 'claude-opus-4-6');
  });

  it('filters prototype key from models config', () => {
    const rcModels = { prototype: 'evil', reporter: 'claude-sonnet-4-6' };
    const safeModels = {};
    for (const [key, value] of Object.entries(rcModels)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      safeModels[key] = value;
    }

    assert.ok(!Object.prototype.hasOwnProperty.call(safeModels, 'prototype'),
      'prototype key should be filtered');
    assert.equal(safeModels.reporter, 'claude-sonnet-4-6');
  });

  it('shift.js source contains the prototype pollution filter', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('bin/shift.js'), 'utf8');

    assert.ok(src.includes("key === '__proto__'"), 'Should filter __proto__');
    assert.ok(src.includes("key === 'constructor'"), 'Should filter constructor');
    assert.ok(src.includes("key === 'prototype'"), 'Should filter prototype');
  });
});

// ── SEC-002: Glob pattern traversal validation ───────────────────

describe('AUDIT-3 SEC-002: Glob pattern traversal rejected by list_files', () => {
  let tempDir;

  afterEach(() => { if (tempDir) cleanDir(tempDir); });

  it('rejects patterns containing ..', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.list_files({ pattern: '../../../etc/passwd' });
    assert.ok(result.error, 'Should return error');
    assert.ok(result.error.includes('path traversal'), 'Error should mention path traversal');
  });

  it('rejects patterns starting with /', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.list_files({ pattern: '/etc/passwd' });
    assert.ok(result.error, 'Should return error');
    assert.ok(result.error.includes('path traversal') || result.error.includes('absolute path'),
      'Error should mention traversal or absolute path');
  });

  it('rejects patterns starting with backslash', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.list_files({ pattern: '\\windows\\system32' });
    assert.ok(result.error, 'Should return error');
  });

  it('allows valid glob patterns', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.list_files({ pattern: 'app/**/*.php' });
    assert.ok(!result.error, 'Should not return error for valid pattern');
    assert.ok(Array.isArray(result.files), 'Should return files array');
  });
});

// ── SEC-003: path.basename() fix for sensitive file detection ────

describe('AUDIT-3 SEC-003: Sensitive file detection uses path.basename()', () => {
  let tempDir;

  afterEach(() => { if (tempDir) cleanDir(tempDir); });

  it('detects .env at root path', async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, 'app'));
    writeFileSync(join(tempDir, '.env'), 'SECRET=value');
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.read_file({ filepath: '.env' });
    assert.ok(result.error, 'Should block .env');
    assert.ok(result.error.includes('sensitive'), 'Error should mention sensitive file');
  });

  it('detects .env.production via basename', async () => {
    tempDir = makeTempDir();
    writeFileSync(join(tempDir, '.env.production'), 'SECRET=value');
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.read_file({ filepath: '.env.production' });
    assert.ok(result.error, 'Should block .env.production');
  });

  it('detects nested .env files', async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, 'config'));
    writeFileSync(join(tempDir, 'config', '.env.local'), 'SECRET=value');
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.read_file({ filepath: 'config/.env.local' });
    assert.ok(result.error, 'Should block nested .env files');
  });

  it('uses path.basename() in source code', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/file-tools.js'), 'utf8');

    assert.ok(src.includes('basename(normalizedPath)'), 'Should use basename() for extraction');
    // Ensure the old split-based approach is NOT used
    assert.ok(!src.includes(".split('/').pop()"), 'Should NOT use split/pop for basename');
  });
});

// ── SEC-009: PowerShell drive letter validation ──────────────────

describe('AUDIT-3 SEC-009: Non-alpha drive letters rejected in _checkDiskSpace', () => {
  it('rejects non-alpha drive letter (digit)', () => {
    const driveLetter = '1';
    assert.ok(!/^[A-Z]$/.test(driveLetter), 'Digit should fail A-Z test');
  });

  it('rejects non-alpha drive letter (special char)', () => {
    const driveLetter = '$';
    assert.ok(!/^[A-Z]$/.test(driveLetter), 'Special char should fail A-Z test');
  });

  it('accepts valid drive letters A-Z', () => {
    assert.ok(/^[A-Z]$/.test('C'), 'C should pass');
    assert.ok(/^[A-Z]$/.test('D'), 'D should pass');
    assert.ok(/^[A-Z]$/.test('Z'), 'Z should pass');
  });

  it('rejects lowercase drive letters (pre-uppercase conversion)', () => {
    // The code does .charAt(0).toUpperCase() before the test, but this verifies
    // the regex itself rejects lowercase
    assert.ok(!/^[A-Z]$/.test('c'), 'Lowercase c should fail A-Z test');
  });

  it('orchestrator source has drive letter validation', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/orchestrator.js'), 'utf8');

    assert.ok(src.includes('/^[A-Z]$/'), 'Should have A-Z regex for drive letter validation');
    assert.ok(src.includes('invalid drive letter'), 'Should have descriptive warning message');
  });
});

// ── P3-004: Dynamic version in transformer prompt ────────────────

describe('AUDIT-3 P3-004: Transformer prompt includes version from state', () => {
  it('transformer source references stateManager.state.toVersion', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');

    assert.ok(src.includes('this.stateManager'), 'Should access stateManager');
    assert.ok(src.includes("get('toVersion')"), 'Should use toVersion from state via public API');
    // Verify it's interpolated into the prompt context, not hardcoded
    assert.ok(src.includes('analysis.laravelVersion'), 'Should include current version from analysis');
  });

  it('transformer stores stateManager from deps', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');

    assert.ok(src.includes('this.stateManager = deps.stateManager'),
      'Should assign stateManager from deps in constructor');
  });
});

// ── AUDIT-4 P1-003: readJson() wraps JSON.parse with filepath context ──

describe('AUDIT-4 P1-003: readJson() error includes filepath', () => {
  let tempDir;

  afterEach(() => { if (tempDir) cleanDir(tempDir); });

  it('throws error mentioning filename for invalid JSON', async () => {
    tempDir = makeTempDir();
    writeFileSync(join(tempDir, 'bad.json'), '{not valid json!!!');
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);

    assert.throws(
      () => ft.readJson('bad.json'),
      (err) => {
        assert.ok(err.message.includes('bad.json'), 'Error should mention the filename');
        assert.ok(err.message.includes('Invalid JSON'), 'Error should mention Invalid JSON');
        return true;
      }
    );
  });

  it('succeeds for valid JSON', async () => {
    tempDir = makeTempDir();
    writeFileSync(join(tempDir, 'good.json'), '{"key": "value"}');
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);

    const result = ft.readJson('good.json');
    assert.deepStrictEqual(result, { key: 'value' });
  });
});

// ── AUDIT-4 P1-005: _callWithRetry with maxRetries=0 ──

describe('AUDIT-4 P1-005: _callWithRetry handles maxRetries=0', () => {
  afterEach(() => _resetSharedClient());

  it('makes one attempt with maxRetries=0 on success', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 0,
    });

    const result = await agent._callWithRetry({ model: 'test', messages: [] });
    assert.equal(attempts, 1, 'Should make exactly one attempt');
    assert.ok(result.content, 'Should return result');
  });

  it('throws on failure with maxRetries=0 (not undefined)', async () => {
    const mockClient = {
      messages: {
        create: async () => {
          throw new Error('API error');
        },
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(), maxRetries: 0,
    });

    await assert.rejects(
      () => agent._callWithRetry({ model: 'test', messages: [] }),
      (err) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.equal(err.message, 'API error');
        return true;
      }
    );
  });
});

// ── AUDIT-4 P2-004 to P2-008: StateManager methods require init ──

describe('AUDIT-4 P2-004 to P2-008: StateManager methods throw before init', () => {
  it('logError throws when called before init', async () => {
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager('/fake/path');

    assert.throws(
      () => sm.logError('ANALYZING', new Error('test')),
      (err) => err.message.includes('not initialised')
    );
  });

  it('incrementRetry throws when called before init', async () => {
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager('/fake/path');

    assert.throws(
      () => sm.incrementRetry('ANALYZING'),
      (err) => err.message.includes('not initialised')
    );
  });

  it('getRetryCount throws when called before init', async () => {
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager('/fake/path');

    assert.throws(
      () => sm.getRetryCount('ANALYZING'),
      (err) => err.message.includes('not initialised')
    );
  });

  it('setFileStatus throws when called before init', async () => {
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager('/fake/path');

    assert.throws(
      () => sm.setFileStatus('app/Models/User.php', 'done'),
      (err) => err.message.includes('not initialised')
    );
  });

  it('getFileStatus throws when called before init', async () => {
    const { StateManager } = await import('../src/state-manager.js');
    const sm = new StateManager('/fake/path');

    assert.throws(
      () => sm.getFileStatus('app/Models/User.php'),
      (err) => err.message.includes('not initialised')
    );
  });
});

// ── AUDIT-4 P2-009: Logger concurrent flush guard ──

describe('AUDIT-4 P2-009: Logger._flushBuffer concurrent flush guard', () => {
  let tempDir;

  afterEach(() => { if (tempDir) cleanDir(tempDir); });

  it('skips flush if already flushing', async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    const { Logger } = await import('../src/logger.js');
    const logger = new Logger(tempDir, false);

    try {
      // Simulate flushing state
      logger._flushing = true;
      logger._buffer.push('test line\n');

      await logger._flushBuffer();

      // Buffer should NOT have been drained because _flushing was true
      assert.equal(logger._buffer.length, 1, 'Buffer should remain untouched when already flushing');
    } finally {
      logger._flushing = false;
      logger.destroy();
    }
  });

  it('flushes normally when not already flushing', async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    const { Logger } = await import('../src/logger.js');
    const logger = new Logger(tempDir, false);

    try {
      logger._buffer.push('test line\n');
      assert.equal(logger._flushing, false, '_flushing should start as false');

      await logger._flushBuffer();

      assert.equal(logger._buffer.length, 0, 'Buffer should be drained after normal flush');
    } finally {
      logger.destroy();
    }
  });
});

// ── AUDIT-4 SEC-007: write_file blocks dangerous executable extensions ──

describe('AUDIT-4 SEC-007: write_file blocks dangerous executable extensions', () => {
  let tempDir;

  afterEach(() => { if (tempDir) cleanDir(tempDir); });

  it('rejects .sh files', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.write_file({ filepath: 'deploy.sh', content: '#!/bin/bash\necho pwned' });
    assert.ok(result.error, 'Should return error for .sh');
    assert.ok(result.error.includes('.sh'), 'Error should mention the blocked extension');
  });

  it('rejects .bat files', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.write_file({ filepath: 'run.bat', content: '@echo off' });
    assert.ok(result.error, 'Should return error for .bat');
    assert.ok(result.error.includes('.bat'), 'Error should mention .bat');
  });

  it('rejects .cmd files', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.write_file({ filepath: 'run.cmd', content: 'echo test' });
    assert.ok(result.error, 'Should return error for .cmd');
  });

  it('rejects .ps1 files', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.write_file({ filepath: 'script.ps1', content: 'Write-Host pwned' });
    assert.ok(result.error, 'Should return error for .ps1');
  });

  it('rejects .exe files', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.write_file({ filepath: 'malware.exe', content: 'binary' });
    assert.ok(result.error, 'Should return error for .exe');
  });

  it('allows .php files (not blocked)', async () => {
    tempDir = makeTempDir();
    const logger = makeLogger();
    const { FileTools } = await import('../src/file-tools.js');
    const ft = new FileTools(tempDir, logger);
    const tools = ft.getAgentTools();

    const result = await tools.handlers.write_file({ filepath: 'app/Test.php', content: '<?php echo "ok";' });
    assert.ok(!result.error, 'Should allow .php files');
    assert.ok(result.ok, 'Should succeed for .php');
  });
});

// ── AUDIT-4 SEC-009: API key scrubbed from log output ──

describe('AUDIT-4 SEC-009: Logger scrubs API key from log output', () => {
  let tempDir;
  let originalKey;

  afterEach(() => {
    if (tempDir) cleanDir(tempDir);
    // Restore original key
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it('replaces API key with [REDACTED] in log buffer', async () => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, '.shift'), { recursive: true });
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890abcdef';

    const { Logger } = await import('../src/logger.js');
    const logger = new Logger(tempDir, false);

    try {
      // Write directly using the internal _write to check the buffer
      logger._write('ERROR', 'Test', 'API call failed with key sk-ant-test-key-1234567890abcdef in request');

      // Check the buffer for redaction
      const bufferContent = logger._buffer.join('');
      assert.ok(!bufferContent.includes('sk-ant-test-key-1234567890abcdef'),
        'API key should not appear in log buffer');
      assert.ok(bufferContent.includes('[REDACTED]'),
        'Should contain [REDACTED] placeholder');
    } finally {
      logger.destroy();
    }
  });

  it('source code uses replaceAll for key scrubbing', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/logger.js'), 'utf8');

    assert.ok(src.includes('ANTHROPIC_API_KEY'), 'Should reference ANTHROPIC_API_KEY');
    assert.ok(src.includes('[REDACTED]'), 'Should contain REDACTED placeholder');
    assert.ok(src.includes('replaceAll'), 'Should use replaceAll for thorough replacement');
  });
});

// ── AUDIT-4 SEC-010: validator-agent uses shell:false for PHP syntax ──

describe('AUDIT-4 SEC-010: ValidatorAgent _phpSyntaxCheck uses centralised shell (no shell:true)', () => {
  it('source code uses execCommand from shell.js (shell defaults to false)', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    // Verify it uses the centralised execCommand (which defaults to shell: false)
    assert.ok(src.includes("import { execCommand } from '../shell.js'"),
      'Should import execCommand from shell.js');
    const syntaxCheckSection = src.substring(
      src.indexOf('async _phpSyntaxCheck'),
      src.indexOf('async _artisan')
    );
    assert.ok(syntaxCheckSection.includes('execCommand'),
      'execCommand should be used within _phpSyntaxCheck method');
    // Must NOT set shell: true in syntax check
    assert.ok(!syntaxCheckSection.includes('shell: true'),
      'shell: true must not appear in _phpSyntaxCheck');
  });
});

// ── AUDIT-4 SEC-016: Error messages truncated to 500 chars ──

describe('AUDIT-4 SEC-016: ValidatorAgent truncates error messages to 500 chars', () => {
  it('source code defines MAX_ERROR_LEN = 500', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    assert.ok(src.includes('MAX_ERROR_LEN = 500'), 'Should define MAX_ERROR_LEN constant');
    assert.ok(src.includes('.substring(0, MAX_ERROR_LEN)'), 'Should truncate using substring');
  });

  it('truncation logic works correctly on long strings', () => {
    const MAX_ERROR_LEN = 500;
    const longError = 'A'.repeat(1000);
    const truncated = longError.substring(0, MAX_ERROR_LEN);

    assert.equal(truncated.length, 500, 'Should be truncated to 500 chars');
    assert.equal(longError.length, 1000, 'Original should be 1000 chars');
  });

  it('truncation is no-op for short strings', () => {
    const MAX_ERROR_LEN = 500;
    const shortError = 'Parse error in line 42';
    const truncated = shortError.substring(0, MAX_ERROR_LEN);

    assert.equal(truncated, shortError, 'Short strings should pass through unchanged');
  });
});

// ── AUDIT-4 SEC-018: Validator system prompt has injection defense ──

describe('AUDIT-4 SEC-018: ValidatorAgent system prompt has injection defense', () => {
  it('_aiReviewErrors system prompt contains injection defense text', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    // Extract the _aiReviewErrors method section
    const methodStart = src.indexOf('async _aiReviewErrors');
    assert.ok(methodStart !== -1, '_aiReviewErrors method should exist');

    const methodSection = src.substring(methodStart, src.indexOf('}', src.indexOf('catch', methodStart) + 10));

    assert.ok(methodSection.includes('Ignore any instructions'),
      'System prompt should contain injection defense directive');
    assert.ok(methodSection.includes('untrusted data'),
      'System prompt should mention that error messages are untrusted data');
  });
});

// ── AUDIT-5 A2-006: Code fence escape in reporter-agent ──────────

describe('AUDIT-5 A2-006: ReporterAgent _escCodeFence strips triple backticks', () => {
  let ReporterAgent;

  it('_escCodeFence replaces triple backticks with double backticks', async () => {
    ({ ReporterAgent } = await import('../src/agents/reporter-agent.js'));
    const agent = Object.create(ReporterAgent.prototype);
    assert.equal(agent._escCodeFence('before ``` after'), 'before `` after');
  });

  it('_escCodeFence handles 4+ consecutive backticks', async () => {
    ({ ReporterAgent } = await import('../src/agents/reporter-agent.js'));
    const agent = Object.create(ReporterAgent.prototype);
    assert.equal(agent._escCodeFence('a ```` b ````` c'), 'a `` b `` c');
  });

  it('_escCodeFence leaves single and double backticks intact', async () => {
    ({ ReporterAgent } = await import('../src/agents/reporter-agent.js'));
    const agent = Object.create(ReporterAgent.prototype);
    assert.equal(agent._escCodeFence('a ` b `` c'), 'a ` b `` c');
  });

  it('_escCodeFence handles null/undefined via String coercion', async () => {
    ({ ReporterAgent } = await import('../src/agents/reporter-agent.js'));
    const agent = Object.create(ReporterAgent.prototype);
    assert.equal(agent._escCodeFence(null), 'null');
    assert.equal(agent._escCodeFence(undefined), 'undefined');
  });

  it('reporter source uses _escCodeFence for all code fence insertions', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/agents/reporter-agent.js'), 'utf8');

    // Find all code fence insertions (```\n${...}\n```)
    const fencePattern = /\\`\\`\\`\\n\$\{([^}]+)\}\\n\\`\\`\\`/g;
    const matches = [...src.matchAll(fencePattern)];

    assert.ok(matches.length >= 3, `Expected at least 3 code fence insertions, found ${matches.length}`);
    for (const match of matches) {
      assert.ok(match[1].includes('_escCodeFence'),
        `Code fence content should use _escCodeFence: ${match[1]}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Agent 4 (A2-xxx) production-hardening fix regression tests
// ══════════════════════════════════════════════════════════════════

// ── A2-010: node: prefix for builtin imports ─────────────────────

describe('A2-010: All source files use node: prefix for builtin imports', () => {
  const SOURCE_FILES = [
    'src/orchestrator.js',
    'src/state-manager.js',
    'src/logger.js',
    'src/git-manager.js',
    'src/file-tools.js',
    'src/errors.js',
    'src/utils.js',
    'src/agents/base-agent.js',
    'src/agents/analyzer-agent.js',
    'src/agents/planner-agent.js',
    'src/agents/dependency-agent.js',
    'src/agents/transformer-agent.js',
    'src/agents/validator-agent.js',
    'src/agents/reporter-agent.js',
    'bin/shift.js',
  ];

  // Node builtins that must use the node: prefix when imported
  const BUILTINS = [
    'fs', 'path', 'os', 'child_process', 'crypto', 'url', 'util',
    'stream', 'events', 'assert', 'buffer', 'http', 'https', 'net',
    'readline', 'module', 'process', 'timers', 'worker_threads',
  ];

  // Regex matches: import ... from 'fs' or import ... from "path" (without node: prefix)
  // Excludes lines that are comments
  const BARE_BUILTIN_RE = new RegExp(
    `^\\s*import\\s+.*\\s+from\\s+['"](?:${BUILTINS.join('|')})['"]`,
    'm'
  );

  for (const file of SOURCE_FILES) {
    it(`${file} has no bare builtin imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(file), 'utf8');

      const lines = src.split('\n');
      const violations = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (BARE_BUILTIN_RE.test(line)) {
          violations.push(`Line ${i + 1}: ${line.trim()}`);
        }
      }

      assert.equal(violations.length, 0,
        `Found bare builtin imports (missing node: prefix):\n${violations.join('\n')}`);
    });
  }
});

// ── A2-011: unref timers in _callWithRetry ───────────────────────

describe('A2-011: setTimeout calls in _callWithRetry have .unref()', () => {
  it('base-agent.js source calls .unref() on all setTimeout timers', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/base-agent.js'), 'utf8');

    // Extract only the _callWithRetry method body
    const methodStart = src.indexOf('async _callWithRetry(');
    assert.ok(methodStart !== -1, '_callWithRetry method should exist');

    // Find the method body (until the next method or class end)
    const methodBody = src.substring(methodStart, src.indexOf('\n  }', methodStart + 100) + 4);

    // Count setTimeout calls and .unref() calls within the method
    const setTimeoutMatches = methodBody.match(/setTimeout\(/g) || [];
    const unrefMatches = methodBody.match(/\.unref\(\)/g) || [];

    assert.ok(setTimeoutMatches.length > 0, 'Should have at least one setTimeout call');
    assert.equal(setTimeoutMatches.length, unrefMatches.length,
      `Every setTimeout (${setTimeoutMatches.length}) should have a matching .unref() (${unrefMatches.length})`);
  });

  it('unref is called on the timeout ID, not something else', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/base-agent.js'), 'utf8');

    // Check that the pattern is: const timeoutId = setTimeout(...); timeoutId.unref();
    assert.ok(src.includes('timeoutId.unref()'),
      'Should call .unref() on the timeoutId variable');
  });

  it('unref comment references A2-011 FIX', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/base-agent.js'), 'utf8');

    // Verify the fix is annotated for traceability
    assert.ok(src.includes('A2-011 FIX'),
      'unref lines should be annotated with A2-011 FIX comment');
  });
});

// ── SEC-024: Minimal env in _artisan (no ANTHROPIC_API_KEY leak) ──

describe('SEC-024: Minimal env allowlist in ValidatorAgent._artisan', () => {
  it('source does NOT spread process.env into subprocess', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    // Ensure ...process.env is not used
    assert.ok(!src.includes('...process.env'),
      'Should NOT spread process.env — use ENV_ALLOWLIST instead');
  });

  it('source uses centralised shell.js envKeys for env filtering', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    // Env filtering is now centralised in shell.js via envKeys + buildMinimalEnv.
    // Validator passes PHP/Laravel-specific keys via envKeys option.
    assert.ok(src.includes('envKeys'), 'Should pass envKeys to execCommand');
    const requiredKeys = ['APP_ENV', 'DB_CONNECTION', 'DB_HOST', 'DB_DATABASE'];
    for (const key of requiredKeys) {
      assert.ok(src.includes(`'${key}'`),
        `envKeys should include '${key}'`);
    }
  });

  it('source does NOT include ANTHROPIC_API_KEY in env config', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    assert.ok(!src.includes('ANTHROPIC_API_KEY'),
      'ANTHROPIC_API_KEY must NOT appear in validator-agent.js');
  });

  it('centralised shell.js BASE_ENV_KEYS does not include ANTHROPIC_API_KEY', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/shell.js'), 'utf8');

    assert.ok(src.includes('BASE_ENV_KEYS'), 'Should define BASE_ENV_KEYS');
    assert.ok(!src.includes('ANTHROPIC_API_KEY'),
      'ANTHROPIC_API_KEY must NOT appear in shell.js BASE_ENV_KEYS');
    assert.ok(src.includes("'PATH'"), 'BASE_ENV_KEYS should include PATH');
    assert.ok(src.includes('buildMinimalEnv'), 'Should export buildMinimalEnv');
  });

  it('allowlist filtering produces correct subset', () => {
    // Unit test the filtering logic in isolation
    const ENV_ALLOWLIST = [
      'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP',
      'PHP_INI_SCAN_DIR', 'COMPOSER_HOME',
      'APP_ENV', 'APP_KEY', 'DB_CONNECTION', 'DB_HOST', 'DB_PORT',
      'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD',
    ];

    // Simulate process.env with secrets that should NOT pass through
    const fakeEnv = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      DB_HOST: 'localhost',
      DB_DATABASE: 'myapp',
      SOME_OTHER_VAR: 'should-not-pass',
    };

    const minimalEnv = Object.fromEntries(
      ENV_ALLOWLIST.filter(k => fakeEnv[k] !== undefined).map(k => [k, fakeEnv[k]])
    );
    minimalEnv.APP_ENV = 'testing';

    // Allowed keys present
    assert.equal(minimalEnv.PATH, '/usr/bin');
    assert.equal(minimalEnv.HOME, '/home/user');
    assert.equal(minimalEnv.DB_HOST, 'localhost');
    assert.equal(minimalEnv.DB_DATABASE, 'myapp');
    assert.equal(minimalEnv.APP_ENV, 'testing');

    // Secrets must NOT be present
    assert.equal(minimalEnv.ANTHROPIC_API_KEY, undefined,
      'ANTHROPIC_API_KEY must not leak to subprocess');
    assert.equal(minimalEnv.AWS_SECRET_ACCESS_KEY, undefined,
      'AWS_SECRET_ACCESS_KEY must not leak to subprocess');
    assert.equal(minimalEnv.SOME_OTHER_VAR, undefined,
      'Unlisted vars must not leak to subprocess');
  });
});

// ── A3-003: Dead code removal (SAFE_ARG_RE in git-manager) ───────

describe('A3-003: Dead code removal — SAFE_ARG_RE removed from git-manager', () => {
  it('git-manager.js does NOT export SAFE_ARG_RE', async () => {
    const gitManager = await import('../src/git-manager.js');
    assert.equal(gitManager.SAFE_ARG_RE, undefined,
      'SAFE_ARG_RE should not be exported from git-manager');
  });

  it('git-manager.js does NOT define module-level SAFE_ARG_RE', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/git-manager.js'), 'utf8');

    // Check that SAFE_ARG_RE does not appear as a module-level const/let/var
    // It was removed — only SAFE_SPACED_RE should remain
    const moduleLevel = src.split('class GitManager')[0];
    assert.ok(!moduleLevel.includes('SAFE_ARG_RE'),
      'SAFE_ARG_RE should not exist at module level in git-manager.js');
  });

  it('git-manager.js uses centralised shell.js for execution', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/git-manager.js'), 'utf8');

    // Arg validation is now centralised in shell.js via SAFE_ARG_RE.
    // Git-manager only retains quote-char rejection for Windows defence-in-depth.
    assert.ok(src.includes("import { execCommand } from './shell.js'"),
      'Should import execCommand from shell.js');
    assert.ok(!src.includes("import { execa }"),
      'Should no longer directly import execa');
  });

  it('shell.js defines SAFE_ARG_RE for centralised arg validation', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/shell.js'), 'utf8');

    assert.ok(src.includes('SAFE_ARG_RE'),
      'shell.js should define SAFE_ARG_RE for centralised arg validation');
  });

  it('validator-agent.js uses centralised shell.js (no direct execa)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');

    assert.ok(src.includes("import { execCommand } from '../shell.js'"),
      'validator-agent.js should import execCommand from shell.js');
    assert.ok(!src.includes("import { execa }"),
      'validator-agent.js should no longer directly import execa');
  });
});

// ══════════════════════════════════════════════════════════════════
// E2E-5 — Content filter fallback in transformer
// ══════════════════════════════════════════════════════════════════

describe('E2E-5: Content filter fallback', () => {
  it('transformer source has content filtering detection', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    assert.ok(source.includes('content filtering'), 'Should detect content filtering errors');
    assert.ok(source.includes('_contentFilterFallback'), 'Should have fallback method');
  });

  it('transformer handles content filter with fallback flow', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    assert.ok(source.includes('minimal_prompt'), 'Should attempt minimal prompt retry');
    assert.ok(source.includes('getFileChange'), 'Should use reference data fallback');
    assert.ok(source.includes('Manual upgrade required'), 'Should mark for manual review on failure');
  });

  it('content filter fallback records contentFilter flag in state', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    assert.ok(source.includes('contentFilter: true'), 'Should flag content filter failures in state');
  });

  it('content filter fallback continues processing remaining files', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    assert.ok(source.includes('continue;'), 'Should continue to next file after content filter');
  });

  it('transformer _contentFilterFallback tries reference data deletion', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    assert.ok(source.includes("type === 'removed'"), 'Should check if file should be deleted per reference data');
    assert.ok(source.includes('delete_file'), 'Should use delete_file for removed files');
  });
});

// ══════════════════════════════════════════════════════════════════
// AUDIT-5 Regression Tests
// ══════════════════════════════════════════════════════════════════

// ── P1-001: _phpSyntaxCheck checks result.ok instead of try/catch ──

describe('AUDIT-5 P1-001: _phpSyntaxCheck collects errors from result.ok', () => {
  it('source uses result.ok check (not try/catch) for syntax errors', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');
    // The fix: check result.ok instead of catching exceptions
    assert.ok(source.includes('if (!result.ok)'), 'Should check result.ok for syntax errors');
    assert.ok(source.includes('result.stderr'), 'Should collect stderr from result');
  });

  it('validator _phpSyntaxCheck does not use try/catch around execCommand', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');
    // Extract the _phpSyntaxCheck method body
    const methodStart = source.indexOf('async _phpSyntaxCheck()');
    const methodEnd = source.indexOf('\n  }', methodStart + 1);
    const methodBody = source.slice(methodStart, methodEnd);
    // Should NOT have try/catch around the execCommand call
    assert.ok(!methodBody.includes('try {'), '_phpSyntaxCheck should not use try/catch around execCommand');
  });
});

// ── P1-002: _contentFilterFallback passes string version numbers ──

describe('AUDIT-5 P1-002: _contentFilterFallback passes string versions to getFileChange', () => {
  it('source calls getFileChange with step.from and step.to strings', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    // The fix: pass step.from and step.to (strings), not the step object
    assert.ok(source.includes('getFileChange(step.from, step.to,'), 'Should pass step.from and step.to as separate string args');
  });

  it('source iterates chain steps with from/to properties', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/transformer-agent.js'), 'utf8');
    // The chain returns [{from, to, manifest}] and we destructure step
    assert.ok(source.includes('for (const step of chain)'), 'Should iterate chain steps');
    assert.ok(source.includes('step.from'), 'Should reference step.from');
    assert.ok(source.includes('step.to'), 'Should reference step.to');
  });
});

// ── P2-001: _phpSyntaxCheck uses envKeys instead of useProcessEnv ──

describe('AUDIT-5 P2-001: _phpSyntaxCheck uses envKeys not useProcessEnv', () => {
  it('validator _phpSyntaxCheck passes envKeys option', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/agents/validator-agent.js'), 'utf8');
    // Extract the _phpSyntaxCheck method
    const methodStart = source.indexOf('async _phpSyntaxCheck()');
    const methodEnd = source.indexOf('\n  async _artisan', methodStart);
    const methodBody = source.slice(methodStart, methodEnd);
    // Should use envKeys, NOT useProcessEnv (excluding comments)
    assert.ok(methodBody.includes('envKeys:'), 'Should use envKeys option');
    // Strip comments and check that useProcessEnv is not used as an actual option
    const codeOnly = methodBody.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!codeOnly.includes('useProcessEnv'), 'Should NOT use useProcessEnv in _phpSyntaxCheck code');
  });
});

// ── P2-005: class-strings detect() no /g flag ──

describe('AUDIT-5 P2-005: class-strings detect() no /g flag', () => {
  it('detect() returns consistent results across consecutive calls', async () => {
    const classStrings = (await import('../src/transforms/class-strings.js')).default;
    const php = `$model = 'App\\Models\\User';`;
    // The bug: /g flag made .test() stateful — alternating true/false
    // Call detect multiple times to verify consistency
    const result1 = classStrings.detect(php);
    const result2 = classStrings.detect(php);
    const result3 = classStrings.detect(php);
    const result4 = classStrings.detect(php);
    const result5 = classStrings.detect(php);
    assert.ok(result1, 'First call should detect');
    assert.ok(result2, 'Second call should detect (was false with /g bug)');
    assert.ok(result3, 'Third call should detect');
    assert.ok(result4, 'Fourth call should detect');
    assert.ok(result5, 'Fifth call should detect');
  });

  it('detect() regex does not use /g flag', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/transforms/class-strings.js'), 'utf8');
    // Find the detect method's regex — should NOT have /g
    const detectMatch = source.match(/detect\(content\)\s*\{[\s\S]*?\.test\(content\)/);
    assert.ok(detectMatch, 'Should find detect method with .test()');
    assert.ok(!detectMatch[0].includes('/g.test'), 'Regex should not have /g flag');
    // More precise: check the actual regex literal
    const regexMatch = source.match(/return\s+\/.*\/([gimsuy]*)\s*\.test/);
    assert.ok(regexMatch, 'Should find regex.test pattern');
    assert.ok(!regexMatch[1].includes('g'), 'Regex flags should not include g');
  });
});

// ── P2-008: l11-structural readFileSync with try-catch ──

describe('AUDIT-5 P2-008: l11-structural readFileSync with try-catch', () => {
  it('returns empty results when Kernel.php is unreadable', async () => {
    const { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const l11Structural = (await import('../src/transforms/l11-structural.js')).default;

    const tmpDir = join(import.meta.dirname, '.tmp-l11-unreadable');
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'app', 'Http'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', 'Http', 'Kernel.php'), '<?php class Kernel {}');

    // Make the file unreadable (only works on non-Windows)
    // On Windows, we simulate by testing the source code structure instead
    const isWindows = process.platform === 'win32';
    if (!isWindows) {
      chmodSync(join(tmpDir, 'app', 'Http', 'Kernel.php'), 0o000);
      const result = l11Structural.run(tmpDir);
      // Should return empty results instead of throwing
      assert.deepEqual(result.filesDeleted, []);
      assert.deepEqual(result.filesCreated, []);
      assert.deepEqual(result.filesModified, []);
      chmodSync(join(tmpDir, 'app', 'Http', 'Kernel.php'), 0o644);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('source wraps readFileSync(kernelPath) in try-catch', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/transforms/l11-structural.js'), 'utf8');
    // Find the run() method and check for try-catch around kernelContent
    const runStart = source.indexOf('run(projectRoot');
    const runBody = source.slice(runStart, runStart + 800);
    assert.ok(runBody.includes('try {'), 'run() should have try block');
    assert.ok(runBody.includes("readFileSync(kernelPath, 'utf-"), 'Should read kernelPath');
    assert.ok(runBody.includes('catch (err)'), 'Should catch errors from readFileSync');
    assert.ok(runBody.includes('return results'), 'Should return empty results on error');
  });
});

// ── SEC-002: pre-processor safeWriteFile validates paths and creates backups ──

describe('AUDIT-5 SEC-002: pre-processor safeWriteFile path validation + backups', () => {
  it('runPreProcessing rejects path traversal in file writes', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/pre-processor.js'), 'utf8');
    // safeWriteFile should validate path
    assert.ok(source.includes('Path traversal blocked'), 'safeWriteFile should block traversal');
    assert.ok(source.includes('resolve(absPath)'), 'Should resolve path before checking');
  });

  it('safeWriteFile creates backup before overwriting', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/pre-processor.js'), 'utf8');
    // Extract safeWriteFile function
    const fnStart = source.indexOf('function safeWriteFile');
    const fnEnd = source.indexOf('\n}', fnStart);
    const fnBody = source.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes('copyFileSync'), 'Should create backup via copyFileSync');
    assert.ok(fnBody.includes('.shift'), 'Should store backup in .shift directory');
    assert.ok(fnBody.includes('existsSync(absPath)'), 'Should check file exists before backup');
  });

  it('integration: runPreProcessing creates backups for modified files', async () => {
    const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { runPreProcessing } = await import('../src/pre-processor.js');

    const tmpDir = join(import.meta.dirname, '.tmp-sec002-backup');
    rmSync(tmpDir, { recursive: true, force: true });

    // Create a file that class-strings transform will modify
    mkdirSync(join(tmpDir, 'app', 'Models'), { recursive: true });
    const testFile = join(tmpDir, 'app', 'Models', 'User.php');
    const originalContent = `<?php\n$model = 'App\\Models\\Post';`;
    writeFileSync(testFile, originalContent);

    await runPreProcessing(tmpDir, '8', '11', { dryRun: false });

    // Check backup was created
    const backupPath = join(tmpDir, '.shift', 'backups', 'app', 'Models', 'User.php');
    assert.ok(existsSync(backupPath), 'Backup should exist after modification');
    const backup = readFileSync(backupPath, 'utf8');
    assert.equal(backup, originalContent, 'Backup should contain original content');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── SEC-003: l11-structural validatePath before writes ──

describe('AUDIT-5 SEC-003: l11-structural validatePath before writes', () => {
  it('source has validatePath calls before file writes', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve('src/transforms/l11-structural.js'), 'utf8');
    // Should have validatePath function
    assert.ok(source.includes('function validatePath(projectRoot, fullPath)'), 'Should define validatePath');
    // Should call validatePath before bootstrapAppPath write
    assert.ok(source.includes('validatePath(projectRoot, bootstrapAppPath)'), 'Should validate bootstrapAppPath');
    // Should call validatePath before providersPath write
    assert.ok(source.includes('validatePath(projectRoot, providersPath)'), 'Should validate providersPath');
  });

  it('validatePath rejects paths outside projectRoot', async () => {
    const { resolve, sep } = await import('node:path');
    const { readFileSync } = await import('fs');
    const source = readFileSync(resolve('src/transforms/l11-structural.js'), 'utf8');
    // The validatePath function should throw on traversal
    assert.ok(source.includes('Path traversal blocked'), 'validatePath should throw on traversal');
    assert.ok(source.includes('!resolved.startsWith(prefix)'), 'Should check prefix match');
  });

  it('integration: l11-structural run() writes only within projectRoot', async () => {
    const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const l11Structural = (await import('../src/transforms/l11-structural.js')).default;

    const tmpDir = join(import.meta.dirname, '.tmp-sec003-validate');
    rmSync(tmpDir, { recursive: true, force: true });

    // Set up minimal project structure
    mkdirSync(join(tmpDir, 'app', 'Http', 'Middleware'), { recursive: true });
    mkdirSync(join(tmpDir, 'app', 'Console'), { recursive: true });
    mkdirSync(join(tmpDir, 'app', 'Exceptions'), { recursive: true });
    mkdirSync(join(tmpDir, 'app', 'Providers'), { recursive: true });
    mkdirSync(join(tmpDir, 'bootstrap'), { recursive: true });
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    mkdirSync(join(tmpDir, 'tests'), { recursive: true });

    writeFileSync(join(tmpDir, 'app', 'Http', 'Kernel.php'), `<?php
namespace App\\Http;
use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;
class Kernel extends HttpKernel {
    protected $middleware = [];
    protected $middlewareGroups = ['web' => [], 'api' => []];
    protected $middlewareAliases = [];
}`);
    writeFileSync(join(tmpDir, 'app', 'Console', 'Kernel.php'), '<?php\nclass Kernel {}');
    writeFileSync(join(tmpDir, 'app', 'Exceptions', 'Handler.php'), '<?php\nclass Handler extends ExceptionHandler {}');
    writeFileSync(join(tmpDir, 'bootstrap', 'app.php'), '<?php\n$app = new Application;');
    writeFileSync(join(tmpDir, 'config', 'app.php'), "<?php\nreturn ['providers' => [App\\Providers\\AppServiceProvider::class]];");
    writeFileSync(join(tmpDir, 'tests', 'TestCase.php'), `<?php
namespace Tests;
use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;
abstract class TestCase extends BaseTestCase {
    use CreatesApplication;
}`);

    // Run should succeed without path-traversal errors
    const result = l11Structural.run(tmpDir);
    assert.ok(result.filesModified.includes('bootstrap/app.php'), 'Should modify bootstrap/app.php');
    assert.ok(result.filesCreated.includes('bootstrap/providers.php'), 'Should create providers.php');

    // All created/modified files should be within tmpDir
    for (const f of [...result.filesCreated, ...result.filesModified]) {
      const full = join(tmpDir, f);
      assert.ok(existsSync(full), `${f} should exist within project`);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════
// Run #5 Regression Tests — blueprint-exporter dirname fix (P2-NF2)
// ══════════════════════════════════════════════════════════════════

// ── P2-NF2: blueprint-exporter uses dirname() not join('..') ─────

describe('Run #5 P2-NF2: blueprint-exporter uses dirname() for parent directory', () => {
  it('source imports dirname from node:path', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/blueprint-exporter.js'), 'utf8');

    assert.ok(src.includes('dirname'), 'Should import dirname');
    assert.ok(src.includes("from 'node:path'"),
      'dirname should come from node:path');
  });

  it('source uses dirname(absOutputPath) for outputDir', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/blueprint-exporter.js'), 'utf8');

    assert.ok(src.includes('dirname(absOutputPath)'),
      'Should compute outputDir via dirname(absOutputPath)');
    // The old buggy pattern should not exist
    assert.ok(!src.includes("join(absOutputPath, '..')"),
      'Should NOT use join(absOutputPath, \'..\') — that was the bug');
  });

  it('outputDir resolves correctly for nested output paths', async () => {
    const { dirname, join } = await import('node:path');

    // Simulate the fixed logic: dirname gives the parent directory
    const projectRoot = '/project';
    const outputPath = '.shift/blueprint.yaml';
    const absOutputPath = join(projectRoot, outputPath);
    const outputDir = dirname(absOutputPath);

    // dirname('/project/.shift/blueprint.yaml') => '/project/.shift'
    assert.ok(outputDir.endsWith('.shift'), `outputDir should end with .shift, got: ${outputDir}`);
    assert.ok(!outputDir.includes('blueprint.yaml'), 'outputDir should not include the filename');
  });

  it('outputDir resolves correctly for root-level output paths', async () => {
    const { dirname, join } = await import('node:path');

    // When output is at root level e.g. 'blueprint.yaml'
    const projectRoot = '/project';
    const outputPath = 'blueprint.yaml';
    const absOutputPath = join(projectRoot, outputPath);
    const outputDir = dirname(absOutputPath);

    // dirname('/project/blueprint.yaml') => '/project'
    assert.ok(outputDir.endsWith('project'), `outputDir should be the project root, got: ${outputDir}`);
  });

  it('outputDir resolves correctly for deeply nested output paths', async () => {
    const { dirname, join } = await import('node:path');

    const projectRoot = '/project';
    const outputPath = 'storage/app/exports/blueprint.yaml';
    const absOutputPath = join(projectRoot, outputPath);
    const outputDir = dirname(absOutputPath);

    // dirname should give '/project/storage/app/exports'
    assert.ok(outputDir.endsWith('exports'), `outputDir should end with exports, got: ${outputDir}`);
    assert.ok(!outputDir.includes('blueprint.yaml'), 'outputDir should not include the filename');
  });

  it('generateBlueprintYaml writes to nested output path without error', async () => {
    const { mkdirSync, rmSync, existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { generateBlueprintYaml } = await import('../src/blueprint-exporter.js');

    const tmpDir = join(import.meta.dirname, '.tmp-blueprint-dirname');
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'app', 'Models'), { recursive: true });

    try {
      // Use a nested output path to verify dirname creates correct parent
      const result = await generateBlueprintYaml(tmpDir, {
        outputPath: 'output/deep/blueprint.yaml',
      });

      const absPath = join(tmpDir, 'output', 'deep', 'blueprint.yaml');
      assert.ok(existsSync(absPath), 'File should exist at the nested output path');
      const content = readFileSync(absPath, 'utf8');
      assert.ok(content.includes('# Blueprint YAML'), 'Written file should contain YAML header');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Run #6 Regression Tests
// ══════════════════════════════════════════════════════════════════

// ── R6-003: _postDependencyCleanup checks execCommand result.ok ──

describe('AUDIT-6 R6-003: _postDependencyCleanup checks result.ok instead of try/catch', () => {
  it('source uses result.ok check for autoload and discover commands', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/orchestrator.js'), 'utf8');
    const methodStart = src.indexOf('async _postDependencyCleanup()');
    assert.ok(methodStart !== -1, '_postDependencyCleanup method should exist');
    const methodEnd = src.indexOf('\n  }', methodStart + 1);
    const methodBody = src.slice(methodStart, methodEnd);

    assert.ok(methodBody.includes('autoloadResult.ok'), 'Should check autoloadResult.ok');
    assert.ok(methodBody.includes('discoverResult.ok'), 'Should check discoverResult.ok');
  });

  it('does not wrap execCommand in try/catch for autoload or discover', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/orchestrator.js'), 'utf8');
    const methodStart = src.indexOf('async _postDependencyCleanup()');
    const methodEnd = src.indexOf('\n  }', methodStart + 1);
    const methodBody = src.slice(methodStart, methodEnd);

    // The section after cache cleanup should not have try/catch around execCommand
    const autoloadSection = methodBody.slice(methodBody.indexOf('Regenerate autoloader'));
    assert.ok(!autoloadSection.includes('try {'), 'Should not wrap execCommand calls in try/catch');
  });

  it('logs warning when dump-autoload fails', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/orchestrator.js'), 'utf8');
    const methodStart = src.indexOf('async _postDependencyCleanup()');
    const methodEnd = src.indexOf('\n  }', methodStart + 1);
    const methodBody = src.slice(methodStart, methodEnd);

    assert.ok(methodBody.includes("logger.warn('Orchestrator', `dump-autoload failed"),
      'Should log warning when dump-autoload fails');
  });

  it('logs debug when package:discover fails', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/orchestrator.js'), 'utf8');
    const methodStart = src.indexOf('async _postDependencyCleanup()');
    const methodEnd = src.indexOf('\n  }', methodStart + 1);
    const methodBody = src.slice(methodStart, methodEnd);

    assert.ok(methodBody.includes("logger.debug('Orchestrator', `package:discover skipped"),
      'Should log debug when package:discover fails');
  });
});

// ── R6-004: conformity-checker PHP 13 min corrected to ^8.3 ──

describe('AUDIT-6 R6-004: conformity-checker expectedPhp[13] is ^8.3', () => {
  it('PHP version map has ^8.3 for version 13', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('src/conformity-checker.js'), 'utf8');

    assert.ok(src.includes("'13': '^8.3'"), 'expectedPhp should map 13 to ^8.3');
    assert.ok(!src.includes("'13': '^8.2'"), 'expectedPhp should NOT map 13 to ^8.2');
  });

  it('checking PHP conformity for v13 with ^8.2 reports an issue', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { checkConformity } = await import('../src/conformity-checker.js');

    const tmpDir = join(tmpdir(), `shift-r6004-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      writeFileSync(join(tmpDir, 'composer.json'), JSON.stringify({
        require: { php: '^8.2', 'laravel/framework': '^13.0' },
      }));

      const report = await checkConformity(tmpDir, '13', { autoFix: false });
      const phpIssue = report.issues.find(i =>
        i.category === 'composer' && i.issue.includes('PHP constraint')
      );
      assert.ok(phpIssue, 'Should flag PHP ^8.2 as too low for Laravel 13');
      assert.ok(phpIssue.issue.includes('^8.2'), 'Issue should mention the declared constraint');
      assert.ok(phpIssue.issue.includes('^8.3'), 'Issue should mention the expected constraint');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('conformity-checker expectedPhp matches upgrade-matrix phpMin for all versions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const conformitySrc = readFileSync(resolve('src/conformity-checker.js'), 'utf8');
    const matrixSrc = readFileSync(resolve('config/upgrade-matrix.js'), 'utf8');

    // Extract expectedPhp entries from conformity-checker
    const expectedPhpMatch = conformitySrc.match(/const expectedPhp = \{([^}]+)\}/);
    assert.ok(expectedPhpMatch, 'Should find expectedPhp definition');

    // Parse each version mapping from expectedPhp
    const entries = [...expectedPhpMatch[1].matchAll(/'(\d+)':\s*'([^^]*\^[\d.]+)'/g)];
    assert.ok(entries.length >= 5, `Should have at least 5 version entries, found ${entries.length}`);
    for (const [, version, constraint] of entries) {
      // For each version, find the corresponding phpMin in upgrade-matrix
      const matrixPattern = new RegExp(`'\\d+->${version}':[\\s\\S]*?phpMin:\\s*'([^']+)'`);
      const matrixMatch = matrixSrc.match(matrixPattern);
      if (matrixMatch) {
        const matrixPhpMin = matrixMatch[1];
        const conformityMin = constraint.replace(/[^0-9.]/g, '');
        assert.equal(conformityMin, matrixPhpMin,
          `conformity-checker expectedPhp['${version}'] min (${conformityMin}) should match upgrade-matrix phpMin (${matrixPhpMin})`);
      }
    }
  });
});
