/**
 * BaseAgent test coverage.
 * Tests agentic loop, tool processing, retries, token tracking,
 * context compaction, and JSON parsing.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BaseAgent, AgentError, estimateTokens, compactMessages,
  extractJson, validateResponseSchema, _resetSharedClient,
} from '../src/agents/base-agent.js';

function makeLogger() {
  return {
    info: async () => {}, warn: async () => {}, error: async () => {},
    debug: async () => {}, success: async () => {}, phase: async () => {},
    tool: async () => {},
  };
}

// ── Mock Anthropic client ───────────────────────────────────────

function makeMockClient(responses) {
  let callIdx = 0;
  return {
    messages: {
      create: async (_params) => {
        if (callIdx >= responses.length) throw new Error('No more mock responses');
        return responses[callIdx++];
      },
    },
    get callCount() { return callIdx; },
  };
}

// ── estimateTokens ──────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates string content at chars/3', () => {
    const msgs = [{ role: 'user', content: 'a'.repeat(300) }];
    assert.equal(estimateTokens(msgs), 100);
  });

  it('estimates array content blocks', () => {
    const msgs = [{
      role: 'user',
      content: [
        { type: 'text', text: 'a'.repeat(150) },
        { type: 'tool_result', content: 'b'.repeat(150) },
      ],
    }];
    assert.equal(estimateTokens(msgs), 100);
  });

  it('returns 0 for empty messages', () => {
    assert.equal(estimateTokens([]), 0);
  });
});

// ── compactMessages ─────────────────────────────────────────────

describe('compactMessages', () => {
  it('returns messages unchanged if under limit', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const result = compactMessages(msgs, 100000);
    assert.deepEqual(result, msgs);
  });

  it('truncates older tool_result blocks when over limit', () => {
    const bigContent = 'x'.repeat(3000);
    const msgs = [
      // Old message with large tool result
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: bigContent }] },
      // 6 recent messages to keep intact
      ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'recent' })),
    ];
    // Set limit low enough to trigger compaction
    const result = compactMessages(msgs, 100);
    const firstContent = result[0].content[0].content;
    assert.ok(firstContent.length < bigContent.length, 'Should truncate old tool result');
    assert.ok(firstContent.includes('[truncated'), 'Should include truncation marker');
  });
});

// ── extractJson ─────────────────────────────────────────────────

describe('extractJson', () => {
  it('extracts JSON from text with preamble', () => {
    const text = 'Here is the result:\n{"ok": true, "changes": ["updated imports"]}';
    const result = extractJson(text);
    assert.equal(JSON.parse(result).ok, true);
  });

  it('handles nested braces', () => {
    const text = '{"outer": {"inner": {"deep": 1}}, "arr": [1,2]}';
    const result = extractJson(text);
    const parsed = JSON.parse(result);
    assert.equal(parsed.outer.inner.deep, 1);
  });

  it('handles braces inside strings', () => {
    const text = '{"msg": "use { and } in code"}';
    const result = extractJson(text);
    assert.equal(JSON.parse(result).msg, 'use { and } in code');
  });

  it('throws on no JSON found', () => {
    assert.throws(() => extractJson('no json here'), /No JSON object found/);
  });

  it('throws on unbalanced braces', () => {
    assert.throws(() => extractJson('{"open": true'), /Unbalanced braces/);
  });
});

// ── validateResponseSchema ──────────────────────────────────────

describe('validateResponseSchema', () => {
  it('returns empty array for valid schema', () => {
    const errors = validateResponseSchema(
      { ok: true, changes: ['a'], notes: ['b'] },
      { ok: 'boolean', changes: 'array', notes: 'array' }
    );
    assert.equal(errors.length, 0);
  });

  it('reports missing fields', () => {
    const errors = validateResponseSchema({}, { ok: 'boolean' });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('Missing'));
  });

  it('reports type mismatches', () => {
    const errors = validateResponseSchema({ ok: 'yes' }, { ok: 'boolean' });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('should be boolean'));
  });

  it('accepts any type', () => {
    const errors = validateResponseSchema({ data: 42 }, { data: 'any' });
    assert.equal(errors.length, 0);
  });

  it('returns error for non-object', () => {
    const errors = validateResponseSchema(null, { ok: 'boolean' });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('not an object'));
  });
});

// ── BaseAgent.run() with mock API ───────────────────────────────

describe('BaseAgent.run()', () => {
  afterEach(() => _resetSharedClient());

  it('returns text when no tool use in response', async () => {
    const mockClient = makeMockClient([{
      content: [{ type: 'text', text: 'Done!' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    const result = await agent.run('System prompt', [{ role: 'user', content: 'Do something' }]);
    assert.equal(result, 'Done!');
    assert.equal(mockClient.callCount, 1);
  });

  it('processes tool calls and continues loop', async () => {
    const mockClient = makeMockClient([
      // First response: tool call
      {
        content: [
          { type: 'tool_use', id: 'tool1', name: 'read_file', input: { filepath: 'test.php' } },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      // Second response: final text
      {
        content: [{ type: 'text', text: '{"ok": true}' }],
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    ]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    const tools = {
      definitions: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }],
      handlers: {
        read_file: async () => ({ content: '<?php echo "hi";' }),
      },
    };

    const result = await agent.run('System prompt', [{ role: 'user', content: 'Read the file' }], tools);
    assert.equal(result, '{"ok": true}');
    assert.equal(mockClient.callCount, 2);
  });

  it('handles unknown tool gracefully', async () => {
    const mockClient = makeMockClient([
      {
        content: [
          { type: 'tool_use', id: 'tool1', name: 'unknown_tool', input: {} },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        content: [{ type: 'text', text: 'Recovered' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    const tools = {
      definitions: [],
      handlers: {},
    };

    const result = await agent.run('System prompt', [{ role: 'user', content: 'test' }], tools);
    assert.equal(result, 'Recovered');
  });

  it('throws AgentError on malformed response', async () => {
    const mockClient = makeMockClient([{
      content: null, // malformed
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    await assert.rejects(
      () => agent.run('System prompt', [{ role: 'user', content: 'test' }]),
      (err) => err instanceof AgentError && err.code === 'AGENT_ERR_MALFORMED_RESPONSE'
    );
  });

  it('enforces token limit when maxTotalTokens is set', async () => {
    const tracker = { input: 0, output: 0 };
    const mockClient = makeMockClient([{
      content: [{ type: 'text', text: 'Done' }],
      usage: { input_tokens: 5000, output_tokens: 6000 },
    }]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
      tokenTracker: tracker, maxTotalTokens: 10000,
    });

    await assert.rejects(
      () => agent.run('System prompt', [{ role: 'user', content: 'test' }]),
      (err) => err instanceof AgentError && err.code === 'AGENT_ERR_TOKEN_LIMIT'
    );
  });
});

// ── BaseAgent.runForJson() ──────────────────────────────────────

describe('BaseAgent.runForJson()', () => {
  afterEach(() => _resetSharedClient());

  it('parses JSON from agent response', async () => {
    const mockClient = makeMockClient([{
      content: [{ type: 'text', text: '{"ok": true, "changes": ["updated imports"]}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    const result = await agent.runForJson('System prompt', [{ role: 'user', content: 'test' }]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changes, ['updated imports']);
  });

  it('strips markdown fences from JSON response', async () => {
    const mockClient = makeMockClient([{
      content: [{ type: 'text', text: '```json\n{"ok": true}\n```' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    const result = await agent.runForJson('System prompt', [{ role: 'user', content: 'test' }]);
    assert.equal(result.ok, true);
  });

  it('throws AgentError on invalid JSON', async () => {
    const mockClient = makeMockClient([{
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);
    _resetSharedClient(mockClient);

    const agent = new BaseAgent('TestAgent', {
      model: 'test-model', logger: makeLogger(),
    });

    await assert.rejects(
      () => agent.runForJson('System prompt', [{ role: 'user', content: 'test' }]),
      (err) => err instanceof AgentError && err.code === 'AGENT_ERR_INVALID_JSON'
    );
  });
});

// ── _callWithRetry ──────────────────────────────────────────────

describe('BaseAgent._callWithRetry', () => {
  afterEach(() => _resetSharedClient());

  it('throws immediately on 401 auth error', async () => {
    const mockClient = {
      messages: {
        create: async () => {
          const err = new Error('Unauthorized');
          err.status = 401;
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
      (err) => err instanceof AgentError && err.code === 'AGENT_ERR_AUTH'
    );
  });

  it('retries on 500 server error', async () => {
    let attempts = 0;
    const mockClient = {
      messages: {
        create: async () => {
          attempts++;
          if (attempts < 3) {
            const err = new Error('Server Error');
            err.status = 500;
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
      model: 'test-model', logger: makeLogger(), maxRetries: 5,
    });

    const result = await agent._callWithRetry({ model: 'test', messages: [] });
    assert.equal(attempts, 3);
    assert.ok(result.content);
  });
});
