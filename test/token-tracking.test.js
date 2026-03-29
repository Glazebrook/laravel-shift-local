/**
 * Tests for per-agent token cost tracking (Phase 3).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── BaseAgent token tracking ──

describe('BaseAgent per-agent token tracking', () => {
  let BaseAgent, _resetSharedClient;

  beforeEach(async () => {
    const mod = await import('../src/agents/base-agent.js');
    BaseAgent = mod.BaseAgent;
    _resetSharedClient = mod._resetSharedClient;
  });

  it('initialises _tokenUsage to zeros', () => {
    const agent = new BaseAgent('Test', {
      model: 'test',
      logger: { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {}, error: async () => {} },
    });
    const usage = agent.tokenUsage;
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
    assert.equal(usage.calls, 0);
  });

  it('tokenUsage getter returns a copy (not mutable reference)', () => {
    const agent = new BaseAgent('Test', {
      model: 'test',
      logger: { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {}, error: async () => {} },
    });
    const usage1 = agent.tokenUsage;
    usage1.input = 9999;
    const usage2 = agent.tokenUsage;
    assert.equal(usage2.input, 0, 'Mutating the returned object should not affect the agent');
  });

  it('accumulates token usage across multiple API calls', async () => {
    let callCount = 0;
    const mockClient = {
      messages: {
        create: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tool1', name: 'test_tool', input: {} }],
              usage: { input_tokens: 100, output_tokens: 50 },
              stop_reason: 'tool_use',
            };
          }
          return {
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 200, output_tokens: 75 },
            stop_reason: 'end_turn',
          };
        },
      },
    };

    _resetSharedClient(mockClient);

    const agent = new BaseAgent('Test', {
      model: 'test',
      logger: { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {}, error: async () => {}, tool: async () => {} },
    });

    const tools = {
      definitions: [{ name: 'test_tool', description: 'test', input_schema: { type: 'object', properties: {} } }],
      handlers: { test_tool: async () => 'ok' },
    };

    await agent.run('system', [{ role: 'user', content: 'test' }], tools);

    const usage = agent.tokenUsage;
    assert.equal(usage.input, 300, 'Should accumulate input tokens: 100 + 200');
    assert.equal(usage.output, 125, 'Should accumulate output tokens: 50 + 75');
    assert.equal(usage.calls, 2, 'Should count 2 API calls');

    _resetSharedClient(null);
  });
});

// ── StateManager token usage persistence ──

describe('StateManager token usage persistence', () => {
  let StateManager;

  beforeEach(async () => {
    const mod = await import('../src/state-manager.js');
    StateManager = mod.StateManager;
  });

  it('setTokenUsage and getTokenUsage round-trip', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmp = mkdtempSync(join(tmpdir(), 'shift-test-'));
    const sm = new StateManager(tmp);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tmp });

    sm.setTokenUsage('analyzer', { input: 1000, output: 500, calls: 3 });
    sm.setTokenUsage('planner', { input: 2000, output: 800, calls: 5 });

    const usage = sm.getTokenUsage();
    assert.deepEqual(usage.analyzer, { input: 1000, output: 500, calls: 3 });
    assert.deepEqual(usage.planner, { input: 2000, output: 800, calls: 5 });

    sm.destroy();
  });

  it('getTokenUsage returns empty object when no data', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmp = mkdtempSync(join(tmpdir(), 'shift-test-'));
    const sm = new StateManager(tmp);
    sm.init({ fromVersion: '10', toVersion: '11', projectPath: tmp });

    const usage = sm.getTokenUsage();
    assert.deepEqual(usage, {});

    sm.destroy();
  });

  it('token usage survives save/load cycle', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmp = mkdtempSync(join(tmpdir(), 'shift-test-'));
    const sm1 = new StateManager(tmp);
    sm1.init({ fromVersion: '10', toVersion: '11', projectPath: tmp });
    sm1.setTokenUsage('transformer', { input: 5000, output: 2000, calls: 10 });
    sm1.destroy();

    // Load in a new instance
    const sm2 = new StateManager(tmp);
    await sm2.load();
    const usage = sm2.getTokenUsage();
    assert.deepEqual(usage.transformer, { input: 5000, output: 2000, calls: 10 });

    sm2.destroy();
  });
});

// ── Reporter token table rendering ──

describe('ReporterAgent token usage in report', () => {
  it('renders token usage table when data present', async () => {
    const { ReporterAgent } = await import('../src/agents/reporter-agent.js');

    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {}, error: async () => {}, phase: async () => {}, tool: async () => {} };
    const mockFileTools = {
      backup: () => {},
      writeFile: () => {},
      getAgentTools: () => ({ definitions: [], handlers: {} }),
    };
    const mockGit = { getLog: async () => 'abc123 commit msg' };

    const agent = new ReporterAgent({
      logger: mockLogger,
      projectPath: '/tmp/test',
      fileTools: mockFileTools,
      git: mockGit,
      config: {},
    });

    // Call _renderReport directly with token data
    const report = agent._renderReport(
      {
        executiveSummary: 'Test summary',
        automaticChanges: [],
        manualReviewItems: [],
        testSummary: 'No tests',
        warnings: [],
        nextSteps: ['Step 1'],
      },
      {
        fromVersion: '10',
        toVersion: '11',
        branchName: 'test-branch',
        transformations: { total: 5, completed: 5, failed: 0, skipped: 0, files: {} },
        validation: { passed: true },
        gitLog: 'abc123 test',
        phaseTimings: {},
        tokenUsage: {
          analyzer: { input: 1000, output: 500, calls: 3 },
          planner: { input: 2000, output: 800, calls: 5 },
        },
      }
    );

    assert.ok(report.includes('## Token Usage'), 'Report should include Token Usage section');
    assert.ok(report.includes('analyzer'), 'Report should list analyzer agent');
    assert.ok(report.includes('planner'), 'Report should list planner agent');
    assert.ok(report.includes('**Total**'), 'Report should include total row');
    assert.ok(report.includes('1,000') || report.includes('1000'), 'Report should show token counts');
  });

  it('omits token table when no data present', async () => {
    const { ReporterAgent } = await import('../src/agents/reporter-agent.js');

    const mockLogger = { info: async () => {}, debug: async () => {}, warn: async () => {}, success: async () => {}, error: async () => {}, phase: async () => {}, tool: async () => {} };
    const agent = new ReporterAgent({
      logger: mockLogger,
      projectPath: '/tmp/test',
      fileTools: { backup: () => {}, writeFile: () => {} },
      git: { getLog: async () => '' },
      config: {},
    });

    const report = agent._renderReport(
      { executiveSummary: 'Test', automaticChanges: [], manualReviewItems: [], testSummary: '', warnings: [], nextSteps: [] },
      {
        fromVersion: '10', toVersion: '11', branchName: 'test',
        transformations: { total: 0, completed: 0, failed: 0, skipped: 0, files: {} },
        validation: {}, gitLog: '', phaseTimings: {}, tokenUsage: {},
      }
    );

    assert.ok(!report.includes('## Token Usage'), 'Report should NOT include Token Usage when empty');
  });
});
