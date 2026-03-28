/**
 * FINDING-14 FIX: Common base error class for all shift errors.
 * CI/CD pipelines can catch ShiftBaseError to handle all shift-specific errors
 * with a single instanceof check.
 */
export class ShiftBaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ShiftBaseError';
  }
}

export class FileToolsError extends ShiftBaseError {
  constructor(message, { filePath, operation } = {}) {
    super('SHIFT_FILE', message);
    this.name = 'FileToolsError';
    this.filePath = filePath;
    this.operation = operation; // 'read', 'write', 'delete', 'list', 'exists', 'backup', 'restore'
  }
}

export class ParseError extends ShiftBaseError {
  constructor(message, { filePath, rawPreview } = {}) {
    super('SHIFT_PARSE', message);
    this.name = 'ParseError';
    this.filePath = filePath;
    this.rawPreview = rawPreview;
  }
}

export class PathTraversalError extends ShiftBaseError {
  constructor(message, { requestedPath, resolvedPath } = {}) {
    super('SHIFT_TRAVERSAL', message);
    this.name = 'PathTraversalError';
    this.requestedPath = requestedPath;
    this.resolvedPath = resolvedPath;
  }
}

export class StateError extends ShiftBaseError {
  constructor(message, { phase, method } = {}) {
    super('SHIFT_STATE', message);
    this.name = 'StateError';
    this.phase = phase;
    this.method = method;
  }
}

export class GitError extends ShiftBaseError {
  constructor(message, { command, exitCode, stderr } = {}) {
    super('SHIFT_GIT', message);
    this.name = 'GitError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class ShellError extends ShiftBaseError {
  constructor(message, { command, args, exitCode, stderr, timeout } = {}) {
    super('SHIFT_SHELL', message);
    this.name = 'ShellError';
    this.command = command;
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.timeout = timeout;
  }
}
