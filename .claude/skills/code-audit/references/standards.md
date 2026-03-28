# 2026 Node.js Best Practice Standards

This reference is shared across all agents. When writing or reviewing code, these
standards are the authoritative source of "how it should be done."

## Imports

Use native `node:` prefixed imports for all built-in modules:
```javascript
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve, normalize, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createHash } from 'node:crypto';
```

Never use the unprefixed form (`'fs'`, `'path'`). The `node:` prefix is the standard
since Node.js 16+ and is required for clarity in 2026 projects.

## Error Handling

### Typed Error Classes
Define typed errors per failure domain. Every error class must extend `Error` and
include a `code` property:

```javascript
class ApiError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = 'ERR_API';
    this.status = status;
    this.retryable = retryable;
  }
}

class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
    this.code = 'ERR_STATE';
  }
}

class GitError extends Error { /* ... */ }
class TransformError extends Error { /* ... */ }
class PathTraversalError extends Error { /* ... */ }
class ParseError extends Error { /* ... */ }
```

### Async Error Boundaries
Every async function must have explicit error handling. No bare `.catch(() => {})`.
No unhandled promise rejections.

```javascript
// ✅ Good: explicit error boundary with typed error
async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new StateError(`Failed to load state: ${err.message}`);
  }
}

// ❌ Bad: swallowed error
async function loadState(path) {
  return readFile(path, 'utf-8').catch(() => null);
}
```

### Guard Clauses
Methods that depend on initialised state must throw early:

```javascript
isPhaseComplete(phase) {
  if (!this._initialized) {
    throw new StateError('Cannot call isPhaseComplete() before init()');
  }
  // ...
}
```

## API Resilience

### Retryable Status Codes
Always retry on: 408 (timeout), 429 (rate limit), 529 (overloaded), and all 5xx.

### Exponential Backoff with Jitter
```javascript
const RETRYABLE_STATUSES = new Set([408, 429, 529]);

async function callWithRetry(fn, { maxRetries = 3, baseDelay = 1000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.error?.status;
      const retryable = status && (RETRYABLE_STATUSES.has(status) || status >= 500);

      if (!retryable || attempt === maxRetries) throw err;

      const delay = baseDelay * Math.pow(2, attempt)
                  + Math.random() * baseDelay * 0.1;
      await setTimeout(delay);
    }
  }
}
```

### Request Timeouts
Use `AbortSignal.timeout()` for all external calls:

```javascript
const response = await fetch(url, {
  signal: AbortSignal.timeout(30_000) // 30 second timeout
});
```

## File I/O

### Atomic Writes
Never write directly to the target file. Use write-to-temp-then-rename:

```javascript
async function atomicWrite(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, data, 'utf-8');
  await rename(tmpPath, filePath);
}
```

### Temp File Recovery
On load, check for orphaned `.tmp` files (evidence of interrupted save) and recover:

```javascript
async function safeLoad(filePath) {
  const tmpPath = `${filePath}.tmp`;

  // Check for interrupted save
  try {
    await access(tmpPath);
    // .tmp exists — recover it
    await rename(tmpPath, filePath);
  } catch {
    // No .tmp file — normal path
  }

  return readFile(filePath, 'utf-8');
}
```

## Cross-Platform Paths

### Always Use node:path
Never construct paths with string concatenation:

```javascript
// ✅ Good
const target = join(projectRoot, 'src', 'agents', filename);

// ❌ Bad
const target = projectRoot + '/src/agents/' + filename;
```

### Path Validation
Validate all paths from external sources (user input, LLM output, config files):

```javascript
function validateProjectPath(projectRoot, targetPath) {
  const resolved = resolve(projectRoot, normalize(targetPath));
  const rel = relative(projectRoot, resolved);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathTraversalError(
      `Path escapes project root: ${targetPath}`
    );
  }

  return resolved;
}
```

## Shell Command Safety

### Never Interpolate Into Shell Strings
```javascript
// ✅ Good: array-based arguments
import { execFile } from 'node:child_process';
execFile('git', ['status', '--porcelain'], { cwd: projectRoot });

// ❌ Bad: string interpolation
exec(`git status --porcelain ${projectRoot}`);
```

### Escape or Reject Glob Characters
If a value comes from user input or LLM output and will be used in a shell context,
reject glob characters:

```javascript
if (/[*?[\]{}]/.test(userInput)) {
  throw new Error('Input contains unsafe glob characters');
}
```

## JSON Parsing Safety

### Always Wrap JSON.parse
```javascript
function safeJsonParse(raw, context = 'unknown') {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ParseError(
      `Invalid JSON from ${context}: ${err.message}\nRaw (first 200 chars): ${raw.slice(0, 200)}`
    );
  }
}
```

## LLM Output Validation

All AI-generated content is UNTRUSTED. Validate before use:

1. **Parse**: Wrap in try/catch, handle truncated responses
2. **Schema check**: Verify expected fields exist and have correct types
3. **Path check**: Validate file paths (no traversal, within project)
4. **Size check**: Reject oversized outputs that could indicate runaway generation
5. **Content check**: Verify generated code doesn't contain dangerous patterns

## Process Hygiene

### Timer Cleanup
`unref()` timers that should not keep the process alive:

```javascript
const timer = setTimeout(callback, delay);
timer.unref(); // Process can exit even if timer is pending
```

### Event Listener Cleanup
Remove listeners on shutdown:

```javascript
const handler = () => { /* ... */ };
process.on('SIGINT', handler);
// On cleanup:
process.removeListener('SIGINT', handler);
```

## Logging

### Structured Logging
Use correlation IDs per operation for traceability:

```javascript
function log(level, message, { correlationId, ...meta } = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    correlationId,
    ...meta
  };
  // Write to appropriate output
}
```

### Timing Instrumentation
Instrument all external calls:

```javascript
const start = performance.now();
const result = await apiCall();
const duration = performance.now() - start;
log('info', 'API call complete', { duration, correlationId });
```

## Git Safety

### Pre-Operation Checks
Before any destructive git operation, verify clean state:

```javascript
const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd });
if (stdout.trim()) {
  throw new GitError('Working tree is dirty — commit or stash before proceeding');
}
```

### Version Validation
Verify git is available and meets minimum version at startup:

```javascript
const { stdout } = await execFile('git', ['--version']);
const version = stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
if (!version || semverLt(version, '2.30.0')) {
  throw new GitError(`Git >= 2.30.0 required, found: ${version || 'none'}`);
}
```
