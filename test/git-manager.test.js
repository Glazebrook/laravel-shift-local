/**
 * GitManager test coverage.
 * Tests git operations, argument validation, and Windows safety.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

function makeTempDir(prefix = 'shift-git-') {
  const dir = join(tmpdir(), prefix + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function makeLogger() {
  return {
    info: async () => {}, warn: async () => {}, error: async () => {},
    debug: async () => {}, success: async () => {}, tool: async () => {},
  };
}

function initGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore', shell: true });
}

describe('GitManager', () => {
  let tempDir, GitManager;

  beforeEach(async () => {
    tempDir = makeTempDir();
    initGitRepo(tempDir);
    ({ GitManager } = await import('../src/git-manager.js'));
  });

  afterEach(() => cleanDir(tempDir));

  it('isGitRepo returns true for a git repo', async () => {
    const git = new GitManager(tempDir, makeLogger());
    assert.equal(await git.isGitRepo(), true);
  });

  it('isGitRepo returns false for non-repo', async () => {
    const nonRepo = makeTempDir('shift-nongit-');
    const git = new GitManager(nonRepo, makeLogger());
    assert.equal(await git.isGitRepo(), false);
    cleanDir(nonRepo);
  });

  it('getCurrentBranch returns branch name', async () => {
    const git = new GitManager(tempDir, makeLogger());
    const branch = await git.getCurrentBranch();
    assert.ok(branch === 'master' || branch === 'main');
  });

  it('createOrCheckoutBranch creates a new branch', async () => {
    const git = new GitManager(tempDir, makeLogger());
    await git.createOrCheckoutBranch('test-branch');
    const current = await git.getCurrentBranch();
    assert.equal(current, 'test-branch');
  });

  it('createOrCheckoutBranch checks out existing branch', async () => {
    const git = new GitManager(tempDir, makeLogger());
    await git.createOrCheckoutBranch('test-branch');
    // Go back to main
    await git.run(['checkout', '-']);
    // Checkout existing branch
    await git.createOrCheckoutBranch('test-branch');
    const current = await git.getCurrentBranch();
    assert.equal(current, 'test-branch');
  });

  it('hasUncommittedChanges detects changes', async () => {
    const git = new GitManager(tempDir, makeLogger());
    assert.equal(await git.hasUncommittedChanges(), false);
    writeFileSync(join(tempDir, 'new.txt'), 'hello');
    assert.equal(await git.hasUncommittedChanges(), true);
  });

  it('commit creates a commit with prefix', async () => {
    const git = new GitManager(tempDir, makeLogger(), { commitPrefix: 'shift' });
    writeFileSync(join(tempDir, 'new.txt'), 'hello');
    await git.addAll();
    const result = await git.commit('test message');
    assert.ok(result.ok, `Commit failed: ${result.stderr}`);

    const log = await git.getLog(1);
    assert.ok(log.includes('shift test message'));
  });

  it('commit returns noop when nothing to commit', async () => {
    const git = new GitManager(tempDir, makeLogger());
    const result = await git.commit('empty');
    assert.ok(result.ok);
    assert.equal(result.noop, true);
  });

  it('phaseCommit combines addAll + commit', async () => {
    const git = new GitManager(tempDir, makeLogger(), { commitPrefix: 'shift' });
    writeFileSync(join(tempDir, 'file.txt'), 'content');
    const result = await git.phaseCommit('analysis', 'medium complexity');
    assert.ok(result.ok, `phaseCommit failed: ${result.stderr}`);
    const log = await git.getLog(1);
    assert.ok(log.includes('shift analysis: medium complexity'));
  });

  it('createBackupTag creates tag with timestamp', async () => {
    const git = new GitManager(tempDir, makeLogger());
    const tag = await git.createBackupTag('pre-shift');
    assert.ok(tag.startsWith('shift-backup-pre-shift-'));
    assert.ok(await git.tagExists(tag));
  });

  it('tagExists returns false for missing tag', async () => {
    const git = new GitManager(tempDir, makeLogger());
    assert.equal(await git.tagExists('nonexistent-tag'), false);
  });

  it('rollbackToTag returns error for missing tag', async () => {
    const git = new GitManager(tempDir, makeLogger());
    const result = await git.rollbackToTag('nonexistent-tag');
    assert.equal(result.ok, false);
    assert.ok(result.stderr.includes('not found'));
  });

  it('rollbackToTag resets to tag on current branch', async () => {
    const git = new GitManager(tempDir, makeLogger());
    const tag = await git.createBackupTag('test');

    // Make a commit after the tag
    writeFileSync(join(tempDir, 'after.txt'), 'after');
    await git.addAll();
    await git.commit('after tag');

    const result = await git.rollbackToTag(tag);
    assert.ok(result.ok);
    assert.ok(!existsSync(join(tempDir, 'after.txt')));
  });

  it('stashChanges stashes and stashPop restores', async () => {
    const git = new GitManager(tempDir, makeLogger());
    writeFileSync(join(tempDir, 'stash-test.txt'), 'content');

    const stashResult = await git.stashChanges();
    assert.ok(stashResult.stashed);
    assert.ok(!existsSync(join(tempDir, 'stash-test.txt')));

    const popResult = await git.stashPop();
    assert.ok(popResult.ok);
    assert.ok(existsSync(join(tempDir, 'stash-test.txt')));
  });

  it('stashChanges returns stashed=false when no changes', async () => {
    const git = new GitManager(tempDir, makeLogger());
    const result = await git.stashChanges();
    assert.equal(result.stashed, false);
  });

  it('diff returns diff stats', async () => {
    const git = new GitManager(tempDir, makeLogger());
    writeFileSync(join(tempDir, 'README.md'), '# modified');
    const result = await git.diff();
    assert.ok(result.ok);
    assert.ok(result.stdout.includes('README.md'));
  });
});

// ── Windows argument safety ─────────────────────────────────────

describe('GitManager Windows argument validation', () => {
  it('blocks unsafe characters in args on Windows', async () => {
    // Only testable on Windows, but we can verify the regex pattern
    // P1-004 FIX: Removed * (glob wildcard) — matches updated git-manager.js
    const SAFE_ARG_RE = /^[a-zA-Z0-9:_\-/.=^~@ ]+$/;
    assert.ok(SAFE_ARG_RE.test('checkout'));
    assert.ok(SAFE_ARG_RE.test('-b'));
    assert.ok(SAFE_ARG_RE.test('shift/upgrade-10-to-11'));
    assert.ok(!SAFE_ARG_RE.test('arg; rm -rf /'));
    assert.ok(!SAFE_ARG_RE.test('arg$(cmd)'));
    assert.ok(!SAFE_ARG_RE.test('arg`cmd`'));
    assert.ok(!SAFE_ARG_RE.test('arg>file'));
    assert.ok(!SAFE_ARG_RE.test('arg<file'));
    assert.ok(!SAFE_ARG_RE.test('arg|pipe'));
    assert.ok(!SAFE_ARG_RE.test('arg&bg'));
  });
});
