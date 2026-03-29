/**
 * Tests for src/style-formatter.js — Code style post-processing
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runStyleFormatting, generateStyleReport } from '../src/style-formatter.js';

describe('StyleFormatter', () => {
  const tmpDir = join(import.meta.dirname, '.tmp-style-test');

  before(() => {
    mkdirSync(join(tmpDir, 'vendor', 'bin'), { recursive: true });
    mkdirSync(join(tmpDir, 'app'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', 'Test.php'), '<?php\nclass Test {}\n');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('runStyleFormatting', () => {
    it('returns disabled when enabled=false', async () => {
      const result = await runStyleFormatting(tmpDir, {}, { enabled: false });
      assert.equal(result.formatted, false);
      assert.equal(result.formatter, 'none');
    });

    it('returns disabled when formatter=none', async () => {
      const result = await runStyleFormatting(tmpDir, {}, { formatter: 'none' });
      assert.equal(result.formatted, false);
      assert.equal(result.formatter, 'none');
    });

    it('returns not-found when no formatter is installed', async () => {
      const result = await runStyleFormatting(tmpDir, {}, { enabled: true });
      assert.equal(result.formatted, false);
      assert.equal(result.formatter, 'not-found');
    });

    it('detects pint when pint.json exists and binary is present', async () => {
      writeFileSync(join(tmpDir, 'pint.json'), '{}');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true });
      assert.equal(result.formatter, 'pint');
      // Cleanup
      rmSync(join(tmpDir, 'pint.json'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'pint'));
    });

    it('detects php-cs-fixer when config exists and binary is present', async () => {
      writeFileSync(join(tmpDir, '.php-cs-fixer.php'), '<?php return [];');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'), '#!/usr/bin/env php\n');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true });
      assert.equal(result.formatter, 'php-cs-fixer');
      assert.equal(result.fallbackUsed, false); // Has config, not fallback
      // Cleanup
      rmSync(join(tmpDir, '.php-cs-fixer.php'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'));
    });

    it('uses fallback when php-cs-fixer has no config', async () => {
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'), '#!/usr/bin/env php\n');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true });
      assert.equal(result.formatter, 'php-cs-fixer');
      assert.equal(result.fallbackUsed, true); // No config = fallback
      // Cleanup
      rmSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'));
    });

    it('dry run does not execute formatter', async () => {
      writeFileSync(join(tmpDir, 'pint.json'), '{}');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true });
      assert.equal(result.formatted, false);
      assert.equal(result.filesChanged, 0);
      // Cleanup
      rmSync(join(tmpDir, 'pint.json'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'pint'));
    });

    it('prefers pint over php-cs-fixer when both present', async () => {
      writeFileSync(join(tmpDir, 'pint.json'), '{}');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'), '#!/usr/bin/env php\n');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true });
      assert.equal(result.formatter, 'pint');
      // Cleanup
      rmSync(join(tmpDir, 'pint.json'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'pint'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'));
    });

    it('respects preferred formatter override', async () => {
      writeFileSync(join(tmpDir, 'pint.json'), '{}');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n');
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'), '#!/usr/bin/env php\n');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true, formatter: 'php-cs-fixer' });
      assert.equal(result.formatter, 'php-cs-fixer');
      // Cleanup
      rmSync(join(tmpDir, 'pint.json'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'pint'));
      rmSync(join(tmpDir, 'vendor', 'bin', 'php-cs-fixer'));
    });

    it('cleans up fallback config after formatting', async () => {
      // Verify that .php-cs-fixer.dist.php is NOT left in the project
      const configPath = join(tmpDir, '.php-cs-fixer.dist.php');
      assert.ok(!existsSync(configPath), 'Fallback config should not exist in project root');
    });
  });

  describe('generateStyleReport', () => {
    it('generates report for formatted result', () => {
      const report = generateStyleReport({
        formatted: true,
        filesChanged: 8,
        formatter: 'pint',
        fallbackUsed: false,
      });
      assert.ok(report.includes('pint'));
      assert.ok(report.includes('8'));
    });

    it('reports fallback usage', () => {
      const report = generateStyleReport({
        formatted: true,
        filesChanged: 5,
        formatter: 'php-cs-fixer',
        fallbackUsed: true,
      });
      assert.ok(report.includes('fallback'));
    });

    it('reports disabled state', () => {
      const report = generateStyleReport({ formatted: false, formatter: 'none' });
      assert.ok(report.includes('disabled'));
    });

    it('reports not-found state', () => {
      const report = generateStyleReport({ formatted: false, formatter: 'not-found' });
      assert.ok(report.includes('No code formatter'));
    });

    it('handles null result', () => {
      const report = generateStyleReport(null);
      assert.ok(report.includes('No files'));
    });
  });

  describe('E2E-7: Path handling', () => {
    it('formatter binary uses relative path, not absolute', async () => {
      writeFileSync(join(tmpDir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n');
      writeFileSync(join(tmpDir, 'pint.json'), '{}');
      const result = await runStyleFormatting(tmpDir, { dryRun: true }, { enabled: true });
      assert.equal(result.formatter, 'pint');
      // Cleanup
      rmSync(join(tmpDir, 'vendor', 'bin', 'pint'));
      rmSync(join(tmpDir, 'pint.json'));
    });

    it('source code uses relative vendorPath', () => {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', 'style-formatter.js'), 'utf8');
      assert.ok(source.includes("join('vendor', 'bin', name)"), 'Should use relative path join');
    });

    it('sandbox block produces clear warning message', () => {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', 'style-formatter.js'), 'utf8');
      assert.ok(source.includes('blocked by the execution sandbox'), 'Should have clear sandbox warning');
      assert.ok(source.includes('Run `vendor/bin/pint` manually'), 'Should suggest manual workaround');
    });

    it('cwd set to project root for execution', () => {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', 'style-formatter.js'), 'utf8');
      assert.ok(source.includes('cwd: projectRoot'), 'Should set cwd to projectRoot');
    });
  });
});
