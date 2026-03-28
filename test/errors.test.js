/**
 * Tests for src/errors.js — typed error class hierarchy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ShiftBaseError,
  FileToolsError,
  ParseError,
  PathTraversalError,
  StateError,
  GitError,
  ShellError,
} from '../src/errors.js';

// ── ShiftBaseError ──

describe('ShiftBaseError', () => {
  it('sets code and message', () => {
    const err = new ShiftBaseError('TEST_CODE', 'test message');
    assert.equal(err.code, 'TEST_CODE');
    assert.equal(err.message, 'test message');
    assert.equal(err.name, 'ShiftBaseError');
  });

  it('is an instance of Error', () => {
    const err = new ShiftBaseError('X', 'y');
    assert.ok(err instanceof Error);
  });
});

// ── FileToolsError ──

describe('FileToolsError', () => {
  it('sets name, code, and custom properties', () => {
    const err = new FileToolsError('File not found: foo.txt', { filePath: 'foo.txt', operation: 'read' });
    assert.equal(err.name, 'FileToolsError');
    assert.equal(err.code, 'SHIFT_FILE');
    assert.equal(err.filePath, 'foo.txt');
    assert.equal(err.operation, 'read');
    assert.ok(err.message.includes('foo.txt'));
  });

  it('is instanceof ShiftBaseError and Error', () => {
    const err = new FileToolsError('test');
    assert.ok(err instanceof ShiftBaseError);
    assert.ok(err instanceof Error);
  });
});

// ── ParseError ──

describe('ParseError', () => {
  it('sets name, code, and custom properties', () => {
    const err = new ParseError('Invalid JSON in composer.json', { filePath: 'composer.json', rawPreview: '{bad' });
    assert.equal(err.name, 'ParseError');
    assert.equal(err.code, 'SHIFT_PARSE');
    assert.equal(err.filePath, 'composer.json');
    assert.equal(err.rawPreview, '{bad');
  });

  it('is instanceof ShiftBaseError', () => {
    assert.ok(new ParseError('test') instanceof ShiftBaseError);
  });
});

// ── PathTraversalError ──

describe('PathTraversalError', () => {
  it('sets name, code, and custom properties', () => {
    const err = new PathTraversalError('Path traversal blocked', { requestedPath: '../etc/passwd', resolvedPath: '/etc/passwd' });
    assert.equal(err.name, 'PathTraversalError');
    assert.equal(err.code, 'SHIFT_TRAVERSAL');
    assert.equal(err.requestedPath, '../etc/passwd');
    assert.equal(err.resolvedPath, '/etc/passwd');
  });

  it('is instanceof ShiftBaseError', () => {
    assert.ok(new PathTraversalError('test') instanceof ShiftBaseError);
  });
});

// ── StateError ──

describe('StateError', () => {
  it('sets name, code, and custom properties', () => {
    const err = new StateError('Not initialised', { phase: 'ANALYZING', method: 'load' });
    assert.equal(err.name, 'StateError');
    assert.equal(err.code, 'SHIFT_STATE');
    assert.equal(err.phase, 'ANALYZING');
    assert.equal(err.method, 'load');
  });

  it('is instanceof ShiftBaseError', () => {
    assert.ok(new StateError('test') instanceof ShiftBaseError);
  });
});

// ── GitError ──

describe('GitError', () => {
  it('sets name, code, and custom properties', () => {
    const err = new GitError('git checkout failed', { command: 'checkout', exitCode: 128, stderr: 'error: pathspec' });
    assert.equal(err.name, 'GitError');
    assert.equal(err.code, 'SHIFT_GIT');
    assert.equal(err.command, 'checkout');
    assert.equal(err.exitCode, 128);
    assert.equal(err.stderr, 'error: pathspec');
  });

  it('is instanceof ShiftBaseError', () => {
    assert.ok(new GitError('test') instanceof ShiftBaseError);
  });
});

// ── ShellError ──

describe('ShellError', () => {
  it('sets name, code, and custom properties', () => {
    const err = new ShellError('command timed out', { command: 'composer', args: ['update'], exitCode: -1, stderr: '', timeout: 30000 });
    assert.equal(err.name, 'ShellError');
    assert.equal(err.code, 'SHIFT_SHELL');
    assert.equal(err.command, 'composer');
    assert.deepEqual(err.args, ['update']);
    assert.equal(err.timeout, 30000);
  });

  it('is instanceof ShiftBaseError', () => {
    assert.ok(new ShellError('test') instanceof ShiftBaseError);
  });
});

// ── Cross-class instanceof checks ──

describe('Error hierarchy instanceof', () => {
  it('all subclasses are instanceof ShiftBaseError', () => {
    const classes = [FileToolsError, ParseError, PathTraversalError, StateError, GitError, ShellError];
    for (const Cls of classes) {
      const err = new Cls('test');
      assert.ok(err instanceof ShiftBaseError, `${Cls.name} should be instanceof ShiftBaseError`);
      assert.ok(err instanceof Error, `${Cls.name} should be instanceof Error`);
    }
  });

  it('each class has unique .code', () => {
    const codes = new Set();
    const classes = [FileToolsError, ParseError, PathTraversalError, StateError, GitError, ShellError];
    for (const Cls of classes) {
      const err = new Cls('test');
      assert.ok(!codes.has(err.code), `Duplicate code: ${err.code}`);
      codes.add(err.code);
    }
  });

  it('each class has a distinct .name', () => {
    const names = new Set();
    const classes = [FileToolsError, ParseError, PathTraversalError, StateError, GitError, ShellError];
    for (const Cls of classes) {
      const err = new Cls('test');
      assert.ok(!names.has(err.name), `Duplicate name: ${err.name}`);
      names.add(err.name);
    }
  });
});
