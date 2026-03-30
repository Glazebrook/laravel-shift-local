/**
 * Tests for src/api-provider.js — API provider factory, model mapping, and cost calculation.
 * Run with: node --test test/api-provider.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProvider,
  createModelMapper,
  getModelPricing,
  calculateCost,
  createApiClient,
} from '../src/api-provider.js';

// ─── detectProvider ──────────────────────────────────────────────

describe('detectProvider', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.SHIFT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('returns anthropic when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    assert.equal(detectProvider(), 'anthropic');
  });

  it('returns bedrock when AWS_ACCESS_KEY_ID is set', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA..';
    assert.equal(detectProvider(), 'bedrock');
  });

  it('returns bedrock when AWS_PROFILE is set', () => {
    process.env.AWS_PROFILE = 'my-profile';
    assert.equal(detectProvider(), 'bedrock');
  });

  it('prefers ANTHROPIC_API_KEY over AWS creds', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA..';
    assert.equal(detectProvider(), 'anthropic');
  });

  it('defaults to anthropic when nothing is set', () => {
    assert.equal(detectProvider(), 'anthropic');
  });

  it('respects SHIFT_PROVIDER=bedrock override', () => {
    process.env.SHIFT_PROVIDER = 'bedrock';
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'; // would normally pick anthropic
    assert.equal(detectProvider(), 'bedrock');
  });

  it('respects SHIFT_PROVIDER=anthropic override', () => {
    process.env.SHIFT_PROVIDER = 'anthropic';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA..'; // would normally pick bedrock
    assert.equal(detectProvider(), 'anthropic');
  });

  it('ignores invalid SHIFT_PROVIDER value', () => {
    process.env.SHIFT_PROVIDER = 'gcp';
    assert.equal(detectProvider(), 'anthropic'); // default fallback
  });
});

// ─── createModelMapper ───────────────────────────────────────────

describe('createModelMapper', () => {
  describe('anthropic provider', () => {
    const mapModel = createModelMapper('anthropic');

    it('returns model string unchanged for anthropic', () => {
      assert.equal(mapModel('claude-opus-4-6'), 'claude-opus-4-6');
    });

    it('returns sonnet string unchanged for anthropic', () => {
      assert.equal(mapModel('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    });
  });

  describe('bedrock provider', () => {
    const mapModel = createModelMapper('bedrock');

    it('maps claude-opus-4-6 to Bedrock ID (no :0 suffix)', () => {
      assert.equal(mapModel('claude-opus-4-6'), 'anthropic.claude-opus-4-6-v1');
    });

    it('maps claude-sonnet-4-6 to Bedrock ID', () => {
      assert.equal(mapModel('claude-sonnet-4-6'), 'anthropic.claude-sonnet-4-6');
    });

    it('maps claude-sonnet-4-5-20250929 to Bedrock ID with :0', () => {
      assert.equal(mapModel('claude-sonnet-4-5-20250929'), 'anthropic.claude-sonnet-4-5-20250929-v1:0');
    });

    it('passes through already-Bedrock IDs unchanged', () => {
      assert.equal(mapModel('anthropic.claude-opus-4-6-v1'), 'anthropic.claude-opus-4-6-v1');
    });

    it('passes through global-prefixed IDs unchanged', () => {
      assert.equal(mapModel('global.anthropic.claude-opus-4-6-v1'), 'global.anthropic.claude-opus-4-6-v1');
    });

    it('passes through unknown model strings as-is', () => {
      assert.equal(mapModel('claude-unknown-99'), 'claude-unknown-99');
    });
  });

  describe('bedrock with global inference', () => {
    const mapModel = createModelMapper('bedrock', true);

    it('prefixes with global. for Opus', () => {
      assert.equal(mapModel('claude-opus-4-6'), 'global.anthropic.claude-opus-4-6-v1');
    });

    it('prefixes with global. for Sonnet', () => {
      assert.equal(mapModel('claude-sonnet-4-6'), 'global.anthropic.claude-sonnet-4-6');
    });

    it('does not double-prefix global IDs', () => {
      assert.equal(mapModel('global.anthropic.claude-opus-4-6-v1'), 'global.anthropic.claude-opus-4-6-v1');
    });
  });
});

// ─── getModelPricing ─────────────────────────────────────────────

describe('getModelPricing', () => {
  it('returns anthropic Opus pricing', () => {
    const p = getModelPricing('anthropic', 'claude-opus-4-6');
    assert.deepEqual(p, { input: 15, output: 75 });
  });

  it('returns bedrock Opus pricing (cheaper)', () => {
    const p = getModelPricing('bedrock', 'claude-opus-4-6');
    assert.deepEqual(p, { input: 5, output: 25 });
  });

  it('returns same Sonnet pricing on both providers', () => {
    const a = getModelPricing('anthropic', 'claude-sonnet-4-6');
    const b = getModelPricing('bedrock', 'claude-sonnet-4-6');
    assert.deepEqual(a, { input: 3, output: 15 });
    assert.deepEqual(b, { input: 3, output: 15 });
  });

  it('returns null for unknown model', () => {
    assert.equal(getModelPricing('anthropic', 'claude-unknown'), null);
  });

  it('resolves Bedrock model ID to pricing via reverse mapping', () => {
    const p = getModelPricing('bedrock', 'anthropic.claude-opus-4-6-v1');
    assert.deepEqual(p, { input: 5, output: 25 });
  });
});

// ─── calculateCost ───────────────────────────────────────────────

describe('calculateCost', () => {
  it('calculates Anthropic Opus cost correctly', () => {
    // 1M input + 1M output = $15 + $75 = $90
    const cost = calculateCost('anthropic', 'claude-opus-4-6', 1_000_000, 1_000_000);
    assert.equal(cost, 90);
  });

  it('calculates Bedrock Opus cost correctly', () => {
    // 1M input + 1M output = $5 + $25 = $30
    const cost = calculateCost('bedrock', 'claude-opus-4-6', 1_000_000, 1_000_000);
    assert.equal(cost, 30);
  });

  it('calculates fractional token costs', () => {
    // 10k input + 5k output on bedrock opus = $0.05 + $0.125 = $0.175
    const cost = calculateCost('bedrock', 'claude-opus-4-6', 10_000, 5_000);
    assert.ok(Math.abs(cost - 0.175) < 0.001);
  });

  it('returns null for unknown model', () => {
    assert.equal(calculateCost('anthropic', 'unknown-model', 1000, 1000), null);
  });
});

// ─── createApiClient ─────────────────────────────────────────────

describe('createApiClient', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('creates anthropic client with explicit provider config', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const api = createApiClient({ provider: 'anthropic' });
    assert.equal(api.provider, 'anthropic');
    assert.equal(api.mapModel('claude-opus-4-6'), 'claude-opus-4-6');
    assert.ok(api.client);
  });

  it('creates bedrock client with explicit provider config', () => {
    const api = createApiClient({ provider: 'bedrock', bedrock: { region: 'eu-west-2' } });
    assert.equal(api.provider, 'bedrock');
    assert.equal(api.mapModel('claude-opus-4-6'), 'anthropic.claude-opus-4-6-v1');
    assert.ok(api.client);
  });

  it('auto-detects anthropic when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;
    const api = createApiClient({});
    assert.equal(api.provider, 'anthropic');
  });

  it('auto-detects bedrock when AWS_ACCESS_KEY_ID is set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AWS_ACCESS_KEY_ID = 'AKIA..';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    const api = createApiClient({});
    assert.equal(api.provider, 'bedrock');
  });

  it('defaults to anthropic when no credentials are set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;
    delete process.env.SHIFT_PROVIDER;
    const api = createApiClient({});
    assert.equal(api.provider, 'anthropic');
  });

  it('provides a getPricing function', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const api = createApiClient({ provider: 'anthropic' });
    const cost = api.getPricing('claude-opus-4-6', 1_000_000, 1_000_000);
    assert.equal(cost, 90);
  });

  it('bedrock getPricing uses bedrock pricing', () => {
    const api = createApiClient({ provider: 'bedrock', bedrock: { region: 'us-east-1' } });
    const cost = api.getPricing('claude-opus-4-6', 1_000_000, 1_000_000);
    assert.equal(cost, 30);
  });

  it('supports global inference model mapping', () => {
    const api = createApiClient({ provider: 'bedrock', bedrock: { region: 'us-east-1', globalInference: true } });
    assert.equal(api.mapModel('claude-opus-4-6'), 'global.anthropic.claude-opus-4-6-v1');
  });

  it('sets AWS_PROFILE from bedrock.profile config', () => {
    delete process.env.AWS_PROFILE;
    createApiClient({ provider: 'bedrock', bedrock: { region: 'eu-west-2', profile: 'datalake' } });
    assert.equal(process.env.AWS_PROFILE, 'datalake');
  });
});
