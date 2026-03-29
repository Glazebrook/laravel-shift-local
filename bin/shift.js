#!/usr/bin/env node

// MAINT-4 FIX: Check Node.js version before anything else
const [major] = process.versions.node.split('.');
if (parseInt(major) < 20) {
  console.error('Laravel Shift Local requires Node.js 20 or higher. Current: ' + process.version);
  process.exit(1);
}

/**
 * Laravel Shift Local — CLI Entry Point
 * Usage: shift upgrade --from=10 --to=11 --path=/var/www/myapp
 */

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { KNOWN_VERSIONS, SPECULATIVE_VERSIONS } from '../src/state-manager.js';
import { ShiftBaseError } from '../src/errors.js';

// FINDING-15 FIX: Named constant for .shiftrc max file size
const SHIFTRC_MAX_SIZE = 1_048_576; // 1MB

// BUG-2 FIX: Read version from package.json (single source of truth)
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

const program = new Command();

program
  .name('shift')
  .description('Automated Laravel upgrades powered by Claude multi-agent pipeline')
  .version(PKG_VERSION);

// ── upgrade command ──────────────────────────────────────────────
program
  .command('upgrade')
  .description('Run the full upgrade pipeline')
  .option('-f, --from <version>', 'Current Laravel major version (e.g. 10)')
  .option('-t, --to <version>', 'Target Laravel major version (e.g. 11)')
  .option('-p, --path <path>', 'Path to Laravel project (default: current directory)', process.cwd())
  .option('--verbose', 'Enable verbose logging')
  .option('--fail-fast', 'Stop on first phase failure')
  .option('--dry-run', 'Analyse and plan only — do not make changes')
  .option('--json', 'Output machine-readable JSON to stdout (M2 FIX)')
  .option('--no-rc', 'Ignore .shiftrc config file (SEC-3)')
  .action(async (opts) => {
    try {
      await runUpgrade(opts);
    } catch (err) {
      // M2 FIX: JSON output mode for CI/CD
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          error: { code: err.code || 'SHIFT_ERR_UNKNOWN', message: err.message },
        }));
      } else {
        console.error('\n❌ Shift failed:', err.message);
        if (opts.verbose) console.error(err.stack);
      }
      process.exit(1);
    }
  });

// ── resume command ────────────────────────────────────────────────
program
  .command('resume')
  .description('Resume a previously interrupted upgrade')
  .option('-p, --path <path>', 'Path to Laravel project', process.cwd())
  .option('--verbose', 'Enable verbose logging')
  .option('--dry-run', 'Resume in dry-run mode — skip mutation phases')
  .option('--fail-fast', 'Stop on first phase failure')
  .option('--json', 'Output machine-readable JSON to stdout')
  .option('--keep-retries', 'Preserve retry counters from previous run (default: reset on resume)')
  .option('--no-rc', 'Ignore .shiftrc config file (SEC-3)')
  .action(async (opts) => {
    try {
      await resumeUpgrade(opts);
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, error: { code: err.code || 'SHIFT_ERR_UNKNOWN', message: err.message } }));
      } else {
        console.error('\n❌ Resume failed:', err.message);
      }
      process.exit(1);
    }
  });

// ── status command ────────────────────────────────────────────────
program
  .command('status')
  .description('Show current upgrade status')
  .option('-p, --path <path>', 'Path to Laravel project', process.cwd())
  .option('--json', 'Output machine-readable JSON to stdout')
  .action(async (opts) => {
    try {
      await showStatus(opts);
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ active: false, error: err.message }));
      } else {
        console.error('\n❌ Status check failed:', err.message);
      }
      process.exit(1);
    }
  });

// ── reset command ─────────────────────────────────────────────────
program
  .command('reset')
  .description('Clear shift state to start fresh (does not revert code changes)')
  .option('-p, --path <path>', 'Path to Laravel project', process.cwd())
  .action(async (opts) => {
    await resetState(opts);
  });

// FIX #27: Add rollback command
program
  .command('rollback')
  .description('Rollback the project to the pre-upgrade backup tag')
  .option('-p, --path <path>', 'Path to Laravel project', process.cwd())
  .action(async (opts) => {
    try {
      await rollbackUpgrade(opts);
    } catch (err) {
      console.error('\n❌ Rollback failed:', err.message);
      process.exit(1);
    }
  });

program.parse();

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * M1 FIX: Structured error with machine-readable code.
 */
class ShiftCliError extends ShiftBaseError {
  constructor(code, message) {
    super(code, message);
    this.name = 'ShiftCliError';
  }
}

/**
 * FIX #12/#13: Validate and normalize version arguments.
 * M7 FIX: Warn about speculative target versions.
 */
function validateVersions(from, to) {
  const fromMajor = String(from).split('.')[0];
  const toMajor = String(to).split('.')[0];

  if (!KNOWN_VERSIONS.includes(fromMajor)) {
    throw new ShiftCliError('SHIFT_ERR_UNKNOWN_VERSION',
      `Unknown Laravel version: ${from}. Known versions: ${KNOWN_VERSIONS.join(', ')}`);
  }
  if (!KNOWN_VERSIONS.includes(toMajor)) {
    throw new ShiftCliError('SHIFT_ERR_UNKNOWN_VERSION',
      `Unknown Laravel version: ${to}. Known versions: ${KNOWN_VERSIONS.join(', ')}`);
  }

  const fromIdx = KNOWN_VERSIONS.indexOf(fromMajor);
  const toIdx = KNOWN_VERSIONS.indexOf(toMajor);

  if (toIdx <= fromIdx) {
    throw new ShiftCliError('SHIFT_ERR_INVALID_VERSION_RANGE',
      `Target version (${to}) must be greater than source version (${from}). Downgrades are not supported.`);
  }

  // M7 FIX: Warn prominently about speculative versions
  if (SPECULATIVE_VERSIONS.includes(toMajor)) {
    console.warn(`\n⚠ WARNING: Laravel ${toMajor} is not yet released.`);
    console.warn(`  The upgrade data for version ${toMajor} is SPECULATIVE and may be inaccurate.`);
    console.warn(`  Proceeding anyway — review all changes carefully.\n`);
  }

  return { fromVersion: fromMajor, toVersion: toMajor };
}

/**
 * H4 FIX: Validate .shiftrc config values after loading.
 * Checks types, ranges, and sanitises strings to prevent
 * exploitable values like maxFileRetries: -1 or branchPrefix: "../../etc".
 */
function validateConfig(config) {
  // MED-1 FIX: Log warnings when config values are silently corrected,
  // so enterprise users debugging unexpected behaviour know their config was overridden.

  // maxFileRetries: must be a positive integer
  if (typeof config.maxFileRetries !== 'number' || !Number.isFinite(config.maxFileRetries) || config.maxFileRetries < 1) {
    if (config.maxFileRetries !== undefined && config.maxFileRetries !== 3) {
      console.warn(`Warning: maxFileRetries=${config.maxFileRetries} is invalid, using default (3)`);
    }
    config.maxFileRetries = 3;
  }
  config.maxFileRetries = Math.floor(config.maxFileRetries);
  // FINDING-6 FIX: Cap at reasonable max to prevent infinite retry loops
  if (config.maxFileRetries > 20) {
    console.warn(`Warning: maxFileRetries=${config.maxFileRetries} exceeds maximum (20), capping at 20`);
    config.maxFileRetries = 20;
  }

  // BUG-4 FIX: Validate composerTimeout — must be a finite number >= 30
  if (config.composerTimeout !== undefined) {
    const originalComposerTimeout = config.composerTimeout;
    config.composerTimeout = Number(config.composerTimeout);
    if (!Number.isFinite(config.composerTimeout) || config.composerTimeout < 30) {
      console.warn(`Warning: composerTimeout=${originalComposerTimeout} is invalid (min 30), using default (600)`);
      config.composerTimeout = 600;
    }
    // FINDING-5 FIX: Cap at 1 hour to prevent effectively infinite hangs
    if (config.composerTimeout > 3600) {
      console.warn(`Warning: composerTimeout=${config.composerTimeout} exceeds maximum (3600), capping at 3600`);
      config.composerTimeout = 3600;
    }
  }

  // M7 FIX: Validate artisanTimeout — same rules as composerTimeout
  if (config.artisanTimeout !== undefined) {
    const originalArtisanTimeout = config.artisanTimeout;
    config.artisanTimeout = Number(config.artisanTimeout);
    if (!Number.isFinite(config.artisanTimeout) || config.artisanTimeout < 10) {
      console.warn(`Warning: artisanTimeout=${originalArtisanTimeout} is invalid (min 10), using default (60)`);
      config.artisanTimeout = 60;
    }
    if (config.artisanTimeout > 3600) {
      console.warn(`Warning: artisanTimeout=${config.artisanTimeout} exceeds maximum (3600), capping at 3600`);
      config.artisanTimeout = 3600;
    }
  }

  // C7 FIX: Validate maxTotalTokens — optional cost guardrail
  if (config.maxTotalTokens !== undefined) {
    config.maxTotalTokens = Number(config.maxTotalTokens);
    if (!Number.isFinite(config.maxTotalTokens) || config.maxTotalTokens < 10_000) {
      config.maxTotalTokens = null; // Disable if invalid
    }
  }

  // Boolean fields
  if (typeof config.failFast !== 'boolean') config.failFast = false;
  if (typeof config.verbose !== 'boolean') config.verbose = false;
  if (typeof config.dryRun !== 'boolean') config.dryRun = false;
  if (typeof config.commitAfterEachPhase !== 'boolean') config.commitAfterEachPhase = true;
  if (typeof config.runTests !== 'boolean') config.runTests = true;

  // Model overrides: must be non-empty strings
  if (config.models && typeof config.models === 'object') {
    for (const [key, val] of Object.entries(config.models)) {
      if (typeof val !== 'string' || val.trim() === '') {
        delete config.models[key];
      }
    }
  }

  // Git settings: sanitise branchPrefix and commitPrefix
  if (config.git) {
    if (typeof config.git.branchPrefix === 'string') {
      // H4 FIX: Sanitise branchPrefix — strip path traversal chars
      config.git.branchPrefix = config.git.branchPrefix.replace(/[^a-zA-Z0-9/_-]/g, '');
      // AUDIT-2 FIX: Also strip leading slashes and collapse consecutive slashes,
      // which produce invalid git branch names (e.g. '../../etc/evil' → '//etc/evil').
      config.git.branchPrefix = config.git.branchPrefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
      if (!config.git.branchPrefix || config.git.branchPrefix.includes('..')) {
        config.git.branchPrefix = 'shift/upgrade';
      }
    }
    if (typeof config.git.commitPrefix === 'string') {
      // Strip anything that could inject git command arguments
      config.git.commitPrefix = config.git.commitPrefix.replace(/[^a-zA-Z0-9[\]_ -]/g, '');
      if (!config.git.commitPrefix) config.git.commitPrefix = '[shift]';
    }
    if (typeof config.git.createBackupTag !== 'boolean') config.git.createBackupTag = true;
  }

  // Exclude paths: must be arrays of strings
  if (config.exclude) {
    if (!Array.isArray(config.exclude.paths)) config.exclude.paths = [];
    config.exclude.paths = config.exclude.paths.filter(p => typeof p === 'string' && p.length > 0);
    if (!Array.isArray(config.exclude.filePatterns)) config.exclude.filePatterns = [];
    config.exclude.filePatterns = config.exclude.filePatterns.filter(p => typeof p === 'string' && p.length > 0);
  }

  return config;
}

/**
 * FIX #7: Load .shiftrc configuration if it exists.
 * H10 FIX: Log a warning instead of silently swallowing parse errors.
 * H4 FIX: Validate all loaded values.
 */
function loadConfig(projectPath, cliOpts = {}) {
  const config = {
    failFast: false,
    maxFileRetries: 3,
    verbose: false,
    dryRun: false,
    commitAfterEachPhase: true,
    runTests: true,
    models: {},
    exclude: { paths: [], filePatterns: [] },
    git: {
      branchPrefix: 'shift/upgrade',
      commitPrefix: '[shift]',
      createBackupTag: true,
    },
    shift: {
      fromVersion: null,
      toVersion: null,
    },
  };

  // SEC-3 FIX: Skip .shiftrc if --no-rc flag is set
  // Try loading .shiftrc from project root
  const rcPath = join(projectPath, '.shiftrc');
  if (!cliOpts.noRc && existsSync(rcPath)) {
    try {
      // FIX #12: Reject oversized .shiftrc to prevent OOM on malicious/accidental multi-GB files
      const rcStat = statSync(rcPath);
      if (rcStat.size > SHIFTRC_MAX_SIZE) {
        console.warn('Warning: .shiftrc exceeds 1MB — ignoring. Check the file for corruption.');
      } else {
        const rc = JSON.parse(readFileSync(rcPath, 'utf8'));
        // Merge behaviour settings
        if (rc.behaviour) {
          if (rc.behaviour.failFast !== undefined) config.failFast = rc.behaviour.failFast;
          if (rc.behaviour.maxFileRetries !== undefined) config.maxFileRetries = rc.behaviour.maxFileRetries;
          if (rc.behaviour.verbose !== undefined) config.verbose = rc.behaviour.verbose;
          if (rc.behaviour.commitAfterEachPhase !== undefined) config.commitAfterEachPhase = rc.behaviour.commitAfterEachPhase;
          if (rc.behaviour.runTests !== undefined) config.runTests = rc.behaviour.runTests;
          // BUG-4 FIX: Load composerTimeout from .shiftrc (validated later in validateConfig)
          if (rc.behaviour.composerTimeout !== undefined) config.composerTimeout = rc.behaviour.composerTimeout;
          // M7 FIX: Configurable artisan timeout for large test suites
          if (rc.behaviour.artisanTimeout !== undefined) config.artisanTimeout = rc.behaviour.artisanTimeout;
          // C7 FIX: Optional total token cap to prevent runaway API costs
          if (rc.behaviour.maxTotalTokens !== undefined) config.maxTotalTokens = rc.behaviour.maxTotalTokens;
        }
        // Merge model overrides
        // SEC-001 FIX: Filter prototype pollution keys from .shiftrc models
        if (rc.models && typeof rc.models === 'object') {
          const safeModels = {};
          for (const [key, value] of Object.entries(rc.models)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            safeModels[key] = value;
          }
          config.models = safeModels;
        }
        // Merge exclude patterns
        if (rc.exclude) {
          if (rc.exclude.paths) config.exclude.paths = [...rc.exclude.paths];
          if (rc.exclude.filePatterns) config.exclude.filePatterns = [...rc.exclude.filePatterns];
        }
        // Merge git settings
        if (rc.git) {
          if (rc.git.branchPrefix) config.git.branchPrefix = rc.git.branchPrefix;
          if (rc.git.commitPrefix) config.git.commitPrefix = rc.git.commitPrefix;
          if (rc.git.createBackupTag !== undefined) config.git.createBackupTag = rc.git.createBackupTag;
        }
        // Merge shift version defaults
        if (rc.shift) {
          if (rc.shift.fromVersion) config.shift.fromVersion = String(rc.shift.fromVersion);
          if (rc.shift.toVersion) config.shift.toVersion = String(rc.shift.toVersion);
        }
      }
    } catch (err) {
      // H10 FIX: Log the parse error instead of silently ignoring
      console.warn(`Warning: Could not parse .shiftrc: ${err.message}. Using defaults.`);
    }
  }

  // CLI flags override .shiftrc
  if (cliOpts.failFast) config.failFast = true;
  if (cliOpts.verbose) config.verbose = true;
  // M1 FIX: Use !== undefined so CLI can both enable (--dry-run) and disable
  // (--no-dry-run via commander negation) rather than only enabling.
  if (cliOpts.dryRun !== undefined) config.dryRun = cliOpts.dryRun;

  // H4 FIX: Validate all config values
  return validateConfig(config);
}

// ─── Command implementations ──────────────────────────────────────

async function runUpgrade(opts) {
  const { StateManager } = await import('../src/state-manager.js');
  const { Logger } = await import('../src/logger.js');
  const { Orchestrator } = await import('../src/orchestrator.js');

  const projectPath = resolve(opts.path);

  if (!existsSync(projectPath)) {
    throw new ShiftCliError('SHIFT_ERR_PATH_NOT_FOUND', `Project path not found: ${projectPath}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ShiftCliError('SHIFT_ERR_API_AUTH', 'ANTHROPIC_API_KEY environment variable is required');
  }

  const config = loadConfig(projectPath, opts);

  const fromArg = opts.from || config.shift.fromVersion;
  const toArg = opts.to || config.shift.toVersion;

  if (!fromArg || !toArg) {
    throw new ShiftCliError('SHIFT_ERR_MISSING_VERSIONS',
      '--from and --to are required (or set shift.fromVersion/shift.toVersion in .shiftrc)');
  }

  const { fromVersion, toVersion } = validateVersions(fromArg, toArg);

  const stateManager = new StateManager(projectPath);
  const { resumed } = stateManager.init({
    fromVersion,
    toVersion,
    projectPath,
    branchPrefix: config.git.branchPrefix,
  });

  const logger = new Logger(projectPath, config.verbose);

  // M2 FIX: JSON output mode — minimal console output
  if (opts.json) {
    if (resumed) {
      const summary = stateManager.getSummary();
      console.log(JSON.stringify({ event: 'resume', ...summary }));
    } else {
      console.log(JSON.stringify({ event: 'start', from: fromVersion, to: toVersion, dryRun: !!config.dryRun }));
    }

    const orchestrator = new Orchestrator({
      projectPath,
      stateManager,
      logger,
      // C2 FIX: Pass json flag so _startCiHeartbeat works
      options: { failFast: config.failFast, dryRun: config.dryRun, json: true },
      config,
    });
    await orchestrator.run();

    // M2 FIX: Output final state as JSON
    const finalState = stateManager.get();
    console.log(JSON.stringify({
      success: true,
      event: 'complete',
      from: finalState.fromVersion,
      to: finalState.toVersion,
      phase: finalState.currentPhase,
      transformations: {
        total: finalState.transformations.total,
        completed: finalState.transformations.completed,
        failed: finalState.transformations.failed,
        skipped: finalState.transformations.skipped,
      },
      validation: { passed: finalState.validation?.passed },
      phaseTimings: finalState.phaseTimings || {},
    }));
    return;
  }

  // Normal (non-JSON) output
  let chalk, boxen;
  try {
    chalk = (await import('chalk')).default;
    boxen = (await import('boxen')).default;
  } catch {
    if (resumed) {
      const summary = stateManager.getSummary();
      console.log(`⚡ Resuming interrupted upgrade`);
      console.log(`  Phase: ${summary.phase}`);
      console.log(`  Completed: ${summary.completed.join(', ') || 'none'}`);
      console.log(`  Files: ${summary.files}`);
    } else {
      console.log('🚀 Laravel Shift Local');
      console.log(`  Upgrading: Laravel ${fromVersion} → ${toVersion}`);
      console.log(`  Project: ${projectPath}`);
      if (config.dryRun) console.log('  Mode: DRY RUN — no changes will be made');
    }

    const orchestrator = new Orchestrator({
      projectPath,
      stateManager,
      logger,
      // C2 FIX: Explicitly pass json flag (false in non-JSON path)
      options: { failFast: config.failFast, dryRun: config.dryRun, json: false },
      config,
    });
    await orchestrator.run();
    return;
  }

  if (resumed) {
    const summary = stateManager.getSummary();
    console.log(boxen(
      `${chalk.yellow('⚡ Resuming interrupted upgrade')}\n\n` +
      `  Phase: ${chalk.cyan(summary.phase)}\n` +
      `  Completed: ${summary.completed.join(', ') || 'none'}\n` +
      `  Files: ${summary.files}`,
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
  } else {
    const dryRunLabel = config.dryRun ? `\n  ${chalk.yellow('Mode: DRY RUN — no changes will be made')}` : '';
    console.log(boxen(
      `${chalk.bold.blue('🚀 Laravel Shift Local')}\n\n` +
      `  Upgrading: Laravel ${chalk.bold(fromVersion)} → ${chalk.bold(toVersion)}\n` +
      `  Project: ${chalk.cyan(projectPath)}\n` +
      `  Model: Claude Opus 4 (Orchestrator) + Sonnet 4 (Agents)` +
      dryRunLabel,
      { padding: 1, borderColor: 'blue', borderStyle: 'round' }
    ));
  }

  const orchestrator = new Orchestrator({
    projectPath,
    stateManager,
    logger,
    options: {
      failFast: config.failFast,
      dryRun: config.dryRun,
      // C2 FIX: Explicitly pass json flag (false in non-JSON path)
      json: false,
    },
    config,
  });

  await orchestrator.run();
}

/**
 * H1 FIX: Resume now validates ANTHROPIC_API_KEY before proceeding.
 */
async function resumeUpgrade(opts) {
  const { StateManager } = await import('../src/state-manager.js');
  const { Logger } = await import('../src/logger.js');
  const { Orchestrator } = await import('../src/orchestrator.js');

  const projectPath = resolve(opts.path);
  const stateManager = new StateManager(projectPath);

  if (!stateManager.exists()) {
    throw new ShiftCliError('SHIFT_ERR_NO_STATE', 'No shift state found. Run: shift upgrade --from=X --to=Y');
  }

  // H1 FIX: Check API key before proceeding (was missing from resume)
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ShiftCliError('SHIFT_ERR_API_AUTH', 'ANTHROPIC_API_KEY environment variable is required');
  }

  stateManager.load();

  // BUG-7 FIX: Validate state integrity before using it
  stateManager.validateState();

  // AUDIT FIX: Verify loaded state's projectPath matches the current path.
  // Prevents resuming against the wrong project if .shift/ was copied elsewhere.
  // AUDIT-2 FIX: Case-insensitive comparison on Windows/macOS (NTFS/APFS are case-insensitive).
  const loadedProjectPath = stateManager.get('projectPath');
  const isCaseInsensitiveFS = process.platform === 'win32' || process.platform === 'darwin';
  const resolvedLoaded = resolve(loadedProjectPath || '');
  const pathsMatch = isCaseInsensitiveFS
    ? resolvedLoaded.toLowerCase() === projectPath.toLowerCase()
    : resolvedLoaded === projectPath;
  if (loadedProjectPath && !pathsMatch) {
    throw new ShiftCliError('SHIFT_ERR_PATH_MISMATCH',
      `State was created for '${loadedProjectPath}' but you are resuming from '${projectPath}'. ` +
      `Run 'shift reset' and start a new upgrade, or use --path to specify the correct project.`);
  }

  // M6 FIX: Reset retry counters by default on resume so phases that failed
  // 3 times don't immediately fail again without a single attempt.
  // Use --keep-retries to preserve them if desired.
  if (!opts.keepRetries) {
    stateManager.resetRetries();
  }

  const s = stateManager.get();

  const config = loadConfig(projectPath, opts);
  const logger = new Logger(projectPath, config.verbose);

  if (opts.json) {
    console.log(JSON.stringify({ event: 'resume', from: s.fromVersion, to: s.toVersion, phase: s.currentPhase }));
  } else {
    console.log(`Resuming upgrade: Laravel ${s.fromVersion} → ${s.toVersion}`);
    console.log(`Current phase: ${s.currentPhase}`);
  }

  const orchestrator = new Orchestrator({
    projectPath,
    stateManager,
    logger,
    // C5 FIX: Pass json flag so heartbeats work during resume
    options: { failFast: config.failFast, dryRun: config.dryRun, json: !!opts.json },
    config,
  });
  await orchestrator.run();

  // M2 FIX: JSON completion output for resume
  if (opts.json) {
    const finalState = stateManager.get();
    console.log(JSON.stringify({
      success: true,
      event: 'complete',
      phase: finalState.currentPhase,
      transformations: {
        total: finalState.transformations.total,
        completed: finalState.transformations.completed,
        failed: finalState.transformations.failed,
      },
    }));
  }
}

async function showStatus(opts) {
  const { StateManager } = await import('../src/state-manager.js');

  const projectPath = resolve(opts.path);
  const stateManager = new StateManager(projectPath);

  if (!stateManager.exists()) {
    // M2 FIX: JSON mode
    if (opts.json) {
      console.log(JSON.stringify({ active: false }));
    } else {
      console.log('No active shift found in this project.');
    }
    return;
  }

  stateManager.load();

  // FINDING-9 FIX: Validate state integrity to prevent uncaught crash on corrupted state
  try {
    stateManager.validateState();
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ active: true, error: err.message }));
    } else {
      console.error(`State file is corrupted: ${err.message}`);
    }
    return;
  }

  const s = stateManager.get();
  if (opts.json) {
    console.log(JSON.stringify({
      active: true,
      from: s.fromVersion,
      to: s.toVersion,
      phase: s.currentPhase,
      completedPhases: s.completedPhases,
      branch: s.branchName,
      backupTag: s.backupTag,
      transformations: s.transformations,
      errors: s.errors.length,
      phaseTimings: s.phaseTimings || {},
    }));
    return;
  }

  let chalk;
  try {
    chalk = (await import('chalk')).default;
  } catch {
    console.log('\nLaravel Shift Status');
    console.log('─'.repeat(40));
    console.log(`Upgrade:   Laravel ${s.fromVersion} → ${s.toVersion}`);
    console.log(`Phase:     ${s.currentPhase}`);
    console.log(`Branch:    ${s.branchName}`);
    if (s.backupTag) console.log(`Backup:    ${s.backupTag}`);
    console.log(`Started:   ${s.createdAt}`);
    console.log(`Updated:   ${s.updatedAt}`);
    return;
  }

  console.log('\n' + chalk.bold('Laravel Shift Status'));
  console.log('─'.repeat(40));
  console.log(`Upgrade:   Laravel ${s.fromVersion} → ${s.toVersion}`);
  console.log(`Phase:     ${chalk.cyan(s.currentPhase)}`);
  console.log(`Branch:    ${s.branchName}`);
  if (s.backupTag) console.log(`Backup:    ${chalk.gray(s.backupTag)}`);
  console.log(`Started:   ${s.createdAt}`);
  console.log(`Updated:   ${s.updatedAt}`);
  console.log('\n' + chalk.bold('Phases:'));
  ['ANALYZING', 'PLANNING', 'DEPENDENCIES', 'TRANSFORMING', 'VALIDATING', 'REPORTING'].forEach(p => {
    const done = s.completedPhases.includes(p);
    const current = s.currentPhase === p;
    const icon = done ? chalk.green('✔') : current ? chalk.yellow('→') : chalk.gray('○');
    // M3 FIX: Show phase timing if available
    const timing = s.phaseTimings?.[p];
    const timeLabel = timing ? ` (${(timing.durationMs / 1000).toFixed(1)}s)` : '';
    console.log(`  ${icon} ${p}${timeLabel}`);
  });

  if (s.transformations.total > 0) {
    console.log('\n' + chalk.bold('Transformations:'));
    console.log(`  Total:     ${s.transformations.total}`);
    console.log(`  Done:      ${chalk.green(s.transformations.completed)}`);
    console.log(`  Failed:    ${chalk.red(s.transformations.failed)}`);
    console.log(`  Skipped:   ${chalk.yellow(s.transformations.skipped)}`);
  }

  if (s.errors.length > 0) {
    console.log('\n' + chalk.bold.red(`Errors (${s.errors.length}):`));
    s.errors.slice(-5).forEach(e => {
      console.log(`  [${e.phase}] ${e.message}`);
    });
  }
}

async function resetState(opts) {
  const { StateManager } = await import('../src/state-manager.js');

  const projectPath = resolve(opts.path);
  const stateManager = new StateManager(projectPath);

  if (!stateManager.exists()) {
    console.log('No shift state to reset.');
    return;
  }

  // C6 FIX: Load state so delete() can check stashedChanges
  stateManager.load();
  stateManager.delete();

  try {
    const chalk = (await import('chalk')).default;
    console.log(chalk.yellow('Shift state reset. Run shift upgrade to start fresh.'));
  } catch {
    console.log('Shift state reset. Run shift upgrade to start fresh.');
  }
}

async function rollbackUpgrade(opts) {
  const { StateManager } = await import('../src/state-manager.js');
  const { GitManager } = await import('../src/git-manager.js');
  const { Logger } = await import('../src/logger.js');

  const projectPath = resolve(opts.path);
  const stateManager = new StateManager(projectPath);

  if (!stateManager.exists()) {
    throw new ShiftCliError('SHIFT_ERR_NO_STATE', 'No shift state found. Nothing to rollback.');
  }

  stateManager.load();
  const s = stateManager.get();
  const tag = s.backupTag;

  if (!tag) {
    throw new ShiftCliError('SHIFT_ERR_NO_BACKUP_TAG',
      'No backup tag found in state. Cannot rollback automatically.\n' +
      'You can manually rollback with: git log --oneline --all | grep shift-backup');
  }

  const logger = new Logger(projectPath, false);
  const git = new GitManager(projectPath, logger);

  console.log(`Rolling back to backup tag: ${tag}`);
  const result = await git.rollbackToTag(tag, s.branchName);
  if (!result.ok) {
    throw new ShiftCliError('SHIFT_ERR_ROLLBACK_FAILED', `Git rollback failed: ${result.stderr}`);
  }

  // H3 FIX: Verify the rollback actually landed on the expected commit
  // before deleting state. A partial rollback (checkout ok, reset --hard fails)
  // would leave code in an indeterminate state — keep state so user can investigate.
  const verifyResult = await git.run(['rev-parse', 'HEAD']);
  const tagResult = await git.run(['rev-parse', tag]);
  if (!verifyResult.ok || !tagResult.ok || verifyResult.stdout.trim() !== tagResult.stdout.trim()) {
    console.warn('WARNING: Rollback may not be complete — HEAD does not match backup tag.');
    console.warn('State files preserved for investigation. Run "shift reset" to clear manually.');
    return;
  }

  stateManager.delete();
  console.log('Rollback complete. State cleared.');
}
