/**
 * Integration tests for the full shift pipeline.
 *
 * These tests validate the pipeline mechanics (state management, resume, rollback)
 * using mock agents. They do NOT call the real Anthropic API.
 *
 * For full end-to-end tests with real API calls:
 *   ANTHROPIC_API_KEY=sk-... npm run test:integration
 *
 * Run: npm run test:integration
 * Or:  docker compose -f test/integration/docker-compose.yml up --build
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'laravel10-app');

/**
 * Create a fresh copy of the fixture project in a temp directory with git init.
 */
function createTestProject() {
  const tmp = mkdtempSync(join(tmpdir(), 'shift-integration-'));
  cpSync(FIXTURE_PATH, tmp, { recursive: true });
  execSync('git init && git add -A && git commit -m "initial"', { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ── Fixture validation ──

describe('Integration: Fixture project validation', () => {
  it('fixture has valid composer.json', () => {
    const composerPath = join(FIXTURE_PATH, 'composer.json');
    assert.ok(existsSync(composerPath), 'composer.json should exist');
    const composer = JSON.parse(readFileSync(composerPath, 'utf8'));
    assert.ok(composer.require['laravel/framework'].includes('^10'), 'Should require Laravel 10');
  });

  it('fixture has valid PHP files', () => {
    const files = [
      'app/Http/Kernel.php',
      'app/Providers/AppServiceProvider.php',
      'config/app.php',
      'routes/web.php',
    ];
    for (const f of files) {
      assert.ok(existsSync(join(FIXTURE_PATH, f)), `${f} should exist`);
      const content = readFileSync(join(FIXTURE_PATH, f), 'utf8');
      assert.ok(content.includes('<?php'), `${f} should be a PHP file`);
    }
  });

  it('fixture has Laravel 10 patterns that need upgrading', () => {
    const kernel = readFileSync(join(FIXTURE_PATH, 'app/Http/Kernel.php'), 'utf8');
    assert.ok(kernel.includes('class Kernel extends HttpKernel'), 'Should have HTTP Kernel (deprecated in L11)');
    assert.ok(kernel.includes('$middleware'), 'Should have middleware arrays');

    const appConfig = readFileSync(join(FIXTURE_PATH, 'config/app.php'), 'utf8');
    assert.ok(appConfig.includes("'providers'"), 'Should have providers array (moved in L11)');
  });
});

// ── StateManager integration ──

describe('Integration: StateManager with fixture project', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createTestProject();
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it('initialises state in fixture project', async () => {
    const { StateManager } = await import('../../src/state-manager.js');
    const sm = new StateManager(projectDir);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: projectDir });

    assert.ok(existsSync(join(projectDir, '.shift', 'state.json')), 'state.json should be created');
    const state = sm.get();
    assert.equal(state.fromVersion, '10');
    assert.equal(state.toVersion, '11');
    assert.ok(state.branchName.includes('10'));

    sm.destroy();
  });

  it('resumes from existing state', async () => {
    const { StateManager } = await import('../../src/state-manager.js');

    // First init
    const sm1 = new StateManager(projectDir);
    sm1.init({ fromVersion: '10', toVersion: '11', projectPath: projectDir });
    sm1.markPhaseComplete('ANALYZING');
    sm1.set('analysis', { summary: 'test analysis' });
    sm1.destroy();

    // Resume in new instance
    const sm2 = new StateManager(projectDir);
    const result = sm2.init({ fromVersion: '10', toVersion: '11', projectPath: projectDir });
    assert.equal(result.resumed, true);
    assert.ok(sm2.isPhaseComplete('ANALYZING'));
    assert.equal(sm2.get('analysis').summary, 'test analysis');

    sm2.destroy();
  });
});

// ── FileTools integration ──

describe('Integration: FileTools with fixture project', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createTestProject();
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it('reads fixture PHP files', async () => {
    const { FileTools } = await import('../../src/file-tools.js');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {} };
    const ft = new FileTools(projectDir, mockLogger);

    const kernel = ft.readFile('app/Http/Kernel.php');
    assert.ok(kernel.includes('class Kernel extends HttpKernel'));
  });

  it('reads and parses composer.json', async () => {
    const { FileTools } = await import('../../src/file-tools.js');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {} };
    const ft = new FileTools(projectDir, mockLogger);

    const composer = ft.readJson('composer.json');
    assert.equal(composer.require['laravel/framework'], '^10.0');
  });

  it('creates backup and restores', async () => {
    const { FileTools } = await import('../../src/file-tools.js');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {} };
    const ft = new FileTools(projectDir, mockLogger);

    const original = ft.readFile('config/app.php');
    ft.backup('config/app.php');
    ft.writeFile('config/app.php', '<?php return [];');
    ft.restore('config/app.php');
    const restored = ft.readFile('config/app.php');
    assert.equal(restored, original);
  });

  it('blocks path traversal', async () => {
    const { FileTools } = await import('../../src/file-tools.js');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {} };
    const ft = new FileTools(projectDir, mockLogger);

    assert.throws(() => ft.readFile('../../etc/passwd'), (err) => {
      return err.code === 'SHIFT_TRAVERSAL';
    });
  });
});

// ── GitManager integration ──

describe('Integration: GitManager with fixture project', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createTestProject();
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it('detects git repo', async () => {
    const { GitManager } = await import('../../src/git-manager.js');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {} };
    const gm = new GitManager(projectDir, mockLogger);
    assert.ok(await gm.isGitRepo());
  });

  it('creates upgrade branch and commits', async () => {
    const { GitManager } = await import('../../src/git-manager.js');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {} };
    const gm = new GitManager(projectDir, mockLogger);

    const result = await gm.createOrCheckoutBranch('shift/upgrade-10-to-11');
    assert.ok(result.ok);

    const branch = await gm.getCurrentBranch();
    assert.equal(branch, 'shift/upgrade-10-to-11');
  });

  it('creates backup tag and rolls back', async () => {
    const { GitManager } = await import('../../src/git-manager.js');
    const { writeFileSync } = await import('node:fs');
    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {} };
    const gm = new GitManager(projectDir, mockLogger);

    const tag = await gm.createBackupTag('test');
    assert.ok(tag.startsWith('shift-backup-test-'));

    // Make a change and commit
    writeFileSync(join(projectDir, 'test-file.txt'), 'test content');
    await gm.addAll();
    await gm.commit('test change');

    // Rollback
    const rollback = await gm.rollbackToTag(tag);
    assert.ok(rollback.ok);

    // Verify the test file no longer exists
    assert.ok(!existsSync(join(projectDir, 'test-file.txt')));
  });
});

// ── Cost guardrail ──

describe('Integration: Cost guardrail (maxTotalTokens)', () => {
  it('token tracker shared reference accumulates', async () => {
    const { BaseAgent, _resetSharedClient } = await import('../../src/agents/base-agent.js');

    const tracker = { input: 0, output: 0 };
    const maxTotal = 100; // Very low cap

    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 60, output_tokens: 50 },
          stop_reason: 'end_turn',
        }),
      },
    };
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('Test', {
      model: 'test',
      logger: { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {}, error: async () => {}, tool: async () => {} },
      tokenTracker: tracker,
      maxTotalTokens: maxTotal,
    });

    // First call should exceed 100 total tokens (60 + 50 = 110)
    await assert.rejects(
      () => agent.run('system', [{ role: 'user', content: 'test' }]),
      (err) => err.code === 'AGENT_ERR_TOKEN_LIMIT'
    );

    _resetSharedClient(null);
  });
});
