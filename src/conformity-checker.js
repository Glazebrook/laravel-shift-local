/**
 * Version Conformity Check
 *
 * Compares a Laravel project against the reference skeleton for its declared
 * version and identifies structural debt — changes that should have been
 * applied in prior upgrades but weren't.
 *
 * Runs BEFORE the upgrade begins, giving the pipeline an accurate
 * picture of the project's actual state rather than assuming it matches
 * the declared version.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { glob } from 'glob';

/**
 * @typedef {object} ConformityIssue
 * @property {string} category
 * @property {'critical'|'high'|'medium'|'low'} severity
 * @property {string} originVersion
 * @property {string} file
 * @property {string} issue
 * @property {string} [detail]
 * @property {boolean} autoFixable
 * @property {string} fix
 */

/**
 * @typedef {object} ConformityFix
 * @property {string} file
 * @property {string} action
 * @property {string} reason
 * @property {string} originVersion
 * @property {string} [backup]
 */

/**
 * @typedef {object} ConformityReport
 * @property {string} declaredVersion
 * @property {string|null} actualConformity - Which version the project actually resembles
 * @property {ConformityIssue[]} issues
 * @property {ConformityFix[]} fixes
 * @property {number} debtScore - 0-100
 */

/**
 * Run a full conformity check against the declared source version.
 *
 * @param {string} projectRoot
 * @param {string} declaredVersion
 * @param {object} [options]
 * @param {boolean} [options.autoFix=true]
 * @param {boolean} [options.verbose=false]
 * @param {string[]} [options.skipChecks=[]]
 * @returns {Promise<ConformityReport>}
 */
export async function checkConformity(projectRoot, declaredVersion, options = {}) {
  const { autoFix = true, skipChecks = [] } = options;

  const report = {
    declaredVersion,
    actualConformity: null,
    issues: [],
    fixes: [],
    debtScore: 0,
  };

  const version = String(declaredVersion).split('.')[0];
  const skip = new Set(skipChecks);

  if (!skip.has('structure'))          checkStructure(projectRoot, version, report);
  if (!skip.has('composer'))           checkComposerConformity(projectRoot, version, report);
  if (!skip.has('config'))             checkConfigConformity(projectRoot, version, report);
  if (!skip.has('middleware'))          checkMiddlewareConformity(projectRoot, version, report);
  if (!skip.has('providers'))          checkProviderConformity(projectRoot, version, report);
  if (!skip.has('routing'))            checkRoutingConformity(projectRoot, version, report);
  if (!skip.has('tests'))              checkTestConformity(projectRoot, version, report);
  if (!skip.has('deprecated-pattern')) await checkDeprecatedPatterns(projectRoot, version, report);

  report.actualConformity = determineActualVersion(report.issues);
  report.debtScore = calculateDebtScore(report.issues);

  if (autoFix) {
    applyAutoFixes(projectRoot, report);
  }

  return report;
}

// ─── Structure Check ──────────────────────────────────────────

/**
 * Files that should / shouldn't exist for the declared version.
 */
function checkStructure(projectRoot, version, report) {
  const checks = {
    11: {
      shouldNotExist: [
        'app/Http/Kernel.php',
        'app/Console/Kernel.php',
        'app/Exceptions/Handler.php',
        'app/Providers/RouteServiceProvider.php',
        'app/Providers/BroadcastServiceProvider.php',
        'app/Providers/EventServiceProvider.php',
        'app/Providers/AuthServiceProvider.php',
        'app/Http/Middleware/Authenticate.php',
        'app/Http/Middleware/EncryptCookies.php',
        'app/Http/Middleware/PreventRequestsDuringMaintenance.php',
        'app/Http/Middleware/RedirectIfAuthenticated.php',
        'app/Http/Middleware/TrimStrings.php',
        'app/Http/Middleware/TrustHosts.php',
        'app/Http/Middleware/TrustProxies.php',
        'app/Http/Middleware/ValidateSignature.php',
        'app/Http/Middleware/VerifyCsrfToken.php',
        'tests/CreatesApplication.php',
        'config/cors.php',
      ],
      shouldExist: [
        'bootstrap/app.php',
        'bootstrap/providers.php',
      ],
    },
  };

  for (let v = 9; v <= parseInt(version); v++) {
    const vChecks = checks[v];
    if (!vChecks) continue;

    if (vChecks.shouldNotExist) {
      for (const filePath of vChecks.shouldNotExist) {
        if (existsSync(join(projectRoot, filePath))) {
          report.issues.push({
            category: 'structure',
            severity: filePath.startsWith('config/') ? 'high' : 'medium',
            originVersion: String(v),
            file: filePath,
            issue: `File should have been removed in Laravel ${v} upgrade`,
            detail: `This file exists but should not in a Laravel ${version} project.`,
            autoFixable: true,
            fix: 'delete',
          });
        }
      }
    }

    if (vChecks.shouldExist) {
      for (const filePath of vChecks.shouldExist) {
        if (!existsSync(join(projectRoot, filePath))) {
          report.issues.push({
            category: 'structure',
            severity: 'high',
            originVersion: String(v),
            file: filePath,
            issue: `File should exist in a Laravel ${version} project`,
            detail: `This file was introduced in Laravel ${v} but is missing.`,
            autoFixable: false,
            fix: 'manual — this file needs project-specific content',
          });
        }
      }
    }
  }
}

// ─── Composer Conformity ──────────────────────────────────────

function checkComposerConformity(projectRoot, version, report) {
  const composerPath = join(projectRoot, 'composer.json');
  if (!existsSync(composerPath)) return;

  let composerJson;
  try {
    composerJson = JSON.parse(readFileSync(composerPath, 'utf-8'));
  } catch {
    return; // corrupt composer.json — other tools will catch this
  }

  // Check installed version matches declared version
  const lockPath = join(projectRoot, 'composer.lock');
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
      const frameworkPkg = (lock.packages || []).find(p => p.name === 'laravel/framework');
      if (frameworkPkg) {
        const installedMajor = frameworkPkg.version.replace(/^v/, '').split('.')[0];
        if (installedMajor !== version) {
          report.issues.push({
            category: 'composer',
            severity: 'critical',
            originVersion: version,
            file: 'composer.lock',
            issue: `Installed Laravel version (${frameworkPkg.version}) does not match declared version (${version})`,
            detail: `Run composer update first, or use --from=${installedMajor}.`,
            autoFixable: false,
            fix: 'Run composer update or correct the --from flag',
          });
        }
      }
    } catch {
      // corrupt lock file — non-fatal
    }
  }

  // Packages that should have been removed
  const removedPackages = {
    10: ['fruitcake/laravel-cors', 'fideloper/proxy'],
    11: ['doctrine/dbal'],
  };

  for (let v = 9; v <= parseInt(version); v++) {
    const removed = removedPackages[v];
    if (!removed) continue;
    for (const pkg of removed) {
      if (composerJson.require?.[pkg] || composerJson['require-dev']?.[pkg]) {
        report.issues.push({
          category: 'composer',
          severity: 'medium',
          originVersion: String(v),
          file: 'composer.json',
          issue: `Package ${pkg} should have been removed in Laravel ${v} upgrade`,
          detail: `This package is no longer needed in Laravel ${v}+.`,
          autoFixable: false,
          fix: `composer remove ${pkg}`,
        });
      }
    }
  }

  // PHP version constraint check
  const expectedPhp = { '9': '^8.0', '10': '^8.1', '11': '^8.2', '12': '^8.2', '13': '^8.2' };
  const declaredPhp = composerJson.require?.php;
  if (declaredPhp && expectedPhp[version]) {
    const declaredMin = parseFloat(declaredPhp.replace(/[^0-9.]/g, ''));
    const expectedMin = parseFloat(expectedPhp[version].replace(/[^0-9.]/g, ''));
    if (declaredMin < expectedMin) {
      report.issues.push({
        category: 'composer',
        severity: 'medium',
        originVersion: version,
        file: 'composer.json',
        issue: `PHP constraint ${declaredPhp} is lower than expected ${expectedPhp[version]} for Laravel ${version}`,
        autoFixable: false,
        fix: `Update php constraint to ${expectedPhp[version]}`,
      });
    }
  }
}

// ─── Config Conformity ────────────────────────────────────────

function checkConfigConformity(projectRoot, version, report) {
  const configChecks = {
    11: {
      'config/app.php': {
        shouldNotContain: [
          { pattern: /'providers'\s*=>\s*\[/, description: 'Explicit providers array (moved to bootstrap/providers.php in L11)' },
          { pattern: /'aliases'\s*=>\s*\[/, description: 'Explicit aliases array (auto-discovered in L11)' },
        ],
      },
    },
  };

  for (let v = 9; v <= parseInt(version); v++) {
    const vChecks = configChecks[v];
    if (!vChecks) continue;

    for (const [configFile, checks] of Object.entries(vChecks)) {
      const filePath = join(projectRoot, configFile);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf-8');

      if (checks.shouldNotContain) {
        for (const check of checks.shouldNotContain) {
          if (check.pattern.test(content)) {
            report.issues.push({
              category: 'config',
              severity: 'medium',
              originVersion: String(v),
              file: configFile,
              issue: check.description,
              detail: `This pattern should have been updated in the ${v - 1}→${v} upgrade.`,
              autoFixable: false,
              fix: `Update ${configFile} to match Laravel ${v} conventions`,
            });
          }
        }
      }
    }
  }
}

// ─── Middleware Conformity ─────────────────────────────────────

function checkMiddlewareConformity(projectRoot, version, report) {
  if (parseInt(version) < 11) return;

  const bootstrapApp = join(projectRoot, 'bootstrap', 'app.php');
  if (!existsSync(bootstrapApp)) return;

  const content = readFileSync(bootstrapApp, 'utf-8');

  if (!content.includes('withMiddleware')) {
    report.issues.push({
      category: 'middleware',
      severity: 'high',
      originVersion: '11',
      file: 'bootstrap/app.php',
      issue: 'Missing withMiddleware() call — middleware not configured in Laravel 11 style',
      autoFixable: false,
      fix: 'Rewrite bootstrap/app.php with withMiddleware()',
    });
  }

  if (!content.includes('withExceptions')) {
    report.issues.push({
      category: 'middleware',
      severity: 'medium',
      originVersion: '11',
      file: 'bootstrap/app.php',
      issue: 'Missing withExceptions() call — exception handling not configured in Laravel 11 style',
      autoFixable: false,
      fix: 'Add ->withExceptions() to bootstrap/app.php',
    });
  }
}

// ─── Provider Conformity ──────────────────────────────────────

function checkProviderConformity(projectRoot, version, report) {
  if (parseInt(version) < 11) return;

  const providersFile = join(projectRoot, 'bootstrap', 'providers.php');
  if (!existsSync(providersFile)) {
    report.issues.push({
      category: 'providers',
      severity: 'high',
      originVersion: '11',
      file: 'bootstrap/providers.php',
      issue: 'Missing bootstrap/providers.php — provider registration not in Laravel 11 format',
      autoFixable: false,
      fix: 'Create bootstrap/providers.php with the application service providers',
    });
    return;
  }

  const configApp = join(projectRoot, 'config', 'app.php');
  if (existsSync(configApp)) {
    const configContent = readFileSync(configApp, 'utf-8');
    if (/['"]providers['"]\s*=>\s*\[/.test(configContent)) {
      report.issues.push({
        category: 'providers',
        severity: 'medium',
        originVersion: '11',
        file: 'config/app.php',
        issue: 'config/app.php still has providers array — should use bootstrap/providers.php in Laravel 11+',
        autoFixable: false,
        fix: 'Migrate custom providers to bootstrap/providers.php and remove the array from config/app.php',
      });
    }
  }
}

// ─── Routing Conformity ───────────────────────────────────────

function checkRoutingConformity(projectRoot, version, report) {
  if (parseInt(version) < 11) return;

  const apiRoutes = join(projectRoot, 'routes', 'api.php');
  const bootstrapApp = join(projectRoot, 'bootstrap', 'app.php');

  if (existsSync(apiRoutes) && existsSync(bootstrapApp)) {
    const bootstrapContent = readFileSync(bootstrapApp, 'utf-8');
    if (!bootstrapContent.includes('api.php') && !bootstrapContent.includes('withRouting')) {
      report.issues.push({
        category: 'routing',
        severity: 'medium',
        originVersion: '11',
        file: 'routes/api.php',
        issue: 'routes/api.php exists but may not be loaded — Laravel 11 requires explicit registration in bootstrap/app.php',
        autoFixable: false,
        fix: 'Add api route loading to bootstrap/app.php withRouting() call',
      });
    }
  }
}

// ─── Test Conformity ──────────────────────────────────────────

function checkTestConformity(projectRoot, version, report) {
  if (parseInt(version) < 11) return;

  const testCase = join(projectRoot, 'tests', 'TestCase.php');
  if (existsSync(testCase)) {
    const content = readFileSync(testCase, 'utf-8');
    if (content.includes('CreatesApplication')) {
      report.issues.push({
        category: 'tests',
        severity: 'low',
        originVersion: '11',
        file: 'tests/TestCase.php',
        issue: 'TestCase still uses CreatesApplication trait — removed in Laravel 11',
        autoFixable: false,
        fix: 'Remove CreatesApplication trait usage from TestCase.php',
      });
    }
  }

  const phpunitXml = join(projectRoot, 'phpunit.xml');
  if (existsSync(phpunitXml)) {
    const content = readFileSync(phpunitXml, 'utf-8');
    if (content.includes('phpunit') && !content.includes('cacheDirectory')) {
      report.issues.push({
        category: 'tests',
        severity: 'low',
        originVersion: '11',
        file: 'phpunit.xml',
        issue: 'phpunit.xml uses old format — Laravel 11 expects PHPUnit 11 configuration',
        autoFixable: false,
        fix: 'Update phpunit.xml to PHPUnit 11 format',
      });
    }
  }
}

// ─── Deprecated Patterns ──────────────────────────────────────

async function checkDeprecatedPatterns(projectRoot, version, report) {
  const patterns = [
    {
      sinceVersion: '9',
      globPattern: 'database/factories/**/*.php',
      pattern: /\$this->faker->\w+[^(\w]/,
      description: 'Faker property access (should be method calls since L9)',
    },
    {
      sinceVersion: '9',
      globPattern: 'database/migrations/**/*.php',
      pattern: /class\s+\w+\s+extends\s+Migration/,
      description: 'Class-based migrations (anonymous since L9)',
    },
  ];

  for (const check of patterns) {
    if (parseInt(version) < parseInt(check.sinceVersion)) continue;

    let files;
    try {
      files = await glob(check.globPattern, { cwd: projectRoot, nodir: true });
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = readFileSync(join(projectRoot, file), 'utf-8');
        if (check.pattern.test(content)) {
          report.issues.push({
            category: 'deprecated-pattern',
            severity: 'low',
            originVersion: check.sinceVersion,
            file,
            issue: check.description,
            autoFixable: false,
            fix: 'Handled by pre-processor transforms',
          });
        }
      } catch {
        // unreadable file — skip
      }
    }
  }
}

// ─── Auto-Fix ─────────────────────────────────────────────────

function applyAutoFixes(projectRoot, report) {
  for (const issue of report.issues) {
    if (!issue.autoFixable || issue.fix !== 'delete') continue;

    const filePath = join(projectRoot, issue.file);
    if (!existsSync(filePath)) continue;

    // Backup before deleting
    const backupDir = join(projectRoot, '.shift', 'backups', dirname(issue.file));
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(filePath, join(backupDir, basename(issue.file)));
    unlinkSync(filePath);

    report.fixes.push({
      file: issue.file,
      action: 'deleted',
      reason: issue.issue,
      originVersion: issue.originVersion,
      backup: join('.shift', 'backups', issue.file),
    });
  }
}

// ─── Scoring ──────────────────────────────────────────────────

export function calculateDebtScore(issues) {
  let score = 0;
  for (const issue of issues) {
    switch (issue.severity) {
      case 'critical': score += 25; break;
      case 'high':     score += 10; break;
      case 'medium':   score += 5;  break;
      case 'low':      score += 1;  break;
    }
  }
  return Math.min(100, score);
}

export function determineActualVersion(issues) {
  const significantIssues = issues.filter(i =>
    i.severity === 'critical' || i.severity === 'high'
  );

  if (significantIssues.length === 0) return null;

  const versions = significantIssues
    .map(i => parseInt(i.originVersion))
    .filter(v => !isNaN(v));

  if (versions.length === 0) return null;
  return String(Math.min(...versions) - 1);
}

/**
 * Generate a summary string for the planner/analyzer context.
 */
export function generateConformitySummary(report) {
  if (!report || report.issues.length === 0) {
    return 'Conformity check passed — project matches declared version.';
  }

  const lines = [
    `CONFORMITY CHECK RESULTS:`,
    `Declared version: Laravel ${report.declaredVersion}`,
    `Debt score: ${report.debtScore}/100`,
  ];

  if (report.actualConformity) {
    lines.push(`WARNING: Project structure resembles Laravel ${report.actualConformity}, not ${report.declaredVersion}.`);
  }

  const remaining = report.issues.filter(i =>
    !report.fixes.some(f => f.file === i.file && f.action === 'deleted')
  );

  if (remaining.length > 0) {
    lines.push('');
    lines.push(`Remaining conformity issues (${remaining.length}):`);
    for (const issue of remaining) {
      lines.push(`- [${issue.severity}] ${issue.file}: ${issue.issue} (from L${issue.originVersion})`);
    }
  }

  if (report.fixes.length > 0) {
    lines.push('');
    lines.push(`Auto-fixed (${report.fixes.length}):`);
    for (const fix of report.fixes) {
      lines.push(`- ${fix.file}: ${fix.action} (${fix.reason})`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate a markdown section for the shift report.
 */
export function generateConformityReportSection(report) {
  if (!report) return '';

  let md = `## Version Conformity Check\n\n`;
  md += `| Declared Version | Actual Conformity | Debt Score | Issues | Auto-Fixed |\n`;
  md += `|---|---|---|---|---|\n`;
  md += `| Laravel ${report.declaredVersion} | ${report.actualConformity ? `Laravel ${report.actualConformity}` : 'Conformant'} | ${report.debtScore}/100 | ${report.issues.length} | ${report.fixes.length} |\n\n`;

  if (report.issues.length > 0) {
    md += `### Conformity Issues Found\n\n`;
    md += `| File | Issue | Origin | Severity | Status |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const issue of report.issues) {
      const wasFixed = report.fixes.some(f => f.file === issue.file);
      md += `| ${issue.file} | ${issue.issue} | L${issue.originVersion} | ${issue.severity} | ${wasFixed ? 'Auto-fixed' : 'Pending'} |\n`;
    }
    md += `\n`;
  }

  return md;
}
