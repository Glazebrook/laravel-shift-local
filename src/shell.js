/**
 * Centralised shell execution with argument validation, timeout enforcement,
 * platform-specific handling, and structured error reporting.
 *
 * All subprocess calls in the codebase should go through this module.
 */

import { execa } from 'execa';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

// Safe argument pattern — rejects shell metacharacters by default.
// Allows alphanumerics plus common safe chars: : _ - / . = ^ ~ @ space
const SAFE_ARG_RE = /^[a-zA-Z0-9:_\-/.=^~@ ]+$/;

// Minimal environment for subprocesses — never leak secrets (e.g. API keys).
const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
];

/**
 * Build a minimal environment from process.env, only including safe keys.
 * @param {string[]} extraKeys - Additional env keys to include.
 * @param {object} overrides - Key/value pairs to set (override process.env values).
 * @returns {object}
 */
function buildMinimalEnv(extraKeys = [], overrides = {}) {
  const allowlist = [...BASE_ENV_KEYS, ...extraKeys];
  const env = Object.fromEntries(
    allowlist.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])
  );
  return { ...env, ...overrides };
}

/**
 * Detect if a command needs shell mode on the current platform.
 * On Windows, .bat/.cmd wrappers (git, composer, etc.) require shell: true.
 */
function _shouldAutoShell(command) {
  if (platform() !== 'win32') return false;
  // Note: 'node' is a real .exe and does NOT need shell mode.
  const needsShell = ['git', 'composer', 'php', 'npm', 'npx'];
  return needsShell.includes(command.toLowerCase());
}

/**
 * Execute a command with unified validation, timeout, and platform handling.
 *
 * @param {string} command - The executable to run.
 * @param {string[]} args - Array of arguments (never a raw string).
 * @param {object} [options]
 * @param {string} [options.cwd] - Working directory.
 * @param {number} [options.timeout=30000] - Timeout in ms.
 * @param {boolean} [options.shell=false] - Allow shell interpretation.
 * @param {string} [options.shellReason] - REQUIRED if shell=true, explains why.
 * @param {object} [options.env] - Extra environment variables (merged with minimal base).
 * @param {string[]} [options.envKeys] - Additional process.env keys to include.
 * @param {boolean} [options.allowUnsafeArgs=false] - Skip arg validation.
 * @param {boolean} [options.throwOnError=false] - Throw instead of returning {ok: false}.
 * @param {boolean} [options.useProcessEnv=false] - Use full process.env instead of minimal set.
 * @param {object} [options.logger] - Logger instance for debug output.
 * @param {boolean} [options.redactArgs=false] - Redact args from log output.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
export async function execCommand(command, args = [], options = {}) {
  const {
    cwd,
    timeout = 30_000,
    shell = false,
    shellReason,
    env: envOverrides,
    envKeys = [],
    allowUnsafeArgs = false,
    throwOnError = false,
    useProcessEnv = false,
    logger,
    redactArgs = false,
  } = options;

  // Determine if shell mode is needed (explicit or auto-detected for Windows)
  const autoShell = _shouldAutoShell(command);
  const useShell = shell || autoShell;

  // shell: true (explicit) requires a documented reason for audit trail
  if (shell && !shellReason) {
    const msg = `shell: true requires a shellReason for audit trail. Command: ${command}`;
    if (throwOnError) throw new Error(msg);
    return { ok: false, stdout: '', stderr: msg, exitCode: -1 };
  }

  // Argument validation (unless explicitly opted out)
  if (!allowUnsafeArgs && args.length > 0) {
    for (const arg of args) {
      if (!SAFE_ARG_RE.test(arg)) {
        const msg = `Blocked unsafe argument for '${command}': ${arg}`;
        if (throwOnError) throw new Error(msg);
        return { ok: false, stdout: '', stderr: msg, exitCode: -1 };
      }
    }
  }

  // Build environment
  const env = useProcessEnv
    ? { ...process.env, ...envOverrides }
    : buildMinimalEnv(envKeys, envOverrides);

  // On Windows with shell mode, quote args with spaces to prevent splitting
  const finalArgs = useShell
    ? args.map(a => (a.includes(' ') && !(/^["'].*["']$/.test(a)) ? `"${a}"` : a))
    : args;

  const execOpts = {
    cwd,
    timeout,
    env,
    extendEnv: useProcessEnv, // When false, env replaces process.env entirely
    shell: useShell,
  };

  // Debug logging
  if (logger) {
    const displayArgs = redactArgs ? '[REDACTED]' : args.join(' ');
    const reason = shell ? ` shellReason=${shellReason}` : autoShell ? ' shellReason=win32-auto' : '';
    await logger.debug('Shell', `exec: ${command} ${displayArgs} (timeout=${timeout}ms, shell=${useShell}${reason})`);
  }

  const startTime = Date.now();
  try {
    const result = await execa(command, finalArgs, execOpts);
    if (logger) {
      await logger.debug('Shell', `${command} completed in ${Date.now() - startTime}ms (exit=0)`);
    }
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err) {
    const exitCode = err.exitCode ?? -1;
    const stderr = err.stderr || err.message;
    const stdout = err.stdout || '';
    if (logger) {
      await logger.debug('Shell', `${command} failed in ${Date.now() - startTime}ms (exit=${exitCode})`);
    }
    if (throwOnError) throw err;
    return { ok: false, stdout, stderr, exitCode, error: err };
  }
}

/**
 * Synchronous command execution for pre-flight checks (binary detection, disk space).
 *
 * @param {string} command - The executable to run.
 * @param {string[]} args - Array of arguments.
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - Timeout in ms.
 * @param {string} [options.encoding='utf8'] - Output encoding.
 * @param {string} [options.stdio] - Stdio option (e.g., 'ignore').
 * @returns {{ok: boolean, stdout: string, stderr: string, exitCode: number}}
 */
export function execCommandSync(command, args = [], options = {}) {
  const { timeout = 10_000, encoding = 'utf8', stdio } = options;

  const execOpts = { timeout, encoding };
  if (stdio) execOpts.stdio = stdio;

  try {
    const result = execFileSync(command, args, execOpts);
    return { ok: true, stdout: result || '', stderr: '', exitCode: 0 };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err.stderr || err.message, exitCode: err.status ?? -1 };
  }
}

/**
 * Build a minimal, safe environment for subprocess calls.
 * Never leaks secrets (API keys, tokens, etc.) from process.env.
 *
 * Always includes the core OS keys (PATH, HOME, USERPROFILE, TEMP/TMP, etc.).
 * Pass `additionalKeys` for command-specific variables (e.g. SSH_AUTH_SOCK for
 * git, PHP_INI_SCAN_DIR for PHP, COMPOSER_HOME for Composer).
 *
 * @param {string[]} additionalKeys - Extra process.env keys to include beyond the base set.
 * @returns {object} Minimal environment object safe for subprocess execution.
 */
export function createSafeEnv(additionalKeys = []) {
  return buildMinimalEnv(additionalKeys);
}

export { SAFE_ARG_RE, BASE_ENV_KEYS, buildMinimalEnv };
