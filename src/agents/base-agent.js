/**
 * BaseAgent - Foundation for all shift agents
 * Implements the full Anthropic agentic loop with:
 *  - Tool use processing
 *  - Automatic retry with exponential backoff
 *  - Token-efficient context management
 *  - Structured JSON output
 *  - Request timeout enforcement
 *  - Context window overflow protection (C2 FIX)
 *  - Shared API client (M13 FIX)
 *  - Rate limiting awareness (M9 FIX)
 */

import { createRequire } from 'node:module';
import { ShiftBaseError } from '../errors.js';
// L1 FIX: Use shared sleep utility instead of duplicating
import { sleep } from '../utils.js';

const MAX_TOOL_ROUNDS = 25;  // Safety limit for agentic loops

// FINDING-15 FIX: Named constants for magic numbers
const MAX_CONTEXT_TOKENS = 190_000;     // Token limit for context window
const CONTEXT_WARNING_THRESHOLD = 180_000; // Warn when approaching limit

/**
 * MAINT-5 FIX: Structured error class for agent failures.
 * FINDING-14 FIX: Extends ShiftBaseError for unified error hierarchy.
 */
export class AgentError extends ShiftBaseError {
  constructor(code, message, agentName) {
    super(code, message);
    this.name = 'AgentError';
    this.agent = agentName;
  }
}

/**
 * M13 FIX: Shared Anthropic client instance across all agents.
 * FIX #19: _resetSharedClient() allows tests to inject a mock client.
 */
let _sharedClient = null;
// R11-004 FIX: Lazy-import Anthropic SDK only when actually creating a client,
// so there is no module-level dependency on @anthropic-ai/sdk.
const require = createRequire(import.meta.url);
function getSharedClient() {
  if (!_sharedClient) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    _sharedClient = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _sharedClient;
}

/**
 * FIX #19: Reset the shared client singleton for testing.
 * Pass a mock client to inject it, or call with no args to clear.
 */
export function _resetSharedClient(mockClient = null) {
  _sharedClient = mockClient;
}

/**
 * M9 FIX: Simple token bucket rate limiter shared across all agents.
 * Prevents retry storms when one agent hits rate limits.
 */
const _rateLimiter = {
  tokens: 10,
  maxTokens: 10,
  refillRate: 2,       // tokens per second
  lastRefill: Date.now(),

  async acquire() {
    // Refill based on elapsed time
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
      await sleep(waitMs);
      this.tokens = 1;
      this.lastRefill = Date.now();
    }
    this.tokens -= 1;
  },
};

/**
 * C2 FIX: Approximate token count from text content.
 * FIX #17: Exported for direct unit testing.
 */
export function estimateTokens(messages) {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') chars += (block.text || '').length;
        else if (block.type === 'tool_result') chars += (typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length);
        else chars += JSON.stringify(block).length;
      }
    }
  }
  // M3 FIX: Use chars/3 instead of chars/4. For PHP/JSON code with many short
  // tokens ({, $, ->, ::), chars/4 significantly underestimates and risks
  // context window overflow 400 errors. chars/3 is more conservative.
  return Math.ceil(chars / 3);
}

/**
 * C2 FIX: Summarise older tool results to reduce context size.
 * FIX #17: Exported for direct unit testing.
 */
export function compactMessages(messages, maxTokens = MAX_CONTEXT_TOKENS) {
  const estimated = estimateTokens(messages);
  if (estimated <= maxTokens) return messages;

  // Find tool_result blocks and truncate older ones
  const compacted = messages.map((msg, idx) => {
    // Only compact older messages (keep last 6 messages intact)
    if (idx >= messages.length - 6) return msg;

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(block => {
          if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 500) {
            return {
              ...block,
              content: block.content.substring(0, 400) + '\n...[truncated for context management]...\n' + block.content.substring(block.content.length - 100),
            };
          }
          return block;
        }),
      };
    }

    // Compact assistant messages with large text blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(block => {
          if (block.type === 'text' && block.text && block.text.length > 1000) {
            return { ...block, text: block.text.substring(0, 800) + '\n...[truncated]...' };
          }
          return block;
        }),
      };
    }

    return msg;
  });

  return compacted;
}

export class BaseAgent {
  /**
   * H12 FIX: maxTokens is now configurable per agent instance.
   */
  constructor(name, { model, logger, maxRetries = 5, timeoutMs = 300_000, maxTokens = 8192, tokenTracker = null, maxTotalTokens = null, client = null, mapModel = null }) {
    this.name = name;
    this.model = model;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    // C7 FIX: Shared token tracker (object reference) and cost cap
    this._tokenTracker = tokenTracker;
    this._maxTotalTokens = maxTotalTokens;
    // Per-agent token usage tracking
    this._tokenUsage = { input: 0, output: 0, calls: 0 };
    // M13 FIX: Use shared client instance (injected client takes priority)
    this.client = client || getSharedClient();
    // Bedrock model mapping (identity function if not provided)
    this._mapModel = mapModel || (m => m);
  }

  get tokenUsage() {
    return { ...this._tokenUsage };
  }

  /**
   * Run the agent with full agentic loop
   * @param {string} systemPrompt
   * @param {Array} initialMessages
   * @param {Object} tools - { definitions: [...], handlers: {...} }
   * @returns {string} Final text response from agent
   */
  async run(systemPrompt, initialMessages, tools = null) {
    const messages = [...initialMessages];
    let rounds = 0;

    await this.logger.info(this.name, `Starting agent run (model: ${this.model})`);

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      // C2 FIX: Compact messages if approaching context window limit
      // REL-2 FIX: Include system prompt in token estimation
      // AUDIT FIX: Use chars/3 (consistent with estimateTokens) instead of chars/4
      const systemTokens = Math.ceil(systemPrompt.length / 3);
      const compactedMessages = compactMessages(messages, MAX_CONTEXT_TOKENS - systemTokens);

      const params = {
        model: this._mapModel(this.model),
        max_tokens: this.maxTokens,  // H12 FIX: configurable per agent
        system: systemPrompt,
        messages: compactedMessages,
      };

      if (tools?.definitions?.length) {
        params.tools = tools.definitions;
      }

      let response;
      try {
        // M9 FIX: Acquire rate limit token before API call
        await _rateLimiter.acquire();
        response = await this._callWithRetry(params);
      } catch (err) {
        await this.logger.error(this.name, `API call failed after retries: ${err.message}`);
        throw err;
      }

      // AUDIT FIX: Validate response structure before processing
      if (!response.content || !Array.isArray(response.content)) {
        throw new AgentError('AGENT_ERR_MALFORMED_RESPONSE',
          `API returned malformed response: content is ${typeof response.content}, expected array`, this.name);
      }

      // AUDIT-2 FIX: Detect max_tokens truncation. When Claude hits the token limit,
      // stop_reason is 'max_tokens' and the content may be truncated JSON.
      // Log a clear warning so the user knows what happened.
      if (response.stop_reason === 'max_tokens') {
        await this.logger.warn(this.name,
          `Response truncated at max_tokens (${this.maxTokens}). ` +
          `The model ran out of output space. If this persists, increase maxTokens for this agent.`);
      }

      // Add assistant response to history
      messages.push({ role: 'assistant', content: response.content });

      // Track per-agent token usage
      if (response.usage) {
        this._tokenUsage.input += response.usage.input_tokens || 0;
        this._tokenUsage.output += response.usage.output_tokens || 0;
        this._tokenUsage.calls += 1;
      }

      // C7 FIX: Track cumulative token usage across all agents.
      // If maxTotalTokens is set and exceeded, throw to stop runaway costs.
      if (this._tokenTracker && response.usage) {
        this._tokenTracker.input += response.usage.input_tokens || 0;
        this._tokenTracker.output += response.usage.output_tokens || 0;
        if (this._maxTotalTokens) {
          const total = this._tokenTracker.input + this._tokenTracker.output;
          if (total > this._maxTotalTokens) {
            throw new AgentError('AGENT_ERR_TOKEN_LIMIT',
              `Cumulative token usage (${total.toLocaleString()}) exceeded maxTotalTokens ` +
              `(${this._maxTotalTokens.toLocaleString()}). Stopping to prevent runaway costs. ` +
              `Increase maxTotalTokens in .shiftrc or run 'shift resume' to continue.`,
              this.name);
          }
        }
      }

      // If no tool use, we're done
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        const textBlock = response.content.find(b => b.type === 'text');
        const result = textBlock?.text || '';
        await this.logger.success(this.name, `Agent complete (${rounds} rounds, ${response.usage?.output_tokens || 0} output tokens)`);
        return result;
      }

      // Process all tool calls
      await this.logger.debug(this.name, `Processing ${toolUseBlocks.length} tool call(s)`);
      const toolResults = await this._processToolCalls(toolUseBlocks, tools.handlers);

      messages.push({ role: 'user', content: toolResults });

      // C2 FIX: Check if accumulated context is dangerously large
      const tokenEstimate = estimateTokens(messages);
      if (tokenEstimate > CONTEXT_WARNING_THRESHOLD) {
        await this.logger.warn(this.name, `Context approaching limit (~${tokenEstimate} tokens). Compacting older messages.`);
      }
    }

    throw new AgentError('AGENT_ERR_MAX_ROUNDS', `Agent ${this.name} exceeded maximum tool rounds (${MAX_TOOL_ROUNDS})`, this.name);
  }

  /**
   * Run agent expecting JSON output
   * C5 FIX: Use proper brace-matching parser instead of indexOf/lastIndexOf
   * FIX #18: Optional schema parameter for runtime validation of agent responses.
   * Schema is a simple object mapping keys to expected types (e.g., { ok: 'boolean', changes: 'array' }).
   */
  async runForJson(systemPrompt, initialMessages, tools = null, schema = null) {
    const jsonSystemPrompt = systemPrompt + `\n\nCRITICAL: Your final response MUST be valid JSON only. No markdown fences, no explanation before or after. Start with { and end with }.`;

    const text = await this.run(jsonSystemPrompt, initialMessages, tools);
    try {
      // REL-8 FIX: Use global regex to strip ALL markdown fences, then fall back
      // to brace-matching if the result doesn't look like JSON
      let cleaned = text.replace(/```(?:json)?\n?/g, '').replace(/\n?```/g, '').trim();

      // REL-8 FIX: If cleaned text doesn't start with {, use brace-matching
      // parser on the original text (handles multi-block responses)
      if (!cleaned.startsWith('{')) {
        cleaned = extractJson(text);
      }

      const parsed = JSON.parse(cleaned);

      // FIX #18: Validate against schema if provided
      if (schema) {
        const errors = validateResponseSchema(parsed, schema);
        if (errors.length > 0) {
          await this.logger.warn(this.name, `Agent response schema violations: ${errors.join('; ')}`);
        }
      }

      return parsed;
    } catch (err) {
      await this.logger.error(this.name, `Failed to parse JSON response: ${err.message}`);
      await this.logger.debug(this.name, `Raw response: ${text.substring(0, 500)}`);
      throw new AgentError('AGENT_ERR_INVALID_JSON', `Agent ${this.name} returned invalid JSON: ${err.message}`, this.name);
    }
  }

  /**
   * Process tool_use blocks and return tool_result blocks
   */
  async _processToolCalls(toolUseBlocks, handlers) {
    const results = [];
    for (const block of toolUseBlocks) {
      await this.logger.tool(this.name, `→ ${block.name}(${JSON.stringify(block.input).substring(0, 100)})`);
      let result;
      try {
        const handler = handlers[block.name];
        if (!handler) throw new Error(`Unknown tool: ${block.name}`);
        result = await handler(block.input);
      } catch (err) {
        await this.logger.error(this.name, `Tool ${block.name} failed: ${err.message}`);
        result = { error: err.message, tool: block.name };
      }
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    return results;
  }

  /**
   * API call with exponential backoff retry.
   * FIX #11: Enforces this.timeoutMs using AbortSignal so a hung API call
   * doesn't block the pipeline indefinitely.
   * M9 FIX: Adds jitter to retry delays to prevent thundering herd.
   */
  async _callWithRetry(params) {
    if (this.maxRetries <= 0) {
      // No retries — single attempt with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      timeoutId.unref(); // A2-011 FIX: Allow process exit during graceful shutdown
      try {
        const response = await this.client.messages.create(params, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response;
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    }
    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        timeoutId.unref(); // A2-011 FIX: Allow process exit during graceful shutdown

        try {
          const response = await this.client.messages.create(params, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          return response;
        } catch (err) {
          clearTimeout(timeoutId);
          throw err;
        }
      } catch (err) {
        lastErr = err;
        // REL-9 FIX: Give a clear error for auth failures instead of cryptic deep error
        // Bedrock uses 403/AccessDeniedException for auth failures
        if (err.status === 401 || err.status === 403) {
          const hint = err.status === 403
            ? 'Check your AWS credentials and IAM permissions (bedrock:InvokeModel).'
            : 'Check your ANTHROPIC_API_KEY.';
          throw new AgentError('AGENT_ERR_AUTH', `API authentication failed (HTTP ${err.status}). ${hint}`, this.name);
        }
        const isTimeout = err.name === 'AbortError' || err.code === 'ABORT_ERR';
        // P1-001 FIX: Also retry on HTTP 408 (Request Timeout) from Anthropic API
        // AUDIT-2 FIX: Retry on network errors without HTTP status (ECONNREFUSED, ETIMEDOUT, etc.)
        const RETRYABLE_NETWORK_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN'];
        const isNetworkError = RETRYABLE_NETWORK_CODES.includes(err.code) || RETRYABLE_NETWORK_CODES.includes(err.cause?.code);
        // Bedrock ThrottlingException may come as 429 or with error.name
        const isThrottled = err.status === 429 || err.name === 'ThrottlingException';
        const isRetryable = isTimeout || isNetworkError || isThrottled || err.status === 408 || (err.status && err.status >= 500);
        if (!isRetryable || attempt === this.maxRetries) throw err;

        // M9 FIX: Add jitter (±25%) to prevent all agents retrying simultaneously
        const baseDelay = Math.min(2000 * Math.pow(2, attempt - 1), 60000);
        const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
        const delay = Math.round(baseDelay + jitter);
        const reason = isTimeout ? 'timeout' : (err.status || err.code || 'network');
        await this.logger.warn(this.name, `API error (${reason}), retrying in ${delay}ms... (attempt ${attempt}/${this.maxRetries})`);
        await sleep(delay);
      }
    }
    throw lastErr;
  }
}

/**
 * C5 FIX: Extract a JSON object from text using proper brace-matching.
 * FIX #17: Exported for direct unit testing.
 */
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return text.substring(start, i + 1);
  }
  throw new Error('Unbalanced braces in JSON response');
}

/**
 * FIX #18: Lightweight runtime schema validation for agent JSON responses.
 * Schema is an object mapping keys to expected types:
 *   { ok: 'boolean', changes: 'array', notes: 'array' }
 * Supported types: 'string', 'number', 'boolean', 'array', 'object', 'any'
 * Returns an array of error strings (empty = valid).
 */
export function validateResponseSchema(obj, schema) {
  const errors = [];
  if (typeof obj !== 'object' || obj === null) {
    errors.push('Response is not an object');
    return errors;
  }
  for (const [key, expectedType] of Object.entries(schema)) {
    if (!(key in obj)) {
      errors.push(`Missing required field: '${key}'`);
      continue;
    }
    if (expectedType === 'any') continue;
    const val = obj[key];
    if (expectedType === 'array') {
      if (!Array.isArray(val)) errors.push(`Field '${key}' should be array, got ${typeof val}`);
    } else if (typeof val !== expectedType) {
      errors.push(`Field '${key}' should be ${expectedType}, got ${typeof val}`);
    }
  }
  return errors;
}

// L1 FIX: sleep() moved to ../utils.js — shared across modules
