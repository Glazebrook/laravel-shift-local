/**
 * Style Formatter — Post-processing code style formatting
 *
 * Runs Laravel Pint or PHP CS Fixer after all transforms to normalise
 * formatting, reducing noise in the final git diff.
 */

import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execCommand } from './shell.js';

const FALLBACK_STYLE_DIR = resolve(import.meta.dirname, '..', 'data', 'shift-laravel-style');

/**
 * Run code style formatting on the project after all transforms.
 *
 * @param {string} projectRoot - Path to the Laravel project
 * @param {object} [options] - { dryRun: false, verbose: false, logger: null }
 * @param {object} [config] - .shiftrc codeStyle config
 * @returns {{ formatted: boolean, filesChanged: number, formatter: string, fallbackUsed: boolean }}
 */
export async function runStyleFormatting(projectRoot, options = {}, config = {}) {
  const { dryRun = false, verbose = false, logger = null } = options;
  const {
    enabled = true,
    formatter: preferredFormatter = 'auto',
    dirtyOnly = true,
  } = config;

  if (!enabled || preferredFormatter === 'none') {
    if (logger) await logger.info('StyleFormatter', 'Code style formatting disabled');
    return { formatted: false, filesChanged: 0, formatter: 'none', fallbackUsed: false };
  }

  // Detect available formatter
  const detected = detectFormatter(projectRoot, preferredFormatter);

  if (!detected) {
    if (logger) await logger.info('StyleFormatter', 'No formatter installed — skipping code style formatting');
    return { formatted: false, filesChanged: 0, formatter: 'not-found', fallbackUsed: false };
  }

  if (logger) await logger.info('StyleFormatter', `Using formatter: ${detected.name}`);

  if (dryRun) {
    return { formatted: false, filesChanged: 0, formatter: detected.name, fallbackUsed: detected.fallback };
  }

  // If using PHP CS Fixer with no config and we have a fallback, copy it in temporarily
  let cleanupFallback = false;
  if (detected.fallback && detected.name === 'php-cs-fixer') {
    const fallbackConfig = join(FALLBACK_STYLE_DIR, '.php-cs-fixer.dist.php');
    if (existsSync(fallbackConfig)) {
      const targetConfig = join(projectRoot, '.php-cs-fixer.dist.php');
      copyFileSync(fallbackConfig, targetConfig);
      cleanupFallback = true;
      if (logger) await logger.info('StyleFormatter', 'Applied Shift\'s Laravel coding style as fallback');
    }
  }

  try {
    const result = await runFormatter(detected, projectRoot, { dirtyOnly, verbose, logger });

    return {
      formatted: result.filesChanged > 0,
      filesChanged: result.filesChanged,
      formatter: detected.name,
      fallbackUsed: detected.fallback,
    };
  } finally {
    // Clean up fallback config if we added it
    if (cleanupFallback) {
      const targetConfig = join(projectRoot, '.php-cs-fixer.dist.php');
      try { unlinkSync(targetConfig); } catch { /* best effort */ }
    }
  }
}

/**
 * Detect which formatter is available.
 * Priority: pint.json > .php-cs-fixer config > pint binary > php-cs-fixer binary
 */
function detectFormatter(projectRoot, preferred) {
  // If user specified a formatter, try that one
  if (preferred === 'pint') {
    return detectPint(projectRoot);
  }
  if (preferred === 'php-cs-fixer') {
    return detectPhpCsFixer(projectRoot);
  }

  // Auto-detect
  // 1. pint.json exists
  if (existsSync(join(projectRoot, 'pint.json'))) {
    const pint = detectPint(projectRoot);
    if (pint) return pint;
  }

  // 2. .php-cs-fixer config exists
  if (existsSync(join(projectRoot, '.php-cs-fixer.php')) ||
      existsSync(join(projectRoot, '.php-cs-fixer.dist.php'))) {
    const fixer = detectPhpCsFixer(projectRoot);
    if (fixer) return fixer;
  }

  // 3. Pint binary exists (no config needed — uses built-in Laravel defaults)
  const pintBinary = findBinary(projectRoot, 'pint');
  if (pintBinary) {
    return { name: 'pint', binary: pintBinary, fallback: false };
  }

  // 4. PHP CS Fixer binary exists (no config — use fallback)
  const fixerBinary = findBinary(projectRoot, 'php-cs-fixer');
  if (fixerBinary) {
    return { name: 'php-cs-fixer', binary: fixerBinary, fallback: true };
  }

  return null;
}

function detectPint(projectRoot) {
  const binary = findBinary(projectRoot, 'pint');
  if (binary) return { name: 'pint', binary, fallback: false };
  return null;
}

function detectPhpCsFixer(projectRoot) {
  const binary = findBinary(projectRoot, 'php-cs-fixer');
  if (binary) {
    const hasConfig = existsSync(join(projectRoot, '.php-cs-fixer.php')) ||
                      existsSync(join(projectRoot, '.php-cs-fixer.dist.php'));
    return { name: 'php-cs-fixer', binary, fallback: !hasConfig };
  }
  return null;
}

function findBinary(projectRoot, name) {
  // Return relative path to avoid sandbox issues with absolute paths
  const vendorRelative = join('vendor', 'bin', name);
  const vendorAbsolute = join(projectRoot, vendorRelative);
  if (existsSync(vendorAbsolute)) return vendorRelative;

  // On Windows, check for .bat variant
  if (process.platform === 'win32') {
    const batRelative = vendorRelative + '.bat';
    const batAbsolute = vendorAbsolute + '.bat';
    if (existsSync(batAbsolute)) return batRelative;
  }

  return null;
}

/**
 * Run the detected formatter.
 */
async function runFormatter(detected, projectRoot, options = {}) {
  const { dirtyOnly = true, verbose = false, logger = null } = options;
  const args = [];

  if (detected.name === 'pint') {
    if (dirtyOnly) args.push('--dirty');
    if (!verbose) args.push('--quiet');
  } else if (detected.name === 'php-cs-fixer') {
    args.push('fix');
    if (!verbose) args.push('--quiet');
    args.push('--allow-risky=yes');
  }

  if (verbose && logger) {
    await logger.info('StyleFormatter', `Running: ${detected.binary} ${args.join(' ')}`);
  }

  // R10-007 FIX: Use envKeys allowlist instead of useProcessEnv to avoid leaking secrets.
  // PHP formatters need PHP_INI_SCAN_DIR, COMPOSER_HOME, and APP_ENV; the rest are in BASE_ENV_KEYS.
  const result = await execCommand('php', [detected.binary, ...args], {
    cwd: projectRoot,
    timeout: 120_000,
    envKeys: ['PHP_INI_SCAN_DIR', 'COMPOSER_HOME', 'APP_ENV'],
  });

  // Parse output to count changed files
  let filesChanged = 0;
  if (result.ok || result.exitCode === 1) {
    // Pint and PHP CS Fixer output file paths in their output
    const output = result.stdout || '';
    const lines = output.split('\n').filter(l => l.trim());
    filesChanged = lines.filter(l =>
      l.includes('.php') || l.includes('FIXED') || l.includes('fixed')
    ).length;

    // Fallback: count non-empty non-header lines
    if (filesChanged === 0 && lines.length > 0) {
      filesChanged = lines.filter(l =>
        !l.startsWith('Loaded') && !l.startsWith('Using') &&
        !l.startsWith('Found') && !l.startsWith('Fixed') &&
        l.trim().length > 0
      ).length;
    }
  }

  if (logger) {
    if (result.ok) {
      await logger.info('StyleFormatter', `Formatting complete: ${filesChanged} file(s) changed`);
    } else if (result.exitCode === -1 && (result.stderr || '').includes('Blocked')) {
      await logger.warn('StyleFormatter',
        'Code style formatting was blocked by the execution sandbox. ' +
        'This is a sandbox restriction, not a tool error. ' +
        'Run `vendor/bin/pint` manually after the upgrade completes.');
    } else {
      await logger.warn('StyleFormatter', `Formatter exited with code ${result.exitCode}: ${(result.stderr || '').substring(0, 200)}`);
    }
  }

  return { filesChanged };
}

/**
 * Generate a style formatting report for the Reporter agent.
 * @param {object} result - Result from runStyleFormatting
 * @returns {string} Markdown report section
 */
export function generateStyleReport(result) {
  if (!result || !result.formatted) {
    if (result?.formatter === 'none') return 'Code style formatting was disabled.';
    if (result?.formatter === 'not-found') return 'No code formatter was detected.';
    return 'No files were reformatted.';
  }

  const lines = [
    `Formatter: ${result.formatter}${result.fallbackUsed ? " (Shift's Laravel coding style fallback)" : ''}`,
    `Files reformatted: ${result.filesChanged}`,
  ];

  return lines.join('\n');
}
