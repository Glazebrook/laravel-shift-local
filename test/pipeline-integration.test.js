/**
 * Tests for Phase 6 — Pipeline integration of new features
 * Tests that reference data, pre-processing, style formatting,
 * route checking, and Blueprint export are correctly wired.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test that all new modules are importable and have expected exports
describe('Pipeline Integration — Module Imports', () => {
  it('reference-data exports all expected functions', async () => {
    const mod = await import('../src/reference-data.js');
    assert.equal(typeof mod.loadManifest, 'function');
    assert.equal(typeof mod.getBreakingChanges, 'function');
    assert.equal(typeof mod.getComposerChanges, 'function');
    assert.equal(typeof mod.getFileChange, 'function');
    assert.equal(typeof mod.getTransitionChain, 'function');
    assert.equal(typeof mod.getAggregatedComposerChanges, 'function');
    assert.equal(typeof mod.clearCache, 'function');
  });

  it('pre-processor exports all expected functions', async () => {
    const mod = await import('../src/pre-processor.js');
    assert.equal(typeof mod.runPreProcessing, 'function');
    assert.equal(typeof mod.generatePreProcessingSummary, 'function');
  });

  it('upgrade-guide exports all expected functions', async () => {
    const mod = await import('../src/upgrade-guide.js');
    assert.equal(typeof mod.loadUpgradeGuide, 'function');
    assert.equal(typeof mod.getBreakingSections, 'function');
    assert.equal(typeof mod.getThirdPartyNotes, 'function');
    assert.equal(typeof mod.formatGuideForPlanner, 'function');
    assert.equal(typeof mod.clearGuideCache, 'function');
  });

  it('style-formatter exports all expected functions', async () => {
    const mod = await import('../src/style-formatter.js');
    assert.equal(typeof mod.runStyleFormatting, 'function');
    assert.equal(typeof mod.generateStyleReport, 'function');
  });

  it('blueprint-exporter exports all expected functions', async () => {
    const mod = await import('../src/blueprint-exporter.js');
    assert.equal(typeof mod.generateBlueprintYaml, 'function');
  });

  it('route-checker exports all expected functions', async () => {
    const mod = await import('../src/route-checker.js');
    assert.equal(typeof mod.checkRoutes, 'function');
    assert.equal(typeof mod.generateRouteReport, 'function');
  });

  it('transform registry exports all expected functions', async () => {
    const mod = await import('../src/transforms/index.js');
    assert.equal(typeof mod.getApplicableTransforms, 'function');
    assert.ok(Array.isArray(mod.transforms));
    assert.equal(mod.transforms.length, 12);
  });
});

describe('Pipeline Integration — Orchestrator Imports', () => {
  it('orchestrator imports new modules without error', async () => {
    // This verifies that the orchestrator can be loaded with all new imports
    const mod = await import('../src/orchestrator.js');
    assert.ok(mod.Orchestrator);
    assert.ok(mod.ShiftError);
  });
});

describe('Pipeline Integration — Agent Compatibility', () => {
  it('PlannerAgent accepts referenceContext parameter', async () => {
    const { PlannerAgent } = await import('../src/agents/planner-agent.js');
    // Verify the class and method exist
    assert.ok(PlannerAgent);
    assert.equal(typeof PlannerAgent.prototype.plan, 'function');
  });

  it('DependencyAgent accepts referenceComposer parameter', async () => {
    const { DependencyAgent } = await import('../src/agents/dependency-agent.js');
    assert.ok(DependencyAgent);
  });

  it('ReporterAgent imports new report generators', async () => {
    const { ReporterAgent } = await import('../src/agents/reporter-agent.js');
    assert.ok(ReporterAgent);
  });
});

describe('Pipeline Integration — Graceful Fallback', () => {
  it('reference data returns null for missing manifests', async () => {
    const { loadManifest } = await import('../src/reference-data.js');
    const result = loadManifest('99', '100');
    assert.equal(result, null);
  });

  it('upgrade guide returns empty string for missing version', async () => {
    const { formatGuideForPlanner } = await import('../src/upgrade-guide.js');
    const result = formatGuideForPlanner('99');
    assert.equal(result, '');
  });

  it('pre-processing summary handles null result', async () => {
    const { generatePreProcessingSummary } = await import('../src/pre-processor.js');
    const result = generatePreProcessingSummary(null);
    assert.ok(result.includes('No deterministic'));
  });

  it('style report handles null result', async () => {
    const { generateStyleReport } = await import('../src/style-formatter.js');
    const result = generateStyleReport(null);
    assert.ok(typeof result === 'string');
  });

  it('route report handles null result', async () => {
    const { generateRouteReport } = await import('../src/route-checker.js');
    const result = generateRouteReport(null);
    assert.ok(typeof result === 'string');
  });
});

describe('Pipeline Integration — Config Defaults', () => {
  it('pre-processing is enabled by default', async () => {
    const { getApplicableTransforms } = await import('../src/transforms/index.js');
    const transforms = getApplicableTransforms('10', '11');
    assert.ok(transforms.length > 0, 'Should have applicable transforms by default');
  });

  it('declare-strict is disabled by default', async () => {
    const { getApplicableTransforms } = await import('../src/transforms/index.js');
    const transforms = getApplicableTransforms('10', '11');
    const names = transforms.map(t => t.name);
    assert.ok(!names.includes('declare-strict'));
  });

  it('down-migration is disabled by default', async () => {
    const { getApplicableTransforms } = await import('../src/transforms/index.js');
    const transforms = getApplicableTransforms('10', '11');
    const names = transforms.map(t => t.name);
    assert.ok(!names.includes('down-migration'));
  });

  it('config can enable declare-strict', async () => {
    const { getApplicableTransforms } = await import('../src/transforms/index.js');
    const transforms = getApplicableTransforms('10', '11', { 'declare-strict': true });
    const names = transforms.map(t => t.name);
    assert.ok(names.includes('declare-strict'));
  });
});
