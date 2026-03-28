/**
 * Tests for src/shell.js — centralised shell execution utility.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execCommand, execCommandSync, SAFE_ARG_RE, BASE_ENV_KEYS, buildMinimalEnv } from '../src/shell.js';

// ── SAFE_ARG_RE ──

describe('shell.js SAFE_ARG_RE', () => {
  it('allows safe arguments', () => {
    const safe = ['config:clear', 'route:list', '--json', '-m', 'hello world', 'v10.0', 'refs/heads/main', 'a=b', '^HEAD~1'];
    for (const arg of safe) {
      assert.ok(SAFE_ARG_RE.test(arg), `Should allow: ${arg}`);
    }
  });

  it('rejects shell metacharacters', () => {
    const unsafe = ['$(cmd)', '`cmd`', 'a;b', 'a|b', 'a&b', 'a>b', 'a<b', "a'b", 'a"b', 'a\\b', 'a\nb'];
    for (const arg of unsafe) {
      assert.ok(!SAFE_ARG_RE.test(arg), `Should reject: ${JSON.stringify(arg)}`);
    }
  });
});

// ── buildMinimalEnv ──

describe('shell.js buildMinimalEnv', () => {
  it('returns only BASE_ENV_KEYS that exist in process.env', () => {
    const env = buildMinimalEnv();
    // PATH should always exist
    assert.ok('PATH' in env || 'Path' in process.env, 'Should include PATH if it exists');
    // Should not include random keys
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'Should not include ANTHROPIC_API_KEY');
  });

  it('includes extra keys when specified', () => {
    const orig = process.env.TEST_SHELL_EXTRA;
    process.env.TEST_SHELL_EXTRA = 'test-value';
    try {
      const env = buildMinimalEnv(['TEST_SHELL_EXTRA']);
      assert.equal(env.TEST_SHELL_EXTRA, 'test-value');
    } finally {
      if (orig === undefined) delete process.env.TEST_SHELL_EXTRA;
      else process.env.TEST_SHELL_EXTRA = orig;
    }
  });

  it('applies overrides', () => {
    const env = buildMinimalEnv([], { APP_ENV: 'testing' });
    assert.equal(env.APP_ENV, 'testing');
  });
});

// ── execCommand ──

describe('shell.js execCommand', () => {
  it('rejects unsafe arguments by default', async () => {
    const result = await execCommand('echo', ['hello;world']);
    assert.equal(result.ok, false);
    assert.ok(result.stderr.includes('Blocked unsafe argument'));
  });

  it('allows unsafe arguments when opted in', async () => {
    // Just test it doesn't block — the command itself may fail
    const result = await execCommand('echo', ['hello;world'], { allowUnsafeArgs: true, useProcessEnv: true });
    // We don't check ok because echo may or may not handle this, but it shouldn't be blocked
    assert.ok(!result.stderr.includes('Blocked unsafe argument'));
  });

  it('requires shellReason when shell: true is explicit', async () => {
    const result = await execCommand('echo', ['hello'], { shell: true });
    assert.equal(result.ok, false);
    assert.ok(result.stderr.includes('shellReason'));
  });

  it('accepts shell: true with shellReason', async () => {
    const result = await execCommand('echo', ['hello'], {
      shell: true,
      shellReason: 'test',
      useProcessEnv: true,
    });
    assert.equal(result.ok, true);
    assert.ok(result.stdout.includes('hello'));
  });

  it('returns structured result on success', async () => {
    const result = await execCommand('node', ['--version'], { useProcessEnv: true });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.startsWith('v'));
    assert.equal(typeof result.stderr, 'string');
  });

  it('returns structured result on failure (non-zero exit)', async () => {
    const result = await execCommand('node', ['-e', 'process.exit(42)'], {
      allowUnsafeArgs: true,
      useProcessEnv: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 42);
  });

  it('throws on failure when throwOnError is set', async () => {
    await assert.rejects(
      () => execCommand('node', ['-e', 'process.exit(1)'], {
        allowUnsafeArgs: true,
        throwOnError: true,
        useProcessEnv: true,
      }),
    );
  });

  it('enforces timeout', async () => {
    const result = await execCommand('node', ['-e', 'setTimeout(()=>{},60000)'], {
      timeout: 500,
      allowUnsafeArgs: true,
      useProcessEnv: true,
    });
    assert.equal(result.ok, false);
  });

  it('handles command not found gracefully', async () => {
    const result = await execCommand('__nonexistent_command_12345__', [], { useProcessEnv: true });
    assert.equal(result.ok, false);
    assert.ok(result.stderr.length > 0);
  });

  it('uses minimal environment by default', async () => {
    // Run node to print env keys — should NOT include ANTHROPIC_API_KEY
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-12345';
    try {
      const result = await execCommand('node', ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], {
        allowUnsafeArgs: true,
      });
      assert.equal(result.ok, true);
      const keys = JSON.parse(result.stdout);
      assert.ok(!keys.includes('ANTHROPIC_API_KEY'), 'Should not leak ANTHROPIC_API_KEY');
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });
});

// ── execCommandSync ──

describe('shell.js execCommandSync', () => {
  it('returns structured result on success', () => {
    const result = execCommandSync('node', ['--version']);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.startsWith('v'));
  });

  it('returns structured result on failure', () => {
    const result = execCommandSync('node', ['-e', 'process.exit(1)']);
    assert.equal(result.ok, false);
  });

  it('handles command not found', () => {
    const result = execCommandSync('__nonexistent_command_12345__', []);
    assert.equal(result.ok, false);
  });

  it('supports stdio: ignore', () => {
    const result = execCommandSync('node', ['--version'], { stdio: 'ignore' });
    assert.equal(result.ok, true);
  });
});

// ── BASE_ENV_KEYS ──

describe('shell.js BASE_ENV_KEYS', () => {
  it('includes PATH and HOME', () => {
    assert.ok(BASE_ENV_KEYS.includes('PATH'));
    assert.ok(BASE_ENV_KEYS.includes('HOME'));
  });

  it('does not include sensitive keys', () => {
    assert.ok(!BASE_ENV_KEYS.includes('ANTHROPIC_API_KEY'));
    assert.ok(!BASE_ENV_KEYS.includes('AWS_SECRET_ACCESS_KEY'));
  });
});
