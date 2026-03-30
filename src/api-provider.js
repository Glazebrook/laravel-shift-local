/**
 * API Provider — Factory for Anthropic/Bedrock clients.
 *
 * Creates either a direct Anthropic client or an AnthropicBedrock client
 * based on configuration, with model ID mapping for Bedrock format.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

// ─── Bedrock model ID mapping ─────────────────────────────────────
// Direct API model string → Bedrock model ID
const BEDROCK_MODEL_MAP = {
  'claude-opus-4-6':            'anthropic.claude-opus-4-6-v1',
  'claude-sonnet-4-6':          'anthropic.claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-sonnet-4-20250514':   'anthropic.claude-sonnet-4-20250514-v1:0',
};

// ─── Pricing per 1M tokens ────────────────────────────────────────
const PRICING = {
  anthropic: {
    'claude-opus-4-6':   { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3,  output: 15 },
  },
  bedrock: {
    'claude-opus-4-6':   { input: 5,  output: 25 },
    'claude-sonnet-4-6': { input: 3,  output: 15 },
  },
};

/**
 * Detect the provider from environment when not explicitly configured.
 * Priority: SHIFT_PROVIDER env var > credential-based detection > 'anthropic' default.
 */
export function detectProvider() {
  const envProvider = process.env.SHIFT_PROVIDER;
  if (envProvider === 'bedrock' || envProvider === 'anthropic') return envProvider;

  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return 'bedrock';

  // Default to anthropic for backward compatibility
  return 'anthropic';
}

/**
 * Map a model string for the target provider.
 * - For 'anthropic' provider: returns the model string unchanged.
 * - For 'bedrock' provider: maps to Bedrock model ID format.
 *   If globalInference is true, prefixes with 'global.'.
 *   Already-Bedrock IDs (starting with 'anthropic.') pass through unchanged.
 */
export function createModelMapper(provider, globalInference = false) {
  return function mapModel(modelString) {
    if (provider !== 'bedrock') return modelString;

    // Already a Bedrock model ID — pass through
    if (modelString.startsWith('anthropic.') || modelString.startsWith('global.')) {
      return modelString;
    }

    const bedrockId = BEDROCK_MODEL_MAP[modelString];
    if (!bedrockId) {
      // Unknown model — return as-is and let Bedrock reject it with a clear error
      return modelString;
    }

    return globalInference ? `global.${bedrockId}` : bedrockId;
  };
}

/**
 * Get cost per 1M tokens for a model on a given provider.
 * Returns { input, output } in USD, or null if unknown.
 */
export function getModelPricing(provider, modelString) {
  // Normalise: strip Bedrock prefix to match pricing keys
  let key = modelString;
  if (key.startsWith('global.')) key = key.slice(7);
  if (key.startsWith('anthropic.')) {
    // Reverse-map to friendly name
    for (const [friendly, bedrockId] of Object.entries(BEDROCK_MODEL_MAP)) {
      if (bedrockId === key) { key = friendly; break; }
    }
  }

  const providerPricing = PRICING[provider] || PRICING.anthropic;
  return providerPricing[key] || null;
}

/**
 * Calculate estimated cost in USD from token counts.
 */
export function calculateCost(provider, modelString, inputTokens, outputTokens) {
  const pricing = getModelPricing(provider, modelString);
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/**
 * Create an API client based on configuration.
 *
 * @param {object} config - Provider configuration
 * @param {string} [config.provider] - 'anthropic' or 'bedrock' (auto-detected if omitted)
 * @param {object} [config.bedrock] - Bedrock-specific options
 * @param {string} [config.bedrock.region] - AWS region (default: 'us-east-1')
 * @param {string} [config.bedrock.profile] - AWS profile name from ~/.aws/credentials (sets AWS_PROFILE)
 * @param {boolean} [config.bedrock.globalInference] - Use cross-region inference (default: false)
 * @returns {{ client: object, mapModel: Function, provider: string, getPricing: Function }}
 */
export function createApiClient(config = {}) {
  const provider = config.provider || detectProvider();
  const bedrockOpts = config.bedrock || {};
  const globalInference = bedrockOpts.globalInference || false;

  const mapModel = createModelMapper(provider, globalInference);

  let client;
  if (provider === 'bedrock') {
    // Set AWS_PROFILE so the SDK credential chain picks up the right account
    if (bedrockOpts.profile) {
      process.env.AWS_PROFILE = bedrockOpts.profile;
    }
    const opts = {};
    if (bedrockOpts.region) opts.awsRegion = bedrockOpts.region;
    client = new AnthropicBedrock(opts);
  } else {
    client = new Anthropic();
  }

  return {
    client,
    mapModel,
    provider,
    getPricing: (modelString, inputTokens, outputTokens) =>
      calculateCost(provider, modelString, inputTokens, outputTokens),
  };
}
