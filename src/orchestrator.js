/**
 * Orchestrator - The central coordinator for the entire upgrade pipeline
 *
 * State machine flow:
 * INIT → ANALYZING → PLANNING → DEPENDENCIES → TRANSFORMING → VALIDATING → REPORTING → COMPLETE
 *
 * Each phase is checkpointed. On failure: logs error, increments retry, can resume.
 * Maximum 3 retries per phase before marking as failed and continuing.
 */

import { PHASES } from './state-manager.js';
import { GitManager } from './git-manager.js';
import { FileTools } from './file-tools.js';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync, statSync, utimesSync, readdirSync, copyFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { AnalyzerAgent } from './agents/analyzer-agent.js';
import { PlannerAgent } from './agents/planner-agent.js';
import { DependencyAgent } from './agents/dependency-agent.js';
import { TransformerAgent } from './agents/transformer-agent.js';
import { ValidatorAgent } from './agents/validator-agent.js';
import { ReporterAgent } from './agents/reporter-agent.js';

import { ShiftBaseError } from './errors.js';
import { execCommand, execCommandSync } from './shell.js';
// L1 FIX: Use shared sleep utility instead of duplicating
import { sleep } from './utils.js';
import { runPreProcessing, generatePreProcessingSummary } from './pre-processor.js';
import { checkConformity, generateConformitySummary } from './conformity-checker.js';
import { runStyleFormatting } from './style-formatter.js';
import { loadManifest, getTransitionChain, getAggregatedComposerChanges } from './reference-data.js';
import { formatGuideForPlanner } from './upgrade-guide.js';
import { checkRoutes } from './route-checker.js';
import { generateBlueprintYaml } from './blueprint-exporter.js';

const MAX_PHASE_RETRIES = 3;

// FINDING-15 FIX: Named constants for magic numbers
const STALE_LOCK_MS_WIN = 600_000;               // H5 FIX: 10 min on Windows (2× heartbeat interval)
const LEGACY_LOCK_STALE_MS = 3_600_000;          // 1 hour — threshold for locks without PID (legacy format)
const CI_HEARTBEAT_INTERVAL_MS = 60_000;         // 60s between CI heartbeats
const LOCK_HEARTBEAT_INTERVAL_MS = 300_000;      // 5 min between lock file touches

/**
 * Post-transform safety checks.
 * Catches common LLM mistakes (tombstone files) before the validator runs.
 */
export function postTransformChecks(projectRoot, toVersion) {
  const issues = [];

  // 1. Config files must return arrays
  const configDir = join(projectRoot, 'config');
  if (existsSync(configDir)) {
    const configFiles = readdirSync(configDir).filter(f => f.endsWith('.php'));

    for (const file of configFiles) {
      const filePath = join(configDir, file);
      const content = readFileSync(filePath, 'utf-8');

      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .trim();

      const hasReturn = /return\s+\[/.test(content) || /return\s+array\s*\(/.test(content);

      if (!hasReturn) {
        const isOnlyComments = !stripped.replace(/<\?php/i, '').trim();

        if (isOnlyComments || stripped === '<?php' || stripped === '') {
          const backupDir = join(projectRoot, '.shift', 'backups', 'config');
          mkdirSync(backupDir, { recursive: true });
          copyFileSync(filePath, join(backupDir, file));
          unlinkSync(filePath);
          issues.push({
            file: `config/${file}`,
            action: 'deleted',
            reason: 'Tombstone config file (no return statement) — would crash Laravel LoadConfiguration',
          });
        } else {
          issues.push({
            file: `config/${file}`,
            action: 'warning',
            reason: 'Config file has code but no array return — may break Laravel boot',
          });
        }
      }
    }
  }

  // 2. Structural tombstone cleanup for Laravel 11+ targets
  if (parseInt(toVersion) >= 11) {
    const tombstoneCandidates = [
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
    ];

    for (const relPath of tombstoneCandidates) {
      const filePath = join(projectRoot, relPath);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf-8');
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .replace(/<\?php/gi, '')
        .trim();

      if (!stripped || (!stripped.includes('class') && !stripped.includes('function') && !stripped.includes('return'))) {
        const backupDir = join(projectRoot, '.shift', 'backups', dirname(relPath));
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(filePath, join(backupDir, basename(relPath)));
        unlinkSync(filePath);
        issues.push({
          file: relPath,
          action: 'deleted',
          reason: `Tombstone file — not used in Laravel ${toVersion}+`,
        });
      }
    }
  }

  return issues;
}

/**
 * C1 FIX: ShiftError moved above Orchestrator class.
 * Class declarations are NOT hoisted (unlike function declarations),
 * so ShiftError must be defined before any code that references it.
 *
 * M1 FIX: Structured error class with machine-readable error codes
 * for programmatic handling in CI/CD pipelines.
 */
export class ShiftError extends ShiftBaseError {
  constructor(code, message) {
    super(code, message);
    this.name = 'ShiftError';
  }
}

export class Orchestrator {
  constructor({ projectPath, stateManager, logger, options = {}, config = {} }) {
    this.projectPath = projectPath;
    this.state = stateManager;
    this.logger = logger;
    this.options = options;

    // Shared dependencies
    this.git = new GitManager(projectPath, logger, config.git || {});
    this.fileTools = new FileTools(projectPath, logger, config.exclude || {});

    this.config = config;

    // C7 FIX: Cumulative token usage tracking across all agent runs.
    // Agents report usage back via this shared counter. The orchestrator
    // checks the threshold between files/phases and pauses if exceeded.
    this._cumulativeTokens = { input: 0, output: 0 };
    this._maxTotalTokens = config.maxTotalTokens || null; // null = no limit

    const agentDeps = {
      logger,
      projectPath,
      fileTools: this.fileTools,
      stateManager,
      git: this.git,
      config: this.config,
      // C7 FIX: Shared token tracker so agents can report usage
      tokenTracker: this._cumulativeTokens,
      maxTotalTokens: this._maxTotalTokens,
    };

    // Agent pool
    this.agents = {
      analyzer: new AnalyzerAgent(agentDeps),
      planner: new PlannerAgent(agentDeps),
      dependency: new DependencyAgent(agentDeps),
      transformer: new TransformerAgent(agentDeps),
      validator: new ValidatorAgent(agentDeps),
      reporter: new ReporterAgent(agentDeps),
    };

    // Per-agent token usage report
    this._tokenReport = {};

    // C1 FIX: Setup synchronous signal handlers
    this._setupSignalHandlers();
  }

  /**
   * FIX #5: Signal handler no longer calls process.exit() immediately.
   * Instead, it saves state synchronously, sets a shutdown flag, and throws
   * to unwind the call stack — letting the finally block (with async stash
   * recovery) complete before the process exits.
   */
  _setupSignalHandlers() {
    this._shuttingDown = false;
    const gracefulShutdown = (_signal) => {
      if (this._shuttingDown) {
        // Second signal = force exit
        process.exit(1);
      }
      this._shuttingDown = true;
      try {
        this.state.save();
        this._stopLockHeartbeat();
      } catch { /* best effort */ }
      // Don't process.exit() — let the finally block run for stash recovery.
      // The phase loop checks _shuttingDown and will break out.
    };
    // CRIT-1 FIX: Store handler references so they can be removed in _removeSignalHandlers().
    // Using process.on (not process.once) so the handler remains active for the
    // second signal, which triggers the force-exit path above.
    this._sigintHandler = () => gracefulShutdown('SIGINT');
    this._sigtermHandler = () => gracefulShutdown('SIGTERM');
    process.on('SIGINT', this._sigintHandler);
    process.on('SIGTERM', this._sigtermHandler);
  }

  /**
   * CRIT-1 FIX: Remove signal handlers to prevent listener leak.
   * Each Orchestrator instantiation adds listeners; without cleanup,
   * Node.js emits MaxListenersExceededWarning after 11 instantiations.
   */
  _removeSignalHandlers() {
    if (this._sigintHandler) {
      process.removeListener('SIGINT', this._sigintHandler);
      this._sigintHandler = null;
    }
    if (this._sigtermHandler) {
      process.removeListener('SIGTERM', this._sigtermHandler);
      this._sigtermHandler = null;
    }
  }

  async run() {
    // HIGH-4 FIX: Wrap entire run() in try/finally so _cleanup() (which releases
    // the lock and removes signal handlers) runs even if _preflightChecks() throws.
    try {
      await this._run();
    } finally {
      this._cleanup();
    }
  }

  async _run() {
    const s = this.state.get();
    await this.logger.info('Orchestrator', `Starting upgrade: Laravel ${s.fromVersion} → ${s.toVersion}`);
    await this.logger.info('Orchestrator', `Project: ${this.projectPath}`);
    await this.logger.info('Orchestrator', `Branch: ${s.branchName}`);

    // ── Pre-flight checks ──────────────────────────────────────
    await this._preflightChecks();

    // LOW-3 FIX: Use config.dryRun as the single source of truth for dry-run mode.
    // Previously read from this.options.dryRun which could diverge from config.
    const isDryRun = this.config.dryRun || this.options.dryRun;

    // ── Phase loop ────────────────────────────────────────────
    const phases = [
      { id: PHASES.ANALYZING, fn: () => this._runAnalysis() },
      { id: 'CONFORMITY_CHECK', fn: () => this._runConformityCheck(), skipInDryRun: false },
      { id: 'PRE_PROCESSING', fn: () => this._runPreProcessing(), skipInDryRun: false },
      { id: PHASES.PLANNING, fn: () => this._runPlanning() },
      { id: PHASES.DEPENDENCIES, fn: () => this._runDependencies(), skipInDryRun: true },
      { id: PHASES.TRANSFORMING, fn: () => this._runTransformations(), skipInDryRun: true },
      { id: 'POST_TRANSFORM_CHECKS', fn: () => this._runPostTransformChecks(), skipInDryRun: true },
      { id: PHASES.VALIDATING, fn: () => this._runValidation(), skipInDryRun: true },
      { id: 'STYLE_FORMATTING', fn: () => this._runStyleFormatting(), skipInDryRun: true },
      // LOW-6 FIX: Skip REPORTING in dry-run mode — the report would show
      // "0/0 files transformed" which is misleading. The analysis and plan
      // output from earlier phases is sufficient for dry-run purposes.
      { id: PHASES.REPORTING, fn: () => this._runReporting(), skipInDryRun: true },
    ];

    let allPhasesSucceeded = true;

    // C6 FIX: Wrap phase loop in try/finally for stash recovery on any exception
    try {
      for (const phase of phases) {
        // FIX #5: Check shutdown flag — signal handler sets this to break out gracefully
        if (this._shuttingDown) {
          await this.logger.warn('Orchestrator', 'Shutdown signal received — stopping after current phase.');
          allPhasesSucceeded = false;
          break;
        }

        if (this.state.isPhaseComplete(phase.id)) {
          await this.logger.info('Orchestrator', `✔ ${phase.id} already complete — skipping`);
          continue;
        }

        if (isDryRun && phase.skipInDryRun) {
          await this.logger.info('Orchestrator', `⏭ ${phase.id} skipped (dry-run mode)`);
          continue;
        }

        this.state.setPhase(phase.id);

        // FIX #14: Start CI/CD heartbeat to prevent idle-timeout kills
        const heartbeatInterval = this._startCiHeartbeat(phase.id);

        // M3 FIX: Record phase timing
        const phaseStart = Date.now();
        const success = await this._runPhaseWithRetry(phase);
        const phaseDuration = Date.now() - phaseStart;
        this._recordPhaseTiming(phase.id, phaseStart, phaseDuration);

        // FIX #14: Stop heartbeat
        if (heartbeatInterval) clearInterval(heartbeatInterval);

        if (!success) {
          allPhasesSucceeded = false;
          await this.logger.error('Orchestrator', `Phase ${phase.id} failed after max retries (${phaseDuration}ms)`);
          if (this.options.failFast) {
            this.state.setPhase(PHASES.ERROR);
            throw new Error(`Upgrade aborted at phase: ${phase.id}`);
          }
          await this.logger.warn('Orchestrator', `Continuing despite ${phase.id} failure...`);
        }

        if (success) {
          this.state.markPhaseComplete(phase.id);
        }
      }

      // C4 FIX: Only mark COMPLETE if all phases actually succeeded
      this.state.setPhase(allPhasesSucceeded ? PHASES.COMPLETE : PHASES.ERROR);

    } finally {
      // C6 FIX: Always attempt stash recovery on non-success paths
      if (this.state.get('stashedChanges')) {
        if (allPhasesSucceeded && this.state.get('currentPhase') === PHASES.COMPLETE) {
          try {
            await this.logger.info('Orchestrator', 'Restoring stashed changes...');
            await this.git.stashPop();
            this.state.set('stashedChanges', false);
          } catch (err) {
            await this.logger.warn('Orchestrator', `Failed to restore stash: ${err.message}. Run "git stash pop" manually.`);
          }
        } else {
          await this.logger.warn('Orchestrator', 'Upgrade did not complete successfully — stashed changes NOT restored to avoid merge conflicts.');
          await this.logger.warn('Orchestrator', 'Run "git stash pop" manually after resolving failures.');
        }
      }
    }

    // REL-10 FIX: Wrap _printSummary so a failure can't prevent lock release
    try { await this._printSummary(); } catch { /* non-fatal */ }

    // FINDING-10 FIX: Clean up pending timers to allow clean process exit
    this.state.destroy();
    this.logger.destroy();

    // AUDIT: _removeSignalHandlers and _releaseLock are now handled by _cleanup()
    // in the outer finally block of run(), so no need to call them here.
  }

  /**
   * HIGH-4 FIX: Centralised cleanup that always runs, even if _preflightChecks() throws.
   */
  _cleanup() {
    this._removeSignalHandlers();
    this._releaseLock();
  }

  /**
   * M3 FIX: Record timing for each phase in state.
   */
  _recordPhaseTiming(phaseId, startTime, durationMs) {
    const timings = this.state.get('phaseTimings') || {};
    timings[phaseId] = {
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date(startTime + durationMs).toISOString(),
      durationMs,
    };
    this.state.set('phaseTimings', timings);
  }

  /**
   * FIX #4: Periodically touch the lock file mtime so long-running upgrades
   * (>1 hour) don't have their locks stolen by the stale-lock detector.
   */
  _startLockHeartbeat() {
    if (!this._lockPath) return;
    this._lockHeartbeat = setInterval(() => {
      try {
        if (existsSync(this._lockPath)) {
          const now = new Date();
          utimesSync(this._lockPath, now, now);
        }
      } catch { /* best effort */ }
    }, LOCK_HEARTBEAT_INTERVAL_MS); // Every 5 minutes
    this._lockHeartbeat.unref();
  }

  _stopLockHeartbeat() {
    if (this._lockHeartbeat) {
      clearInterval(this._lockHeartbeat);
      this._lockHeartbeat = null;
    }
  }

  /**
   * FIX #14: Emit periodic heartbeat events during long phases to prevent
   * CI/CD idle-timeout kills (most runners kill after 10 min of no output).
   */
  _startCiHeartbeat(phaseId) {
    if (!this.options.json) return null;
    const interval = setInterval(() => {
      // FINDING-7 FIX: Removed dead `const elapsed = Date.now()` variable
      console.log(JSON.stringify({
        event: 'heartbeat',
        phase: phaseId,
        timestamp: new Date().toISOString(),
        transformations: {
          completed: this.state.get('transformations')?.completed || 0,
          total: this.state.get('transformations')?.total || 0,
          failed: this.state.get('transformations')?.failed || 0,
        },
      }));
    }, CI_HEARTBEAT_INTERVAL_MS); // Every 60 seconds
    interval.unref();
    return interval;
  }

  async _runPhaseWithRetry(phase) {
    while (this.state.getRetryCount(phase.id) < MAX_PHASE_RETRIES) {
      // H1 FIX: Check shutdown flag before each attempt so mid-phase signals
      // don't continue burning API calls through remaining retries.
      if (this._shuttingDown) {
        await this.logger.warn('Orchestrator', `Shutdown signal received — aborting ${phase.id} retries.`);
        return false;
      }
      try {
        await phase.fn();
        return true;
      } catch (err) {
        const retries = this.state.incrementRetry(phase.id);
        this.state.logError(phase.id, err);
        await this.logger.error('Orchestrator', `Phase ${phase.id} error (attempt ${retries}/${MAX_PHASE_RETRIES}): ${err.message}`);

        if (retries >= MAX_PHASE_RETRIES) return false;

        const delay = 2000 * retries;
        await this.logger.warn('Orchestrator', `Retrying ${phase.id} in ${delay}ms...`);
        await sleep(delay);
      }
    }
    return false;
  }

  // ─── Pre-flight ──────────────────────────────────────────────

  async _preflightChecks() {
    await this.logger.info('Orchestrator', 'Running pre-flight checks...');

    // Laravel project detection — runs before lock/git/API checks to fail fast
    // and avoid wasting resources on non-Laravel projects
    if (!this.fileTools.fileExists('composer.json')) {
      throw new ShiftError('SHIFT_ERR_NOT_LARAVEL',
        'No composer.json found. This does not appear to be a PHP/Laravel project.');
    }

    try {
      const composerJson = JSON.parse(readFileSync(join(this.projectPath, 'composer.json'), 'utf-8'));
      const requires = { ...composerJson.require, ...composerJson['require-dev'] };
      if (!requires['laravel/framework']) {
        throw new ShiftError('SHIFT_ERR_NOT_LARAVEL',
          'composer.json does not require laravel/framework. This does not appear to be a Laravel project.');
      }
    } catch (err) {
      if (err.code === 'SHIFT_ERR_NOT_LARAVEL' || err instanceof ShiftError) throw err;
      throw new ShiftError('SHIFT_ERR_NOT_LARAVEL',
        `Failed to parse composer.json: ${err.message}`);
    }

    if (!existsSync(join(this.projectPath, 'artisan'))) {
      throw new ShiftError('SHIFT_ERR_NOT_LARAVEL',
        'No artisan file found. This does not appear to be a Laravel project.');
    }

    // C3 FIX: Atomic lock file
    this._acquireLock();

    // Git check
    if (!await this.git.isGitRepo()) {
      throw new Error('Project must be a git repository. Run: git init && git add -A && git commit -m "Initial commit"');
    }

    // Anthropic API key
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable not set');
    }

    // H9 FIX: Check binaries with Windows shell support
    await this._checkBinary('php', 'PHP is required for syntax checking, artisan commands, and composer operations');
    await this._checkBinary('composer', 'Composer is required for dependency management');

    // M5 FIX: Check available disk space
    await this._checkDiskSpace();

    await this._checkSpeculativeTarget();

    // M8 FIX: Ensure .gitignore handles empty file edge case
    await this._ensureGitignore();

    if (!this.state.get('stashedChanges')) {
      const stashResult = await this.git.stashChanges();
      if (stashResult.stashed) {
        this.state.set('stashedChanges', true);
      }
    }

    // Create/checkout upgrade branch
    const s = this.state.get();
    await this.git.createOrCheckoutBranch(s.branchName);

    if (!this.state.get('backupTag') && this.config.git?.createBackupTag !== false) {
      const tag = await this.git.createBackupTag('pre-shift');
      this.state.set('backupTag', tag);
    }

    await this.logger.success('Orchestrator', 'Pre-flight checks passed');
  }

  /**
   * M8 FIX: Handle empty .gitignore files correctly.
   * Ensures no leading blank line when file is empty.
   */
  async _ensureGitignore() {
    const gitignorePath = '.gitignore';
    try {
      let content = '';
      if (this.fileTools.fileExists(gitignorePath)) {
        content = this.fileTools.readFile(gitignorePath);
      }
      // FINDING-20 FIX: Broader regex to catch common .shift ignore variants:
      // .shift, .shift/, .shift/*, .shift/** — prevents duplicate entries
      if (!/^\.shift(\/.*)?$/m.test(content)) {
        // M8 FIX: Handle empty file — don't add leading newline
        let addition;
        if (content.length === 0) {
          addition = '.shift/\n';
        } else if (content.endsWith('\n') || content.endsWith('\r\n')) {
          addition = '.shift/\n';
        } else {
          addition = '\n.shift/\n';
        }
        this.fileTools.writeFile(gitignorePath, content + addition);
        await this.logger.info('Orchestrator', 'Added .shift/ to .gitignore');
      }
    } catch (err) {
      await this.logger.warn('Orchestrator', `Could not update .gitignore: ${err.message}`);
    }
  }

  /**
   * C3 FIX: Atomic lock file using 'wx' flag (exclusive create).
   * This is atomic on all platforms — if two processes race, only one
   * succeeds with 'wx' and the other gets EEXIST.
   */
  _acquireLock() {
    this._lockPath = join(this.projectPath, '.shift', 'lock');
    const lockDir = join(this.projectPath, '.shift');
    if (!existsSync(lockDir)) {
      mkdirSync(lockDir, { recursive: true });
    }

    const lockContent = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      hostname: hostname(),
    });

    try {
      // C3 FIX: 'wx' flag = exclusive create, atomic on all platforms
      writeFileSync(this._lockPath, lockContent, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Lock file exists — check if stale
        let stale = false;
        try {
          const raw = readFileSync(this._lockPath, 'utf8').trim();
          let lockData;
          try {
            lockData = JSON.parse(raw);
          } catch {
            // Could be legacy format (plain PID) or corrupted
            const lockPid = parseInt(raw, 10);
            if (!isNaN(lockPid)) {
              lockData = { pid: lockPid };
            } else {
              // Corrupted lock file — treat as stale
              stale = true;
            }
          }

          if (lockData && !stale) {
            const pid = lockData.pid;

            if (process.platform === 'win32') {
              // REL-4 FIX: On Windows, process.kill(pid, 0) is unreliable.
              // Use lock file age as a heuristic instead.
              const lockAge = Date.now() - statSync(this._lockPath).mtimeMs;
              stale = lockAge > STALE_LOCK_MS_WIN;
            } else if (pid) {
              try { process.kill(pid, 0); } catch { stale = true; }
            } else {
              // No PID in lock data (legacy format without PID)
              const lockAge = Date.now() - statSync(this._lockPath).mtimeMs;
              stale = lockAge > LEGACY_LOCK_STALE_MS;
            }
          }
        } catch { stale = true; }

        if (!stale) {
          throw new ShiftError(
            'SHIFT_ERR_LOCK_HELD',
            'Another shift process is already running on this project. If this is incorrect, delete .shift/lock'
          );
        }
        // Stale lock — remove and re-acquire
        try { unlinkSync(this._lockPath); } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') {
            throw new ShiftError('SHIFT_ERR_LOCK_CLEANUP',
              `Cannot remove stale lock file: ${unlinkErr.message}. Check file permissions on .shift/lock`);
          }
        }
        try {
          writeFileSync(this._lockPath, lockContent, { flag: 'wx' });
        } catch (retryErr) {
          if (retryErr.code === 'EEXIST') {
            throw new ShiftError('SHIFT_ERR_LOCK_HELD',
              'Another shift process acquired the lock during stale lock recovery.');
          }
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
    // FIX #4: Start lock heartbeat to prevent stale-lock theft during long upgrades
    this._startLockHeartbeat();
  }

  _releaseLock() {
    this._stopLockHeartbeat();
    if (this._lockPath && existsSync(this._lockPath)) {
      try { unlinkSync(this._lockPath); } catch { /* best effort */ }
    }
  }

  /**
   * H9 FIX: Check binary availability with Windows shell support.
   * FIX #11: Validate binary name against a safe pattern to prevent
   * command injection if names ever come from user config.
   */
  async _checkBinary(name, explanation) {
    // FIX #11: Validate binary name to prevent argument/command injection
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new ShiftError('SHIFT_ERR_INVALID_BINARY',
        `Invalid binary name: '${name}'. Binary names must match /^[a-zA-Z0-9._-]+$/.`);
    }
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execCommandSync(cmd, [name], { stdio: 'ignore' });
    if (!result.ok) {
      throw new ShiftError(
        'SHIFT_ERR_BINARY_MISSING',
        `'${name}' not found on PATH. ${explanation}`
      );
    }
  }

  /**
   * M5 FIX: Check available disk space before starting.
   * Warns if less than 500MB available (backups + git objects can add up).
   */
  async _checkDiskSpace() {
    try {
      if (process.platform === 'win32') {
        // LOW-1 FIX: Use PowerShell to check disk space on Windows
        const driveLetter = this.projectPath.charAt(0).toUpperCase();
        // SEC-009 FIX: Validate driveLetter is a single alpha char A-Z before interpolation
        if (!/^[A-Z]$/.test(driveLetter)) {
          await this.logger.warn('Orchestrator', `Cannot check disk space: invalid drive letter '${driveLetter}'`);
          return;
        }
        const psResult = execCommandSync('powershell', [
          '-NoProfile', '-Command',
          `(Get-PSDrive ${driveLetter}).Free / 1MB`,
        ], { timeout: 10_000 });
        if (!psResult.ok) return;
        const output = psResult.stdout;
        const availMB = parseInt(output.trim(), 10);
        if (!isNaN(availMB) && availMB < 500) {
          await this.logger.warn('Orchestrator',
            `Low disk space: ~${availMB}MB available. The upgrade creates backups for each file. Consider freeing space.`
          );
        }
        return;
      }
      // C3 FIX: Use execCommandSync to avoid shell interpretation
      const dfResult = execCommandSync('df', ['-m', this.projectPath]);
      if (!dfResult.ok) return;
      const output = dfResult.stdout;
      const lines = output.trim().split('\n');
      if (lines.length < 2) return;
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      const availMB = parseInt(parts[3], 10);
      if (!isNaN(availMB) && availMB < 500) {
        await this.logger.warn('Orchestrator',
          `Low disk space: ~${availMB}MB available. The upgrade creates backups for each file. Consider freeing space.`
        );
      }
    } catch {
      // Non-fatal — skip check if df/PowerShell not available
    }
  }

  async _checkSpeculativeTarget() {
    const { UPGRADE_MATRIX, getUpgradePath } = await import('../config/upgrade-matrix.js');
    const s = this.state.get();
    const path = getUpgradePath(s.fromVersion, s.toVersion);
    for (let i = 0; i < path.length - 1; i++) {
      const key = `${path[i]}->${path[i + 1]}`;
      const entry = UPGRADE_MATRIX[key];
      if (entry?.speculative) {
        await this.logger.warn('Orchestrator',
          `⚠ Laravel ${path[i + 1]} upgrade data is SPECULATIVE (not yet released). ` +
          `The breaking changes and hints for the ${key} step are provisional and may be inaccurate.`
        );
      }
    }
  }

  // ─── Token tracking ─────────────────────────────────────────

  _captureTokenUsage(agentName) {
    const agent = this.agents[agentName];
    if (!agent) return;
    const usage = agent.tokenUsage;
    this._tokenReport[agentName] = usage;
    this.state.setTokenUsage(agentName, usage);
  }

  getTokenReport() {
    return { ...this._tokenReport };
  }

  // ─── Phase handlers ──────────────────────────────────────────

  async _phaseCommit(phase, details = '') {
    if (this.config.commitAfterEachPhase !== false) {
      // BUG-5 FIX: Check commit result and warn on failure
      const result = await this.git.phaseCommit(phase, details);
      if (!result.ok && !result.noop) {
        await this.logger.warn('Orchestrator',
          `Git commit for phase ${phase} failed: ${result.stderr}. Changes are staged but not committed.`);
      }
    }
  }

  async _runAnalysis() {
    const s = this.state.get();
    const analysis = await this.agents.analyzer.analyze(s.fromVersion, s.toVersion);
    this._captureTokenUsage('analyzer');
    this.state.set('analysis', analysis);
    await this.logger.success('Orchestrator', `Analysis complete: ${analysis.upgradeComplexity} complexity, ${analysis.filesToTransform?.length || 0} files to transform`);
    await this._phaseCommit('analysis', `${analysis.upgradeComplexity} complexity`);
  }

  // ─── Conformity Check ──────────────────────────────────────

  async _runConformityCheck() {
    const s = this.state.get();
    const conformityConfig = this.config.conformityCheck || {};

    if (conformityConfig.enabled === false) {
      await this.logger.info('Orchestrator', 'Conformity check disabled via config');
      this.state.set('conformityReport', null);
      return;
    }

    await this.logger.phase('CONFORMITY CHECK: Version Debt Analysis');

    const report = await checkConformity(
      this.projectPath,
      s.fromVersion,
      {
        autoFix: conformityConfig.autoFix !== false,
        skipChecks: conformityConfig.skip || [],
      }
    );

    this.state.set('conformityReport', report);

    if (report.issues.length > 0) {
      await this.logger.warn('Orchestrator',
        `Found ${report.issues.length} conformity issue(s) (debt score: ${report.debtScore}/100)`);

      if (report.actualConformity) {
        await this.logger.warn('Orchestrator',
          `Project structure resembles Laravel ${report.actualConformity}, not ${s.fromVersion} as declared`);
      }

      if (report.fixes.length > 0) {
        await this.logger.info('Orchestrator',
          `Auto-fixed ${report.fixes.length} issue(s)`);
        await this._phaseCommit('conformity', `${report.fixes.length} structural issues resolved`);
      }

      // Fail on critical issues if configured (default: true)
      if (conformityConfig.failOnCritical !== false) {
        const criticalIssues = report.issues.filter(i => i.severity === 'critical');
        if (criticalIssues.length > 0) {
          const details = criticalIssues.map(i => `  - ${i.file}: ${i.issue}`).join('\n');
          throw new Error(
            `Critical conformity issues found (${criticalIssues.length}):\n${details}\n` +
            'Fix these before upgrading, or set conformityCheck.failOnCritical: false in .shiftrc.'
          );
        }
      }
    } else {
      await this.logger.info('Orchestrator', 'Conformity check passed — project matches declared version');
    }
  }

  // ─── Pre-Processing (deterministic transforms) ──────────────

  async _runPreProcessing() {
    const s = this.state.get();
    const preProcessingConfig = this.config.preProcessing || {};

    if (preProcessingConfig.enabled === false) {
      await this.logger.info('Orchestrator', 'Pre-processing disabled via config');
      this.state.set('preProcessingResult', { transforms: [], filesModified: 0, totalChanges: 0 });
      return;
    }

    await this.logger.phase('PRE-PROCESSING: Deterministic Transforms');

    const result = await runPreProcessing(
      this.projectPath,
      s.fromVersion,
      s.toVersion,
      { dryRun: this.config.dryRun || this.options.dryRun, verbose: this.config.verbose, logger: this.logger },
      preProcessingConfig
    );

    this.state.set('preProcessingResult', result);

    if (result.totalChanges > 0) {
      await this.logger.success('Orchestrator',
        `Pre-processing: ${result.totalChanges} change(s) across ${result.filesModified} file(s)`);
      await this._phaseCommit('pre-processing', `${result.totalChanges} deterministic transforms`);
    } else {
      await this.logger.info('Orchestrator', 'Pre-processing: no changes needed');
    }
  }

  // ─── Style Formatting (post-processing) ─────────────────────

  async _runStyleFormatting() {
    const styleConfig = this.config.codeStyle || {};

    await this.logger.phase('STYLE FORMATTING: Code Style Post-Processing');

    const result = await runStyleFormatting(
      this.projectPath,
      { dryRun: this.config.dryRun || this.options.dryRun, verbose: this.config.verbose, logger: this.logger },
      styleConfig
    );

    this.state.set('styleResult', result);

    if (result.formatted) {
      await this.logger.success('Orchestrator',
        `Style formatting: ${result.filesChanged} file(s) reformatted with ${result.formatter}`);
      await this._phaseCommit('style', `${result.filesChanged} files formatted`);
    } else {
      await this.logger.info('Orchestrator', `Style formatting: ${result.formatter === 'none' ? 'disabled' : 'no changes'}`);
    }
  }

  /**
   * H6 FIX: Pass current transformation state to planner so it can
   * account for already-completed work when generating the plan on resume.
   */
  async _runPlanning() {
    const s = this.state.get();

    // H6 FIX: Collect already-completed files to pass as context
    const completedFiles = Object.entries(s.transformations.files || {})
      .filter(([, v]) => v.status === 'done')
      .map(([k, v]) => ({ filepath: k, description: v.description || '' }));

    // Enrich planner context with reference data, upgrade guide, and pre-processing results
    const referenceContext = {
      manifest: loadManifest(s.fromVersion, s.toVersion),
      transitionChain: getTransitionChain(s.fromVersion, s.toVersion),
      composerChanges: getAggregatedComposerChanges(s.fromVersion, s.toVersion),
      upgradeGuide: formatGuideForPlanner(s.toVersion),
      preProcessingSummary: generatePreProcessingSummary(s.preProcessingResult),
      conformitySummary: s.conformityReport ? generateConformitySummary(s.conformityReport) : null,
    };

    const plan = await this.agents.planner.plan(s.analysis, s.fromVersion, s.toVersion, completedFiles, referenceContext);
    this._captureTokenUsage('planner');

    // M4 FIX: Validate that the plan has the expected structure.
    // If the LLM returns valid JSON missing .phases, we'd silently proceed
    // with zero transformations and report success.
    if (!plan.phases || !Array.isArray(plan.phases) || plan.phases.length === 0) {
      throw new Error(
        'Planner returned a plan with no phases. The LLM response was valid JSON but missing the required "phases" array. ' +
        'This usually means the planner prompt needs adjustment or the model returned an unexpected format.'
      );
    }

    // HIGH-3 FIX: Validate that individual phases have the expected structure.
    // A plan like { phases: [{ phase: "code_transforms" }] } (missing steps)
    // would pass the above check but result in zero transformations with a success exit code.
    for (const phase of plan.phases) {
      if (!phase.phase || typeof phase.phase !== 'string') {
        throw new Error(`Plan phase missing 'phase' field: ${JSON.stringify(phase).slice(0, 100)}`);
      }
      if (phase.steps && !Array.isArray(phase.steps)) {
        throw new Error(`Plan phase '${phase.phase}' has non-array 'steps' field`);
      }
    }

    this.state.set('plan', plan);

    const allFiles = plan.phases
      ?.flatMap(p => p.steps || [])
      .filter(s => s.filepath)
      .map(s => s.filepath) || [];

    const unique = [...new Set(allFiles)];
    const transformations = this.state.get('transformations');
    for (const f of unique) {
      if (!transformations.files[f]) {
        this.state.setFileStatus(f, 'pending');
      }
    }
    transformations.total = unique.length;
    this.state.set('transformations', transformations);

    await this.logger.success('Orchestrator', `Plan created: ${unique.length} files to transform`);
    await this._phaseCommit('planning');
  }

  async _runDependencies() {
    const s = this.state.get();
    if (!s.plan) {
      await this.logger.warn('Orchestrator', 'No plan available (planning phase failed) — skipping dependency update');
      return;
    }
    const referenceComposer = getAggregatedComposerChanges(s.fromVersion, s.toVersion);
    const result = await this.agents.dependency.updateDependencies(s.plan, referenceComposer);
    this._captureTokenUsage('dependency');
    this.state.set('dependencyResult', result);

    // Clear stale bootstrap cache after dependency changes
    await this._postDependencyCleanup();

    await this._phaseCommit('dependencies', 'composer.json updated');
    await this.logger.success('Orchestrator', 'Dependencies updated');
  }

  /**
   * Clear bootstrap cache files after dependency updates to prevent stale
   * provider references (e.g. Fruitcake\Cors after removing fruitcake/laravel-cors).
   * Also regenerates the autoloader and runs package:discover.
   */
  async _postDependencyCleanup() {
    const cacheDir = join(this.projectPath, 'bootstrap', 'cache');
    if (existsSync(cacheDir)) {
      const cacheFiles = readdirSync(cacheDir).filter(f => f.endsWith('.php'));
      for (const file of cacheFiles) {
        try {
          unlinkSync(join(cacheDir, file));
          await this.logger.info('Orchestrator', `Cleared stale cache: bootstrap/cache/${file}`);
        } catch (err) {
          await this.logger.warn('Orchestrator', `Failed to clear bootstrap/cache/${file}: ${err.message}`);
        }
      }
    }

    // Regenerate autoloader
    try {
      await execCommand('composer', ['dump-autoload', '--no-interaction'], {
        cwd: this.projectPath,
        timeout: 60_000,
        useProcessEnv: true,
      });
      await this.logger.info('Orchestrator', 'Regenerated autoloader');
    } catch (err) {
      await this.logger.warn('Orchestrator', `dump-autoload failed: ${err.message}`);
    }

    // Regenerate package manifests
    try {
      await execCommand('php', ['artisan', 'package:discover', '--ansi'], {
        cwd: this.projectPath,
        timeout: 30_000,
        useProcessEnv: true,
      });
      await this.logger.info('Orchestrator', 'Regenerated package discovery');
    } catch (err) {
      // May fail if artisan can't boot yet — transforms will fix it
      await this.logger.debug('Orchestrator', `package:discover skipped: ${err.message}`);
    }
  }

  async _runTransformations() {
    const s = this.state.get();
    if (!s.plan) {
      await this.logger.warn('Orchestrator', 'No plan available (planning phase failed) — skipping transformations');
      return;
    }
    const results = await this.agents.transformer.transform(s.plan, s.analysis);
    this._captureTokenUsage('transformer');
    await this._phaseCommit('transforms', `${results.transformed.length} files transformed`);
    await this.logger.success('Orchestrator', `Transforms: ${results.transformed.length} done, ${results.failed.length} failed, ${results.skipped.length} skipped`);
  }

  async _runPostTransformChecks() {
    const s = this.state.get();
    const toVersion = s.toVersion;
    const issues = postTransformChecks(this.projectPath, toVersion);

    if (issues.length > 0) {
      for (const issue of issues) {
        if (issue.action === 'deleted') {
          await this.logger.warn('Orchestrator', `Post-transform cleanup: deleted ${issue.file} — ${issue.reason}`);
        } else {
          await this.logger.warn('Orchestrator', `Post-transform warning: ${issue.file} — ${issue.reason}`);
        }
      }
      this.state.set('postTransformIssues', issues);
      await this._phaseCommit('post-transform-checks', `${issues.filter(i => i.action === 'deleted').length} tombstone(s) cleaned`);
    } else {
      await this.logger.info('Orchestrator', 'Post-transform checks: no issues found');
    }
  }

  async _runValidation() {
    const s = this.state.get();
    const validation = await this.agents.validator.validate(s.analysis || {}, s.plan || {}, { runTests: this.config.runTests });
    this._captureTokenUsage('validator');

    // Dead route detection (runs after syntax checks)
    try {
      await this.logger.info('Orchestrator', 'Running dead route detection...');
      const routeResult = await checkRoutes(this.projectPath);
      validation.routeCheck = routeResult;
      if (routeResult.deadRoutes.length > 0) {
        await this.logger.warn('Orchestrator',
          `Dead route detection: ${routeResult.deadRoutes.length} dead route(s) found`);
        validation.warnings = validation.warnings || [];
        validation.warnings.push(`${routeResult.deadRoutes.length} dead route(s) detected — see SHIFT_REPORT.md`);
      } else {
        await this.logger.success('Orchestrator',
          `Route health check: all ${routeResult.checked} route(s) valid`);
      }
    } catch (err) {
      await this.logger.warn('Orchestrator', `Dead route detection failed: ${err.message}`);
    }

    this.state.set('validation', validation);
    await this._phaseCommit('validation', validation.passed ? 'PASSED' : 'WARNINGS');
    if (validation.passed) {
      await this.logger.success('Orchestrator', 'Validation passed');
    } else {
      await this.logger.warn('Orchestrator', 'Validation completed with warnings — see SHIFT_REPORT.md');
    }
  }

  async _runReporting() {
    const s = this.state.get();

    // Generate Blueprint YAML if enabled
    const blueprintConfig = this.config.blueprint || {};
    if (blueprintConfig.enabled !== false) {
      try {
        const blueprint = await generateBlueprintYaml(this.projectPath, {
          includeControllers: blueprintConfig.includeControllers !== false,
          outputPath: blueprintConfig.outputPath || '.shift/blueprint.yaml',
          logger: this.logger,
        });
        this.state.set('blueprint', blueprint);
      } catch (err) {
        await this.logger.warn('Orchestrator', `Blueprint YAML generation failed: ${err.message}`);
      }
    }

    const report = await this.agents.reporter.generateReport(s);
    this._captureTokenUsage('reporter');
    this.state.set('report', report);
    await this._phaseCommit('report', 'SHIFT_REPORT.md generated');
    await this.logger.success('Orchestrator', `Report: ${report.reportPath}`);
  }

  // ─── Summary ─────────────────────────────────────────────────

  async _printSummary() {
    let chalk, boxen;
    try {
      chalk = (await import('chalk')).default;
      boxen = (await import('boxen')).default;
    } catch {
      const s = this.state.get();
      const phase = s.currentPhase;
      const icon = phase === PHASES.COMPLETE ? '✔' : '⚠';
      console.log(`\n${icon} Laravel Shift ${phase === PHASES.COMPLETE ? 'Complete' : 'Finished with Errors'}!`);
      console.log(`  From: Laravel ${s.fromVersion}`);
      console.log(`  To: Laravel ${s.toVersion}`);
      console.log(`  Branch: ${s.branchName}`);
      console.log(`  Files transformed: ${s.transformations.completed}/${s.transformations.total}`);
      console.log(`  Failed: ${s.transformations.failed}`);
      console.log(`  Validation: ${s.validation?.passed ? 'PASSED' : 'WARNINGS'}`);
      // M3 FIX: Show total duration
      const timings = s.phaseTimings || {};
      const totalMs = Object.values(timings).reduce((sum, t) => sum + (t.durationMs || 0), 0);
      if (totalMs > 0) console.log(`  Total time: ${(totalMs / 1000).toFixed(1)}s`);
      console.log('\nNext steps:');
      console.log('  1. Review SHIFT_REPORT.md for manual review items');
      console.log('  2. Run php artisan to verify the application boots');
      console.log('  3. Run php artisan test to verify your test suite');
      console.log(`  4. Create a PR from ${s.branchName}`);
      return;
    }

    const s = this.state.get();
    const isComplete = s.currentPhase === PHASES.COMPLETE;

    // M3 FIX: Calculate total duration
    const timings = s.phaseTimings || {};
    const totalMs = Object.values(timings).reduce((sum, t) => sum + (t.durationMs || 0), 0);

    const lines = [
      isComplete
        ? chalk.bold.green('✔ Laravel Shift Complete!')
        : chalk.bold.yellow('⚠ Laravel Shift Finished with Errors'),
      '',
      `  ${chalk.bold('From:')} Laravel ${s.fromVersion}`,
      `  ${chalk.bold('To:')} Laravel ${s.toVersion}`,
      `  ${chalk.bold('Branch:')} ${s.branchName}`,
      '',
      `  ${chalk.bold('Files transformed:')} ${s.transformations.completed}/${s.transformations.total}`,
      `  ${chalk.bold('Failed:')} ${s.transformations.failed}`,
      `  ${chalk.bold('Validation:')} ${s.validation?.passed ? chalk.green('PASSED') : chalk.yellow('WARNINGS')}`,
    ];

    if (totalMs > 0) {
      lines.push(`  ${chalk.bold('Total time:')} ${(totalMs / 1000).toFixed(1)}s`);
    }

    lines.push(
      '',
      chalk.bold('Next steps:'),
      `  1. Review ${chalk.cyan('SHIFT_REPORT.md')} for manual review items`,
      `  2. Run ${chalk.cyan('php artisan')} to verify the application boots`,
      `  3. Run ${chalk.cyan('php artisan test')} to verify your test suite`,
      `  4. Create a PR from ${chalk.cyan(s.branchName)}`,
    );

    if (s.backupTag) {
      lines.push('', `  ${chalk.bold('Rollback:')} shift rollback (restores to tag ${chalk.cyan(s.backupTag)})`);
    }

    console.log(boxen(lines.join('\n'), { padding: 1, borderColor: isComplete ? 'green' : 'yellow', borderStyle: 'round' }));
  }
}
