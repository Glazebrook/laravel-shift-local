/**
 * Tests for the Version Conformity Checker
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkConformity,
  calculateDebtScore,
  determineActualVersion,
  generateConformitySummary,
  generateConformityReportSection,
} from '../src/conformity-checker.js';

function makeTmpDir() {
  const dir = join(tmpdir(), `shift-conformity-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

describe('Conformity Checker — Structure', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clean L11 project reports 0 issues', async () => {
    // Create the expected L11 files
    writeFile(root, 'bootstrap/app.php', `<?php
return Application::configure()->withMiddleware()->withExceptions()->create();`);
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const structureIssues = report.issues.filter(i => i.category === 'structure');
    assert.equal(structureIssues.length, 0, 'No structure issues for a clean L11 project');
  });

  it('L11 project with Kernel.php flags structure issue', async () => {
    writeFile(root, 'app/Http/Kernel.php', '<?php class Kernel {}');
    writeFile(root, 'bootstrap/app.php', '<?php return app(); // old format');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const kernelIssue = report.issues.find(i => i.file === 'app/Http/Kernel.php');
    assert.ok(kernelIssue, 'Kernel.php flagged');
    assert.equal(kernelIssue.category, 'structure');
    assert.equal(kernelIssue.originVersion, '11');
    assert.equal(kernelIssue.autoFixable, true);
  });

  it('L11 project with multiple stale files flags all of them', async () => {
    writeFile(root, 'app/Http/Kernel.php', '<?php class Kernel {}');
    writeFile(root, 'app/Console/Kernel.php', '<?php class ConsoleKernel {}');
    writeFile(root, 'app/Exceptions/Handler.php', '<?php class Handler {}');
    writeFile(root, 'tests/CreatesApplication.php', '<?php trait CA {}');
    writeFile(root, 'config/cors.php', '<?php return [];');
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const structureIssues = report.issues.filter(i => i.category === 'structure');
    assert.ok(structureIssues.length >= 5, `Expected >=5 structure issues, got ${structureIssues.length}`);
  });

  it('L10 project is not checked for L11 structure', async () => {
    writeFile(root, 'app/Http/Kernel.php', '<?php class Kernel {}');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.1' } }));

    const report = await checkConformity(root, '10', { autoFix: false });
    const kernelIssue = report.issues.find(i => i.file === 'app/Http/Kernel.php');
    assert.equal(kernelIssue, undefined, 'Kernel.php is fine in L10');
  });

  it('missing bootstrap/providers.php flags high severity', async () => {
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const providersMissing = report.issues.find(
      i => i.file === 'bootstrap/providers.php' && i.category === 'structure'
    );
    assert.ok(providersMissing, 'Missing providers.php flagged');
    assert.equal(providersMissing.severity, 'high');
    assert.equal(providersMissing.autoFixable, false);
  });
});

describe('Conformity Checker — Composer', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('version mismatch in composer.lock is critical', async () => {
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }));
    writeFile(root, 'composer.lock', JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v10.48.0' }] }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const versionIssue = report.issues.find(i => i.severity === 'critical' && i.category === 'composer');
    assert.ok(versionIssue, 'Version mismatch flagged as critical');
  });

  it('stale fruitcake/laravel-cors in L10+ flagged', async () => {
    writeFile(root, 'composer.json', JSON.stringify({
      require: { php: '^8.2', 'fruitcake/laravel-cors': '^3.0' },
    }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const corsIssue = report.issues.find(i => i.issue.includes('fruitcake/laravel-cors'));
    assert.ok(corsIssue, 'fruitcake/cors flagged');
    assert.equal(corsIssue.originVersion, '10');
  });

  it('doctrine/dbal in L11+ flagged', async () => {
    writeFile(root, 'composer.json', JSON.stringify({
      require: { php: '^8.2', 'doctrine/dbal': '^3.0' },
    }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const dbalIssue = report.issues.find(i => i.issue.includes('doctrine/dbal'));
    assert.ok(dbalIssue, 'doctrine/dbal flagged');
    assert.equal(dbalIssue.originVersion, '11');
  });

  it('PHP constraint too low is flagged', async () => {
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.0' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const phpIssue = report.issues.find(i => i.issue.includes('PHP constraint'));
    assert.ok(phpIssue, 'PHP constraint flagged');
  });

  it('correct PHP constraint is not flagged', async () => {
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const phpIssue = report.issues.find(i => i.issue.includes('PHP constraint'));
    assert.equal(phpIssue, undefined, 'No PHP constraint issue');
  });
});

describe('Conformity Checker — Config', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('old providers array in config/app.php flagged for L11', async () => {
    writeFile(root, 'config/app.php', `<?php return ['providers' => [ App\\Providers\\AppServiceProvider::class ]];`);
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const configIssue = report.issues.find(i => i.category === 'config' && i.file === 'config/app.php');
    assert.ok(configIssue, 'Config issue flagged');
  });

  it('config issue not flagged for L10', async () => {
    writeFile(root, 'config/app.php', `<?php return ['providers' => []];`);
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.1' } }));

    const report = await checkConformity(root, '10', { autoFix: false });
    const configIssue = report.issues.find(i => i.category === 'config');
    assert.equal(configIssue, undefined);
  });
});

describe('Conformity Checker — Middleware', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('missing withMiddleware in bootstrap/app.php flagged for L11', async () => {
    writeFile(root, 'bootstrap/app.php', '<?php return app();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const mwIssue = report.issues.find(i => i.category === 'middleware' && i.issue.includes('withMiddleware'));
    assert.ok(mwIssue, 'withMiddleware missing flagged');
    assert.equal(mwIssue.severity, 'high');
  });

  it('present withMiddleware not flagged', async () => {
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const mwIssue = report.issues.find(i => i.category === 'middleware' && i.issue.includes('withMiddleware'));
    assert.equal(mwIssue, undefined);
  });
});

describe('Conformity Checker — Providers', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('missing bootstrap/providers.php flagged for L11', async () => {
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const provIssue = report.issues.find(i => i.category === 'providers');
    assert.ok(provIssue, 'Missing providers flagged');
    assert.equal(provIssue.severity, 'high');
  });

  it('stale providers array in config/app.php flagged when providers.php exists', async () => {
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'config/app.php', `<?php return ['providers' => []];`);
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const provIssue = report.issues.find(i => i.category === 'providers' && i.file === 'config/app.php');
    assert.ok(provIssue, 'Stale providers array flagged');
  });
});

describe('Conformity Checker — Routing', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('api.php without withRouting flagged for L11', async () => {
    writeFile(root, 'routes/api.php', '<?php // api routes');
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const routeIssue = report.issues.find(i => i.category === 'routing');
    assert.ok(routeIssue, 'API routing issue flagged');
  });

  it('api.php with withRouting not flagged', async () => {
    writeFile(root, 'routes/api.php', '<?php // api routes');
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withRouting(api: __DIR__."/../routes/api.php")->withMiddleware()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const routeIssue = report.issues.find(i => i.category === 'routing');
    assert.equal(routeIssue, undefined);
  });
});

describe('Conformity Checker — Tests', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('CreatesApplication in TestCase.php flagged for L11', async () => {
    writeFile(root, 'tests/TestCase.php', `<?php
use Tests\\CreatesApplication;
class TestCase extends BaseTestCase {
    use CreatesApplication;
}`);
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });
    const testIssue = report.issues.find(i => i.category === 'tests');
    assert.ok(testIssue, 'CreatesApplication flagged');
    assert.equal(testIssue.severity, 'low');
  });
});

describe('Conformity Checker — Auto-Fix', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('auto-fix deletes structural tombstones with backup', async () => {
    writeFile(root, 'app/Http/Kernel.php', '<?php class Kernel {}');
    writeFile(root, 'app/Console/Kernel.php', '<?php class ConsoleKernel {}');
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: true });

    // Files should be deleted
    assert.equal(existsSync(join(root, 'app/Http/Kernel.php')), false, 'Kernel.php deleted');
    assert.equal(existsSync(join(root, 'app/Console/Kernel.php')), false, 'ConsoleKernel.php deleted');

    // Backups should exist
    assert.ok(existsSync(join(root, '.shift/backups/app/Http/Kernel.php')), 'Backup exists');
    assert.ok(existsSync(join(root, '.shift/backups/app/Console/Kernel.php')), 'Backup exists');

    assert.ok(report.fixes.length >= 2, `Expected >=2 fixes, got ${report.fixes.length}`);
  });

  it('autoFix: false does not delete files', async () => {
    writeFile(root, 'app/Http/Kernel.php', '<?php class Kernel {}');
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false });

    assert.ok(existsSync(join(root, 'app/Http/Kernel.php')), 'File still exists');
    assert.equal(report.fixes.length, 0);
  });
});

describe('Conformity Checker — skipChecks', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('skipping structure check omits structure issues', async () => {
    writeFile(root, 'app/Http/Kernel.php', '<?php class Kernel {}');
    writeFile(root, 'bootstrap/app.php', '<?php return Application::configure()->withMiddleware()->withExceptions()->create();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false, skipChecks: ['structure'] });
    const structureIssues = report.issues.filter(i => i.category === 'structure');
    assert.equal(structureIssues.length, 0);
  });

  it('skipping middleware check omits middleware issues', async () => {
    writeFile(root, 'bootstrap/app.php', '<?php return app();');
    writeFile(root, 'bootstrap/providers.php', '<?php return [];');
    writeFile(root, 'composer.json', JSON.stringify({ require: { php: '^8.2' } }));

    const report = await checkConformity(root, '11', { autoFix: false, skipChecks: ['middleware'] });
    const mwIssues = report.issues.filter(i => i.category === 'middleware');
    assert.equal(mwIssues.length, 0);
  });
});

describe('Conformity Checker — Scoring', () => {
  it('empty issues give score 0', () => {
    assert.equal(calculateDebtScore([]), 0);
  });

  it('mixed severities score correctly', () => {
    const issues = [
      { severity: 'critical' },
      { severity: 'high' },
      { severity: 'medium' },
      { severity: 'low' },
    ];
    // 25 + 10 + 5 + 1 = 41
    assert.equal(calculateDebtScore(issues), 41);
  });

  it('score caps at 100', () => {
    const issues = Array.from({ length: 10 }, () => ({ severity: 'critical' }));
    assert.equal(calculateDebtScore(issues), 100);
  });

  it('determineActualVersion returns null when no high/critical issues', () => {
    const issues = [
      { severity: 'medium', originVersion: '11' },
      { severity: 'low', originVersion: '10' },
    ];
    assert.equal(determineActualVersion(issues), null);
  });

  it('determineActualVersion returns version - 1 of earliest high/critical', () => {
    const issues = [
      { severity: 'high', originVersion: '11' },
      { severity: 'critical', originVersion: '10' },
    ];
    // earliest is 10, so actual = 9
    assert.equal(determineActualVersion(issues), '9');
  });
});

describe('Conformity Checker — Summary & Report Generation', () => {
  it('generateConformitySummary for clean project', () => {
    const report = { declaredVersion: '11', issues: [], fixes: [], debtScore: 0, actualConformity: null };
    const summary = generateConformitySummary(report);
    assert.ok(summary.includes('passed'), 'Summary indicates pass');
  });

  it('generateConformitySummary for project with issues', () => {
    const report = {
      declaredVersion: '11',
      actualConformity: '10',
      debtScore: 35,
      issues: [
        { severity: 'high', originVersion: '11', file: 'app/Http/Kernel.php', issue: 'Should not exist', category: 'structure' },
      ],
      fixes: [],
    };
    const summary = generateConformitySummary(report);
    assert.ok(summary.includes('Debt score: 35/100'));
    assert.ok(summary.includes('resembles Laravel 10'));
    assert.ok(summary.includes('app/Http/Kernel.php'));
  });

  it('generateConformityReportSection returns markdown table', () => {
    const report = {
      declaredVersion: '11',
      actualConformity: '10',
      debtScore: 35,
      issues: [
        { severity: 'high', originVersion: '11', file: 'app/Http/Kernel.php', issue: 'Should not exist' },
      ],
      fixes: [{ file: 'app/Http/Kernel.php', action: 'deleted' }],
    };
    const md = generateConformityReportSection(report);
    assert.ok(md.includes('## Version Conformity Check'));
    assert.ok(md.includes('Laravel 10'));
    assert.ok(md.includes('Auto-fixed'));
  });

  it('generateConformityReportSection returns empty string for null', () => {
    assert.equal(generateConformityReportSection(null), '');
  });
});
