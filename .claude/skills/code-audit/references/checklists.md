# Audit Checklists

These checklists ensure every file is reviewed against the same criteria on every
audit run, eliminating the randomness of "what the AI happens to notice."

Agents 2 (Audit) and 3 (Security) apply these checklists to every source file in
the coverage manifest.

---

## General Audit Checklist (Agent 2)

Apply every item to every source file. Mark as ✅ pass, ❌ fail (= finding), or N/A.

### 1. Null & Undefined Safety
- [ ] No unguarded property access on potentially null/undefined values
- [ ] Optional chaining (`?.`) used where appropriate
- [ ] Nullish coalescing (`??`) preferred over `||` for default values
- [ ] Function parameters validated at entry points (not just relied on upstream)
- [ ] Array/object destructuring has defaults where the source could be undefined

### 2. Promise & Async Error Handling
- [ ] Every `async` function has try/catch or the caller handles rejection
- [ ] No `.catch(() => {})` swallowing errors silently
- [ ] No unhandled promise rejections (fire-and-forget async calls)
- [ ] `await` used consistently (no mixing `.then()` chains in async functions)
- [ ] Error context preserved when re-throwing (original error in cause or message)

### 3. Input Validation
- [ ] Function parameters validated at module boundaries
- [ ] External input (CLI args, env vars, config files) validated on entry
- [ ] Type checks for critical parameters (typeof, instanceof, Array.isArray)
- [ ] Empty string, empty array, and zero treated correctly (not falsy-equated to missing)

### 4. Path Construction
- [ ] All paths built with `node:path` functions (join, resolve, normalize)
- [ ] No string concatenation for paths
- [ ] Paths from external sources (user, LLM, config) validated against project root
- [ ] No hardcoded path separators (`/` or `\`)
- [ ] Relative paths resolved before use

### 5. Shell Command Safety
- [ ] No string interpolation in exec/spawn command strings
- [ ] Array-based arguments used for spawn/execFile
- [ ] Glob characters rejected or escaped in user/LLM-provided arguments
- [ ] Shell metacharacters (`;`, `|`, `&&`, `` ` ``) not passable in arguments

### 6. JSON Parsing Safety
- [ ] Every `JSON.parse()` wrapped in try/catch
- [ ] Error messages include context (what was being parsed, first N chars of raw input)
- [ ] LLM-generated JSON validated for expected schema after parsing
- [ ] Truncated/partial JSON handled gracefully (not just thrown as parse error)

### 7. File I/O Atomicity
- [ ] Write operations use atomic pattern (write temp → rename)
- [ ] Read operations check for orphaned temp files and recover
- [ ] File permissions appropriate (not world-readable for sensitive data)
- [ ] File handles cleaned up (streams closed, descriptors released)
- [ ] Large files streamed rather than fully loaded into memory

### 8. State Read/Write Safety
- [ ] State objects validated after loading (schema check, not just JSON.parse)
- [ ] State mutations are atomic (no partial updates on error)
- [ ] Concurrent access handled (locks, version checks, or documented as single-instance)
- [ ] Interrupted operations don't leave state in an inconsistent state
- [ ] State schema version tracked for future migration support

### 9. API Call Resilience
- [ ] All retryable status codes covered (408, 429, 529, 5xx)
- [ ] Exponential backoff with jitter implemented
- [ ] Maximum retry count enforced
- [ ] Request timeout set (AbortSignal.timeout or equivalent)
- [ ] Response structure validated before accessing fields
- [ ] Rate limit headers read and respected (if available)

### 10. Resource Cleanup
- [ ] setTimeout/setInterval handles `.unref()`'d when they shouldn't block exit
- [ ] Event listeners removed on shutdown (process.on handlers)
- [ ] Temporary files cleaned up after use
- [ ] Child processes cleaned up on parent exit
- [ ] No memory leaks from growing arrays/maps that are never pruned

### 11. Error Class Specificity
- [ ] Typed error classes used (not generic `new Error()` for everything)
- [ ] Error names and codes are consistent per domain
- [ ] Errors include actionable context (file path, operation, input that caused it)
- [ ] Stack traces preserved when wrapping errors

### 12. Logging Adequacy
- [ ] Errors logged with sufficient context to diagnose without reproducing
- [ ] External operations (API calls, git, filesystem) have timing logs
- [ ] No sensitive data in logs (API keys, file contents, personal data)
- [ ] Log levels used appropriately (debug/info/warn/error)

### 13. Hardcoded Values
- [ ] Magic numbers have named constants
- [ ] Configuration values are overridable (env var, CLI flag, or config file)
- [ ] Timeout durations are configurable
- [ ] Retry counts are configurable
- [ ] File paths are not hardcoded to a specific user or system

### 14. Dead Code & Dependencies
- [ ] No unused imports
- [ ] No unreachable code branches
- [ ] No commented-out code blocks (remove or convert to TODO)
- [ ] No unused function parameters
- [ ] No unused npm dependencies in package.json

---

## Security Checklist (Agent 3)

Apply every item to every source file. This is in addition to (not instead of)
the general audit checklist.

### 1. Injection Prevention
- [ ] No shell injection (string interpolation in exec/spawn)
- [ ] No SQL injection (if any database code)
- [ ] No code injection (eval, Function, vm.runInNewContext on untrusted input)
- [ ] No template injection (untrusted input in template literals used as code)

### 2. Path Traversal Prevention
- [ ] All external paths validated against project root boundary
- [ ] `..` sequences rejected or normalised before use
- [ ] Symlinks resolved before security-critical operations
- [ ] Absolute paths from untrusted sources rejected

### 3. Credential Safety
- [ ] No API keys, tokens, or passwords hardcoded in source
- [ ] Credentials not logged (even at debug level)
- [ ] Credentials not included in error messages
- [ ] Credentials not written to state files
- [ ] Environment variables used for all secrets

### 4. Unsafe Operations
- [ ] No `eval()` on any input
- [ ] No `Function()` constructor on untrusted input
- [ ] No `require()` or dynamic `import()` with user-controlled module names
- [ ] No `child_process.exec()` with string commands (use execFile with arrays)

### 5. Prototype Pollution
- [ ] No `Object.assign({}, untrustedObject)` without sanitisation
- [ ] No spreading untrusted objects into critical config (`{...userInput}`)
- [ ] `__proto__`, `constructor`, `prototype` keys rejected from parsed input

### 6. Regex Safety
- [ ] No unbounded quantifiers on user/LLM-controlled input (ReDoS)
- [ ] Complex regex tested with adversarial input

### 7. TOCTOU Races
- [ ] No check-then-act patterns on filesystem without locking
- [ ] File existence checks followed by operations use O_EXCL or equivalent
- [ ] State checks and mutations are atomic

### 8. Information Leakage
- [ ] Error messages don't expose internal file paths to end users
- [ ] Stack traces not shown in production output
- [ ] State file contents don't include system-specific information unnecessarily

### 9. Dependency Security
- [ ] `npm audit` shows no critical or high vulnerabilities
- [ ] Dependencies are pinned to specific versions (not loose ranges)
- [ ] No abandoned or unmaintained dependencies
- [ ] Lockfile (`package-lock.json`) is committed and up to date

### 10. LLM Output Trust
- [ ] All LLM-generated file paths validated (traversal, existence, within project)
- [ ] All LLM-generated JSON schema-validated after parsing
- [ ] LLM-generated code never executed directly (eval/exec)
- [ ] Size limits enforced on LLM responses
- [ ] Malformed or unexpected LLM output logged and skipped (not crashed on)
