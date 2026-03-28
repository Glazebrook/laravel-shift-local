/**
 * StateManager - Persistent state machine for resumable upgrades
 * Stores progress in .shift/state.json inside the target project
 */

/**
 * MAINT-2 FIX: JSDoc type definitions for the state shape.
 * @typedef {Object} ShiftState
 * @property {string} version - State schema version
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {string} projectPath
 * @property {string} fromVersion - Source Laravel major version
 * @property {string} toVersion - Target Laravel major version
 * @property {string} currentPhase - Current phase (PHASES enum value)
 * @property {string[]} completedPhases
 * @property {string} branchName - Git branch name for the upgrade
 * @property {Object|null} analysis - Analyzer agent output
 * @property {Object|null} plan - Planner agent output
 * @property {TransformationState} transformations
 * @property {ValidationState} validation
 * @property {Object|null} report - Reporter agent output
 * @property {ErrorEntry[]} errors
 * @property {Object<string, number>} retries - Phase retry counts
 * @property {string|null} backupTag - Git backup tag name
 * @property {boolean} stashedChanges - Whether git stash was used
 * @property {Object<string, PhaseTimingEntry>} phaseTimings
 * @property {ChangesManifest} changesManifest
 *
 * @typedef {Object} TransformationState
 * @property {number} total
 * @property {number} completed
 * @property {number} failed
 * @property {number} skipped
 * @property {Object<string, FileStatus>} files
 *
 * @typedef {Object} FileStatus
 * @property {string} status - 'pending'|'in_progress'|'done'|'failed'|'skipped'
 * @property {number} attempts
 * @property {string} updatedAt
 *
 * @typedef {Object} ValidationState
 * @property {boolean} passed
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {boolean} testsRun
 * @property {Object|null} testResults
 *
 * @typedef {Object} ErrorEntry
 * @property {string} timestamp
 * @property {string} phase
 * @property {string} message
 * @property {string} [stack]
 * @property {boolean} fatal
 *
 * @typedef {Object} PhaseTimingEntry
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {number} durationMs
 *
 * @typedef {Object} ChangesManifest
 * @property {{from: string, to: string}[]} renames
 * @property {string[]} newFiles
 * @property {{filepath: string, imports: string[]}[]} newImports
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync, renameSync } from 'fs';
import { join } from 'path';

// FINDING-15 FIX: Named constants for magic numbers
const MANIFEST_CAP = 500;           // Max entries per manifest array
const MANIFEST_TRIM_TO = 250;       // Trim to this many on overflow
const ERROR_CAP = 200;              // Max errors before trimming
const ERROR_TRIM_TO = 100;          // Trim to this many on overflow
const DEBOUNCE_SAVE_MS = 100;       // Debounce interval for scheduled saves

export const PHASES = {
  INIT: 'INIT',
  ANALYZING: 'ANALYZING',
  PLANNING: 'PLANNING',
  DEPENDENCIES: 'DEPENDENCIES',
  TRANSFORMING: 'TRANSFORMING',
  VALIDATING: 'VALIDATING',
  REPORTING: 'REPORTING',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
};

export const PHASE_ORDER = [
  PHASES.INIT,
  PHASES.ANALYZING,
  PHASES.PLANNING,
  PHASES.DEPENDENCIES,
  PHASES.TRANSFORMING,
  PHASES.VALIDATING,
  PHASES.REPORTING,
  PHASES.COMPLETE,
];

// Known Laravel major versions for validation (#12)
// FIX #22: Use an ordered array with a runtime check to ensure numeric ordering.
// The indexOf-based comparison is correct ONLY if the array is sorted ascending.
export const KNOWN_VERSIONS = ['8', '9', '10', '11', '12', '13'];

// LOW-2 FIX: Only run the ordering check outside of production.
// This is a build-time invariant that doesn't need to run on every import.
if (process.env.NODE_ENV !== 'production') {
  for (let i = 1; i < KNOWN_VERSIONS.length; i++) {
    if (Number(KNOWN_VERSIONS[i]) <= Number(KNOWN_VERSIONS[i - 1])) {
      throw new Error(
        `KNOWN_VERSIONS is not in ascending numeric order at index ${i}: ` +
        `${KNOWN_VERSIONS[i - 1]} must be < ${KNOWN_VERSIONS[i]}. ` +
        `Fix the array in state-manager.js.`
      );
    }
  }
}

// M7 FIX: Track which versions are speculative (not yet released)
export const SPECULATIVE_VERSIONS = ['13'];

export class StateManager {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.stateDir = join(projectPath, '.shift');
    this.statePath = join(this.stateDir, 'state.json');
    this.state = null;
    // C6 FIX: Explicitly initialise _saveTimeout so it's not implicitly undefined.
    // This makes the "never scheduled" vs "cleared" distinction unambiguous.
    this._saveTimeout = null;
  }

  /**
   * Initialize or load existing state
   */
  init({ fromVersion, toVersion, projectPath, branchPrefix = 'shift/upgrade' }) {
    if (existsSync(this.statePath)) {
      this.load();
      return { resumed: true };
    }

    this.state = {
      version: '1.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectPath,
      fromVersion,
      toVersion,
      currentPhase: PHASES.INIT,
      completedPhases: [],
      // LOW-4 FIX: Strip non-numeric/dot characters from version strings before
      // building the branch name, so programmatic calls with e.g. '10.x' produce
      // a consistent branch name format (only digits and hyphens).
      branchName: `${branchPrefix}-${fromVersion.replace(/[^0-9]/g, '-')}-to-${toVersion.replace(/[^0-9]/g, '-')}`,
      analysis: null,
      plan: null,
      transformations: {
        total: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        files: {},
      },
      validation: {
        passed: false,
        errors: [],
        warnings: [],
        testsRun: false,
        testResults: null,
      },
      report: null,
      errors: [],
      retries: {},
      backupTag: null,
      stashedChanges: false,
      // M3 FIX: Phase timing metrics
      phaseTimings: {},
      // H11 FIX: Changes manifest for inter-file dependency tracking
      changesManifest: {
        renames: [],    // { from, to }
        newFiles: [],   // filepath[]
        newImports: [], // { filepath, imports[] }
      },
    };

    this.save();
    return { resumed: false };
  }

  load() {
    const tmpPath = this.statePath + '.tmp';
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = parsed;
      return parsed;
    } catch (err) {
      // P0-001/P0-002 FIX: If state.json is missing or corrupt but .tmp exists,
      // recover from the .tmp file. This handles the Windows race window where
      // unlinkSync(state.json) succeeded but renameSync(.tmp -> state.json) did not.
      if (existsSync(tmpPath)) {
        try {
          const tmpRaw = readFileSync(tmpPath, 'utf8');
          const tmpParsed = JSON.parse(tmpRaw);
          this.state = tmpParsed;
          // Promote .tmp to state.json so future loads don't need recovery
          try { renameSync(tmpPath, this.statePath); } catch { /* best effort */ }
          console.warn('WARNING: Recovered state from state.json.tmp (previous save was interrupted).');
          return tmpParsed;
        } catch {
          // .tmp is also corrupt — fall through to original error
        }
      }
      throw new Error(`Failed to load shift state: ${err.message}`);
    }
  }

  /**
   * FIX #3: save() retry now includes a synchronous delay before retrying.
   * FIX #9: Uses write-then-rename (atomic save) to prevent truncated state.json on crash.
   */
  save() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
    this.state.updatedAt = new Date().toISOString();
    const data = JSON.stringify(this.state, null, 2);
    const tmpPath = this.statePath + '.tmp';
    try {
      // FIX #9: Write to temp file, then atomically rename
      writeFileSync(tmpPath, data, 'utf8');
      // P0-001 FIX: Try rename first — on POSIX this atomically replaces the target.
      // On Windows, rename may fail with EPERM if target is locked; only then
      // fall back to unlink+rename, minimising the window where state.json is absent.
      try {
        renameSync(tmpPath, this.statePath);
      } catch (renameErr) {
        if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EACCES')) {
          unlinkSync(this.statePath);
          renameSync(tmpPath, this.statePath);
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      // FIX #3: Synchronous delay (~50ms) before retry for transient I/O conditions
      const start = Date.now();
      while (Date.now() - start < 50) { /* busy-wait */ }
      try {
        writeFileSync(tmpPath, data, 'utf8');
        try {
          renameSync(tmpPath, this.statePath);
        } catch (renameErr) {
          if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EACCES')) {
            unlinkSync(this.statePath);
            renameSync(tmpPath, this.statePath);
          } else {
            throw renameErr;
          }
        }
      } catch (retryErr) {
        // FIX #3: Log the actual retry error, not the outer one
        console.error(`CRITICAL: Failed to save state: ${retryErr.message}`);
        throw retryErr;
      }
    }
  }

  /**
   * REL-11 FIX: Debounced save for high-frequency callers (setFileStatus, etc).
   * Batches rapid successive saves into a single disk write.
   */
  // CRIT-3 FIX: Call .unref() on the debounce timer so it doesn't keep
  // the process alive if it fires during shutdown.
  _scheduleSave() {
    if (this._saveTimeout) return;
    this._saveTimeout = setTimeout(() => {
      this._saveTimeout = null;
      // AUDIT FIX: Catch save errors in debounce callback to prevent unhandled rejections
      try { this.save(); } catch (err) {
        console.error(`WARNING: Debounced state save failed: ${err.message}`);
      }
    }, DEBOUNCE_SAVE_MS);
    this._saveTimeout.unref();
  }

  // AUDIT FIX: Guard against use before init()/load()
  _requireState() {
    if (!this.state) {
      throw new Error('StateManager not initialised. Call init() or load() first.');
    }
  }

  get(key) {
    this._requireState();
    return key ? this.state[key] : this.state;
  }

  set(key, value) {
    this._requireState();
    this.state[key] = value;
    this.save();
  }

  setPhase(phase) {
    this._requireState();
    this.state.currentPhase = phase;
    this.save();
  }

  isPhaseComplete(phase) {
    this._requireState();
    return this.state.completedPhases.includes(phase);
  }

  markPhaseComplete(phase) {
    this._requireState();
    if (!this.state.completedPhases.includes(phase)) {
      this.state.completedPhases.push(phase);
    }
    this.save();
  }

  logError(phase, error, fatal = false) {
    const entry = {
      timestamp: new Date().toISOString(),
      phase,
      message: error.message || String(error),
      stack: error.stack,
      fatal,
    };
    this.state.errors.push(entry);
    // REL-1 FIX: Cap errors array to prevent unbounded growth
    if (this.state.errors.length > ERROR_CAP) {
      this.state.errors = this.state.errors.slice(-ERROR_TRIM_TO);
    }
    this.save();
    return entry;
  }

  incrementRetry(phase) {
    this.state.retries[phase] = (this.state.retries[phase] || 0) + 1;
    this.save();
    return this.state.retries[phase];
  }

  getRetryCount(phase) {
    return this.state.retries[phase] || 0;
  }

  // File-level transformation tracking
  /**
   * H5 FIX: Increment attempts on both 'in_progress' and 'failed' status
   * to prevent infinite retry loops when a caller sets 'failed' directly
   * without first setting 'in_progress'.
   */
  setFileStatus(filepath, status, meta = {}) {
    const prev = this.state.transformations.files[filepath];
    this.state.transformations.files[filepath] = {
      status,
      // M2 FIX: Only increment on in_progress (the start of an attempt).
      // Previously also incremented on 'failed', causing double-counting:
      // in_progress (+1) → failed (+1) = 2 for one real attempt.
      // Now: in_progress (+1) → failed (0) = 1 for one real attempt.
      attempts: (prev?.attempts || 0) + (status === 'in_progress' ? 1 : 0),
      updatedAt: new Date().toISOString(),
      ...meta,
    };
    const files = Object.values(this.state.transformations.files);
    this.state.transformations.completed = files.filter(f => f.status === 'done').length;
    this.state.transformations.failed = files.filter(f => f.status === 'failed').length;
    this.state.transformations.skipped = files.filter(f => f.status === 'skipped').length;
    // FIX #2: Use synchronous save for terminal states (done, failed, skipped)
    // to prevent data loss if the process crashes during the debounce window.
    // Keep debounced save only for in_progress (high-frequency, non-critical).
    if (['done', 'failed', 'skipped'].includes(status)) {
      if (this._saveTimeout) {
        clearTimeout(this._saveTimeout);
        this._saveTimeout = null;
      }
      this.save();
    } else {
      this._scheduleSave();
    }
  }

  getFileStatus(filepath) {
    return this.state.transformations.files[filepath]?.status || 'pending';
  }

  /**
   * H11 FIX: Record a file rename/move in the changes manifest
   * so subsequent transformer runs know about it.
   */
  recordRename(fromPath, toPath) {
    if (!this.state.changesManifest) {
      this.state.changesManifest = { renames: [], newFiles: [], newImports: [] };
    }
    this.state.changesManifest.renames.push({ from: fromPath, to: toPath });
    // REL-1 FIX: Cap manifest arrays to prevent unbounded growth
    // MED-6 FIX: Log when trimming occurs — earliest renames that subsequent transforms
    // depend on may be dropped, so the user should know.
    if (this.state.changesManifest.renames.length > MANIFEST_CAP) {
      console.warn(`WARNING: Changes manifest renames exceeded ${MANIFEST_CAP}, trimming oldest entries. Some inter-file context may be lost.`);
      this.state.changesManifest.renames = this.state.changesManifest.renames.slice(-MANIFEST_TRIM_TO);
    }
    // P2-001 FIX: Use debounced save — manifest writes happen in rapid succession during transforms
    this._scheduleSave();
  }

  /**
   * H11 FIX: Record a newly created file.
   */
  recordNewFile(filepath) {
    if (!this.state.changesManifest) {
      this.state.changesManifest = { renames: [], newFiles: [], newImports: [] };
    }
    this.state.changesManifest.newFiles.push(filepath);
    // REL-1 FIX: Cap manifest arrays to prevent unbounded growth
    // MED-6 FIX: Log when trimming occurs
    if (this.state.changesManifest.newFiles.length > MANIFEST_CAP) {
      console.warn(`WARNING: Changes manifest newFiles exceeded ${MANIFEST_CAP}, trimming oldest entries.`);
      this.state.changesManifest.newFiles = this.state.changesManifest.newFiles.slice(-MANIFEST_TRIM_TO);
    }
    // P2-001 FIX: Use debounced save — manifest writes happen in rapid succession
    this._scheduleSave();
  }

  /**
   * H11 FIX: Get the current changes manifest for inter-file context.
   */
  getChangesManifest() {
    return this.state.changesManifest || { renames: [], newFiles: [], newImports: [] };
  }

  /**
   * FINDING-8 FIX: Record a new import and cap the array like renames/newFiles.
   */
  recordNewImport(filepath, imports) {
    if (!this.state.changesManifest) {
      this.state.changesManifest = { renames: [], newFiles: [], newImports: [] };
    }
    this.state.changesManifest.newImports.push({ filepath, imports });
    // MED-6 FIX: Log when trimming occurs
    if (this.state.changesManifest.newImports.length > MANIFEST_CAP) {
      console.warn(`WARNING: Changes manifest newImports exceeded ${MANIFEST_CAP}, trimming oldest entries.`);
      this.state.changesManifest.newImports = this.state.changesManifest.newImports.slice(-MANIFEST_TRIM_TO);
    }
    // P2-001 FIX: Use debounced save — manifest writes happen in rapid succession
    this._scheduleSave();
  }

  /**
   * BUG-7 FIX: Validate state integrity after loading.
   * Checks that required fields exist and have correct types.
   */
  validateState() {
    const required = ['fromVersion', 'toVersion', 'currentPhase', 'completedPhases', 'transformations'];
    for (const key of required) {
      if (this.state[key] === undefined) {
        throw new Error(`Corrupted state: missing required field '${key}'. Run 'shift reset' and start again.`);
      }
    }
    if (!Array.isArray(this.state.completedPhases)) {
      throw new Error(`Corrupted state: 'completedPhases' is not an array. Run 'shift reset' and start again.`);
    }
    if (typeof this.state.transformations !== 'object' || this.state.transformations === null) {
      throw new Error(`Corrupted state: 'transformations' is not an object. Run 'shift reset' and start again.`);
    }
  }

  /**
   * REL-6 FIX: Reset retry counters without clearing all state.
   * Called on resume with --reset-retries flag.
   */
  resetRetries() {
    this.state.retries = {};
    // FIX #7: Reset status to 'pending' (not just attempts) for failed files
    // so they are semantically correct and won't be skipped by future status checks.
    for (const [, info] of Object.entries(this.state.transformations.files || {})) {
      if (info.status === 'failed') {
        info.attempts = 0;
        info.status = 'pending';
      }
    }
    // Recount after status changes
    const files = Object.values(this.state.transformations.files || {});
    this.state.transformations.completed = files.filter(f => f.status === 'done').length;
    this.state.transformations.failed = files.filter(f => f.status === 'failed').length;
    this.state.transformations.skipped = files.filter(f => f.status === 'skipped').length;
    this.save();
  }

  getNextPhase() {
    const idx = PHASE_ORDER.indexOf(this.state.currentPhase);
    return PHASE_ORDER[idx + 1] || PHASES.COMPLETE;
  }

  getSummary() {
    const { fromVersion, toVersion, currentPhase, completedPhases, transformations, errors, phaseTimings } = this.state;
    // M3 FIX: Include timing in summary
    const totalMs = Object.values(phaseTimings || {}).reduce((sum, t) => sum + (t.durationMs || 0), 0);
    return {
      from: fromVersion,
      to: toVersion,
      phase: currentPhase,
      completed: completedPhases,
      files: `${transformations.completed}/${transformations.total} transformed`,
      errors: errors.length,
      totalDurationMs: totalMs,
    };
  }

  exists() {
    return existsSync(this.statePath);
  }

  /**
   * FINDING-10 FIX: Clean up pending _saveTimeout to prevent delayed process exit.
   * Performs a final synchronous save before clearing the timeout.
   */
  destroy() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    // Final save to persist any pending state
    if (this.state) {
      try { this.save(); } catch (err) {
        // M8 FIX: Log the error to stderr rather than silently swallowing.
        // If this is called during shutdown after _shuttingDown is set,
        // the user needs to know their final state may not be persisted.
        console.error(`WARNING: Failed to save final state during destroy: ${err.message}`);
      }
    }
  }

  /**
   * Delete the state and clean up the entire .shift/ directory.
   * C6 FIX: Warn if stashed changes exist before deleting state.
   */
  delete() {
    // C6 FIX: Check for stashed changes before deleting
    if (this.state?.stashedChanges) {
      console.warn('WARNING: You have stashed changes from before the upgrade.');
      console.warn('Run "git stash pop" to recover them before or after resetting.');
    }
    if (existsSync(this.stateDir)) {
      rmSync(this.stateDir, { recursive: true, force: true });
    }
  }
}
