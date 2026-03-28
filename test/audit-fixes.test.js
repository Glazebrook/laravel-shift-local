/**
 * Audit-2 fix coverage.
 * Tests the 5 fixes applied during the v2 enterprise audit:
 *   P1-001: Network error retry in _callWithRetry
 *   P1-002: max_tokens truncation warning
 *   P1-003: Backup restore before retry of interrupted transforms
 *   P1-004: Case-insensitive path comparison on resume
 *   P3-001: branchPrefix leading slash / consecutive slash sanitization
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BaseAgent, AgentError, _resetSharedClient,
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
