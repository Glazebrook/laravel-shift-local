/**
 * GitManager - Safe git operations for the upgrade workflow
 */

import { execa } from 'execa';

// H3 FIX: Default timeouts for git operations
const DEFAULT_TIMEOUT = 60_000;      // 60s for normal operations
const LONG_TIMEOUT = 300_000;        // 5min for stash/push/fetch

export class GitManager {
  constructor(projectPath, logger, config = {}) {
    this.cwd = projectPath;
    this.logger = logger;
    this.commitPrefix = config.commitPrefix || '[shift]';
  }

  /**
   * H3 FIX: All git operations now have a timeout.
   * H9 FIX: On Windows, uses shell: true for commands that may be .bat/.cmd wrappers.
   */
  async run(args, opts = {}) {
    // HIGH-2 FIX: Validate git arguments when shell: true will be used on Windows.
    // Git args come from internal code (not LLM), but defence-in-depth applies.
    if (process.platform === 'win32') {
      // P1-004 FIX: Removed * (glob wildcard) from allowed characters
      const SAFE_ARG_RE = /^[a-zA-Z0-9:_\-/.=^~@ ]+$/;
      for (const arg of args) {
        if (!SAFE_ARG_RE.test(arg)) {
          return { ok: false, stdout: '', stderr: `Blocked unsafe git argument: ${arg}` };
        }
      }
    }
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const execOpts = {
      cwd: this.cwd,
      timeout,
      ...opts,
    };
    // H9 FIX: On Windows, enable shell mode for git to handle .bat/.cmd wrappers
    if (process.platform === 'win32' && !execOpts.shell) {
      execOpts.shell = true;
    }
    // H9 BUGFIX: When shell: true, execa passes args through the shell which
    // splits on spaces. Quote any arg that contains spaces but isn't already quoted.
    const finalArgs = execOpts.shell
      ? args.map(a => (a.includes(' ') && !(/^["'].*["']$/.test(a)) ? `"${a}"` : a))
      : args;
    try {
      const result = await execa('git', finalArgs, execOpts);
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      return { ok: false, stdout: '', stderr: err.stderr || err.message, error: err };
    }
  }

  async isGitRepo() {
    const r = await this.run(['rev-parse', '--git-dir']);
    return r.ok;
  }

  async hasUncommittedChanges() {
    const r = await this.run(['status', '--porcelain']);
    return r.ok && r.stdout.trim().length > 0;
  }

  async getCurrentBranch() {
    const r = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok ? r.stdout.trim() : null;
  }

  async branchExists(name) {
    const r = await this.run(['rev-parse', '--verify', `refs/heads/${name}`]);
    return r.ok;
  }

  async createOrCheckoutBranch(name) {
    if (await this.branchExists(name)) {
      await this.logger.info('Git', `Checking out existing branch: ${name}`);
      return this.run(['checkout', name]);
    }
    await this.logger.info('Git', `Creating branch: ${name}`);
    return this.run(['checkout', '-b', name]);
  }

  /**
   * H8 FIX: Include untracked files in stash so new files the user
   * just created don't get left behind and conflict with the upgrade.
   */
  async stashChanges(message = 'shift-pre-upgrade-stash') {
    const hasChanges = await this.hasUncommittedChanges();
    if (!hasChanges) return { ok: true, stashed: false };
    await this.logger.warn('Git', 'Stashing uncommitted changes (including untracked files) before upgrade');
    // H8 FIX: --include-untracked captures new files too
    // H3 FIX: Use longer timeout for stash operations
    const r = await this.run(['stash', 'push', '--include-untracked', '-m', message], { timeout: LONG_TIMEOUT });
    return { ...r, stashed: r.ok };
  }

  /**
   * H3 FIX: stashPop uses longer timeout as it may involve file I/O.
   */
  async stashPop() {
    await this.logger.info('Git', 'Restoring stashed changes');
    return this.run(['stash', 'pop'], { timeout: LONG_TIMEOUT });
  }

  async addAll() {
    return this.run(['add', '-A']);
  }

  async commit(message) {
    const status = await this.run(['status', '--porcelain']);
    if (!status.stdout.trim()) {
      await this.logger.debug('Git', 'Nothing to commit');
      return { ok: true, noop: true };
    }
    const r = await this.run(['commit', '-m', `${this.commitPrefix} ${message}`]);
    if (r.ok) await this.logger.success('Git', `Committed: ${message}`);
    return r;
  }

  async phaseCommit(phase, details = '') {
    await this.addAll();
    return this.commit(`${phase}${details ? ': ' + details : ''}`);
  }

  async getLog(n = 10) {
    const r = await this.run(['log', `--oneline`, `-${n}`]);
    return r.ok ? r.stdout : '';
  }

  async createBackupTag(label) {
    const tag = `shift-backup-${label}-${Date.now()}`;
    await this.run(['tag', tag]);
    await this.logger.info('Git', `Created backup tag: ${tag}`);
    return tag;
  }

  /**
   * M12 FIX: Verify tag exists before attempting rollback.
   * Returns a clear error message instead of a generic git failure.
   */
  async tagExists(tag) {
    const r = await this.run(['rev-parse', '--verify', `refs/tags/${tag}`]);
    return r.ok;
  }

  async rollbackToTag(tag, branchName = null) {
    // M12 FIX: Verify tag exists first
    if (!await this.tagExists(tag)) {
      return {
        ok: false,
        stdout: '',
        stderr: `Backup tag '${tag}' not found. It may have been manually deleted. ` +
          `Run "git tag" to see available tags, or "git log --oneline --all" to find your pre-upgrade commit.`,
      };
    }

    await this.logger.warn('Git', `Rolling back to tag: ${tag}`);
    if (branchName) {
      const checkout = await this.run(['checkout', branchName]);
      if (!checkout.ok) {
        const createBranch = await this.run(['checkout', '-b', branchName, tag]);
        return createBranch;
      }
      return this.run(['reset', '--hard', tag]);
    }
    const currentBranch = await this.getCurrentBranch();
    if (currentBranch && currentBranch !== 'HEAD') {
      return this.run(['reset', '--hard', tag]);
    }
    // FINDING-19 FIX: When in detached HEAD state with no branchName,
    // create a named recovery branch from the tag instead of leaving
    // the user in detached HEAD (which is confusing and easy to lose work from).
    const recoveryBranch = `shift-rollback-${Date.now()}`;
    await this.logger.warn('Git', `Detached HEAD detected — creating recovery branch: ${recoveryBranch}`);
    return this.run(['checkout', '-b', recoveryBranch, tag]);
  }

  async diff(cached = false) {
    const args = ['diff', '--stat'];
    if (cached) args.push('--cached');
    const r = await this.run(args);
    // FINDING-13 FIX: Return result object so callers can distinguish
    // "no changes" (ok=true, stdout='') from "git diff failed" (ok=false)
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
  }
}
