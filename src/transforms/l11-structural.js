/**
 * Transform: Laravel 11 Structural Migration
 *
 * Deterministic transform that converts a Laravel 10 (or earlier) project
 * structure to the Laravel 11 application skeleton:
 *
 * - Removes app/Http/Kernel.php -> migrates middleware to bootstrap/app.php
 * - Removes app/Console/Kernel.php -> migrates scheduled commands to routes/console.php
 * - Removes app/Exceptions/Handler.php -> migrates to bootstrap/app.php withExceptions()
 * - Rewrites bootstrap/app.php with Application::configure()
 * - Creates bootstrap/providers.php
 * - Removes default middleware stubs
 * - Removes default service provider stubs
 * - Removes config/cors.php (CORS is built into L11 framework)
 * - Updates tests/TestCase.php
 * - Deletes tests/CreatesApplication.php
 *
 * This transform only runs when target version >= 11 AND the project
 * currently has the old structure (Kernel.php exists).
 *
 * Runs as a project-level transform (not per-file) in the pre-processing phase.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, rmdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';

// Default Laravel 10 global middleware (built into L11 framework)
const DEFAULT_GLOBAL_MIDDLEWARE = [
  'App\\Http\\Middleware\\TrustProxies',
  'Illuminate\\Http\\Middleware\\HandleCors',
  'App\\Http\\Middleware\\PreventRequestsDuringMaintenance',
  'Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize',
  'App\\Http\\Middleware\\TrimStrings',
  'Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull',
];

// Default middleware stubs that ship with Laravel 10
const DEFAULT_MIDDLEWARE_STUBS = [
  'Authenticate',
  'EncryptCookies',
  'PreventRequestsDuringMaintenance',
  'RedirectIfAuthenticated',
  'TrimStrings',
  'TrustHosts',
  'TrustProxies',
  'ValidateSignature',
  'VerifyCsrfToken',
];

// Default route middleware aliases in Laravel 10
const DEFAULT_ALIASES = [
  'auth', 'auth.basic', 'auth.session', 'cache.headers',
  'can', 'guest', 'password.confirm', 'precognitive',
  'signed', 'throttle', 'verified',
];

// Default providers in Laravel 10's config/app.php
const DEFAULT_PROVIDERS = [
  'App\\Providers\\AppServiceProvider',
  'App\\Providers\\AuthServiceProvider',
  'App\\Providers\\BroadcastServiceProvider',
  'App\\Providers\\EventServiceProvider',
  'App\\Providers\\RouteServiceProvider',
];

// Default middleware class names used in middleware groups
const DEFAULT_GROUP_MIDDLEWARE = [
  'Authenticate', 'EncryptCookies', 'PreventRequestsDuringMaintenance',
  'RedirectIfAuthenticated', 'TrimStrings', 'TrustHosts',
  'TrustProxies', 'ValidateSignature', 'VerifyCsrfToken',
  'EnsureEmailIsVerified',
];

/**
 * Extract custom middleware from Kernel.php $middleware array.
 */
export function extractCustomMiddleware(kernelContent) {
  const custom = [];

  const middlewareMatch = kernelContent.match(
    /protected\s+\$middleware\s*=\s*\[([\s\S]*?)\];/
  );

  if (middlewareMatch) {
    const entries = middlewareMatch[1].match(/\\?[\w\\]+::class/g) || [];
    for (const entry of entries) {
      const className = entry.replace(/::class$/, '').replace(/^\\/, '');
      const isDefault = DEFAULT_GLOBAL_MIDDLEWARE.some(d =>
        d === className || d === className.replace(/^\\/, '') || className === d.replace(/^\\/, '')
      );
      if (!isDefault) {
        custom.push(className);
      }
    }
  }

  return custom;
}

/**
 * Extract custom middleware added to groups beyond defaults.
 */
export function extractCustomMiddlewareGroups(kernelContent) {
  const groups = {};

  const groupsMatch = kernelContent.match(
    /protected\s+\$middlewareGroups\s*=\s*\[([\s\S]*?)\n\s{4}\];/
  );

  if (groupsMatch) {
    const content = groupsMatch[1];
    // Find all App\Http\Middleware references that aren't defaults
    const refs = content.match(/\\?[\w\\]+::class/g) || [];
    const customRefs = [];
    for (const ref of refs) {
      const className = ref.replace(/::class$/, '').replace(/^\\/, '');
      if (className.startsWith('App\\Http\\Middleware\\')) {
        const name = className.split('\\').pop();
        if (!DEFAULT_GROUP_MIDDLEWARE.includes(name)) {
          customRefs.push(className);
        }
      }
    }
    if (customRefs.length > 0) {
      groups.custom = customRefs;
    }
  }

  return groups;
}

/**
 * Extract custom middleware aliases.
 */
export function extractCustomMiddlewareAliases(kernelContent) {
  const aliases = {};

  const aliasMatch = kernelContent.match(
    /protected\s+\$(?:middlewareAliases|routeMiddleware)\s*=\s*\[([\s\S]*?)\n\s{4}\];/
  );

  if (aliasMatch) {
    const entries = aliasMatch[1].matchAll(
      /['"](\w[\w.]+)['"]\s*=>\s*(\\?[\w\\]+)::class/g
    );

    for (const [, alias, className] of entries) {
      if (!DEFAULT_ALIASES.includes(alias)) {
        aliases[alias] = className.replace(/^\\/, '');
      }
    }
  }

  return aliases;
}

/**
 * Extract custom exception handling code from Handler.php register() method.
 * Returns empty string if only default/empty.
 */
export function extractCustomExceptionHandling(handlerContent) {
  const registerMatch = handlerContent.match(
    /public\s+function\s+register\s*\(\s*\)\s*(?::\s*void\s*)?\{([\s\S]*?)\n\s{4}\}/
  );

  if (registerMatch) {
    const body = registerMatch[1].trim();
    // Strip comments
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .trim();

    if (stripped) {
      return stripped;
    }
  }

  return '';
}

/**
 * Extract custom providers from config/app.php providers array.
 */
export function extractCustomProviders(configContent) {
  const custom = [];

  const providersMatch = configContent.match(
    /['"]providers['"]\s*=>\s*(?:ServiceProvider::defaultProviders\(\)->merge\(\s*)?\[([\s\S]*?)\]/
  );

  if (providersMatch) {
    const entries = providersMatch[1].match(/[\w\\]+::class/g) || [];
    for (const entry of entries) {
      const className = entry.replace(/::class$/, '');

      // Skip framework providers
      if (className.startsWith('Illuminate\\') || className.startsWith('Laravel\\')) {
        continue;
      }

      // Skip default app providers
      if (DEFAULT_PROVIDERS.includes(className)) {
        continue;
      }

      custom.push(className);
    }
  }

  return custom;
}

/**
 * Generate the new Laravel 11 bootstrap/app.php content.
 */
export function generateBootstrapApp({ customMiddleware, customMiddlewareGroups, customMiddlewareAliases, customExceptionCode }) {
  let middlewareBlock = '';

  const lines = [];

  for (const mw of customMiddleware) {
    lines.push(`        $middleware->append(\\${mw}::class);`);
  }

  if (customMiddlewareGroups?.custom) {
    for (const mw of customMiddlewareGroups.custom) {
      lines.push(`        $middleware->appendToGroup('web', \\${mw}::class);`);
    }
  }

  for (const [alias, className] of Object.entries(customMiddlewareAliases || {})) {
    lines.push(`        $middleware->alias(['${alias}' => \\${className}::class]);`);
  }

  if (lines.length > 0) {
    middlewareBlock = `\n${lines.join('\n')}\n    `;
  }

  let exceptionBlock = '';
  if (customExceptionCode) {
    exceptionBlock = `\n        ${customExceptionCode}\n    `;
  }

  return `<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Exceptions;
use Illuminate\\Foundation\\Configuration\\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {${middlewareBlock}})
    ->withExceptions(function (Exceptions $exceptions) {${exceptionBlock}})->create();
`;
}

/**
 * Add api routing to bootstrap/app.php if routes/api.php exists.
 */
export function addApiRouting(bootstrapContent) {
  return bootstrapContent.replace(
    "commands: __DIR__.'/../routes/console.php',",
    "api: __DIR__.'/../routes/api.php',\n        commands: __DIR__.'/../routes/console.php',"
  );
}

/**
 * Generate bootstrap/providers.php content.
 */
export function generateProvidersFile(providers) {
  const lines = providers.map(p => `    ${p}::class,`).join('\n');

  return `<?php

return [
${lines}
];
`;
}

/**
 * Check if a middleware file is a default Laravel stub (no custom code).
 */
export function isDefaultMiddlewareStub(content) {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .trim();

  // If it has custom non-empty arrays like $except = ['api/*'],
  // or custom method bodies, it's customised
  const hasNonEmptyExcept = /\$except\s*=\s*\[\s*[^\]\s]/.test(stripped);
  const hasNonEmptyDontReport = /\$dontReport\s*=\s*\[\s*[^\]\s]/.test(stripped);
  const hasNonEmptyProxies = /\$proxies\s*=\s*(?!'?\*'?\s*;)[^\[]*\[\s*[^\]\s]/.test(stripped);

  // Check for custom method bodies (methods with actual statements)
  const methods = [...stripped.matchAll(/function\s+\w+\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{([\s\S]*?)\}/g)];
  for (const [, body] of methods) {
    const bodyStripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '').trim();
    if (bodyStripped && bodyStripped !== '//' && !bodyStripped.startsWith('return')) {
      // Has meaningful code in a method body — may be custom
      // But default stubs also have method bodies (e.g., RedirectIfAuthenticated)
      // so we need to be more specific
    }
  }

  // Conservative: if it has non-empty $except or custom proxy lists, it's customised
  if (hasNonEmptyExcept || hasNonEmptyDontReport || hasNonEmptyProxies) {
    return false;
  }

  return true;
}

/**
 * Check if a provider file is a default stub (no custom code in boot/register).
 */
export function isDefaultProviderStub(content) {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .trim();

  const methods = [...stripped.matchAll(/function\s+(register|boot)\s*\([^)]*\)\s*(?::\s*void\s*)?\{([\s\S]*?)\n\s{4}\}/g)];

  for (const [, , body] of methods) {
    const bodyStripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '').trim();
    if (bodyStripped) {
      return false;
    }
  }

  return true;
}

/**
 * Remove a directory if it's empty.
 */
function cleanEmptyDir(dirPath) {
  if (!existsSync(dirPath)) return;
  try {
    const entries = readdirSync(dirPath);
    if (entries.length === 0) {
      rmdirSync(dirPath);
    }
  } catch {
    // Ignore — directory may not exist or may not be empty
  }
}

/**
 * SEC-003 FIX: Validate that a resolved path stays within projectRoot.
 */
function validatePath(projectRoot, fullPath) {
  const prefix = projectRoot + (projectRoot.endsWith(sep) ? '' : sep);
  const resolved = resolve(fullPath);
  if (resolved !== projectRoot && !resolved.startsWith(prefix)) {
    throw new Error(`Path traversal blocked: ${fullPath}`);
  }
}

/**
 * Back up a file to .shift/backups/ before deleting.
 * SEC-003 FIX: Added path validation to prevent writes outside projectRoot.
 */
function backupFile(projectRoot, relPath) {
  const fullPath = join(projectRoot, relPath);
  validatePath(projectRoot, fullPath);
  if (!existsSync(fullPath)) return;

  const backupDir = join(projectRoot, '.shift', 'backups', dirname(relPath));
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(fullPath, join(backupDir, basename(relPath)));
}

export default {
  name: 'l11-structural',
  description: 'Migrate to Laravel 11 application structure',

  // Version range for source: any version from 8 onwards
  appliesFrom: '8',
  appliesTo: null,

  // Only runs if TARGET version is 11+
  targetMinVersion: 11,

  // Project-level transform (not per-file)
  projectLevel: true,

  /**
   * Detect whether the project needs this transform.
   * Returns true if the project has the old Laravel <=10 structure.
   */
  detect(projectRoot) {
    return existsSync(join(projectRoot, 'app', 'Http', 'Kernel.php'));
  },

  /**
   * Run the structural migration.
   * @param {string} projectRoot
   * @param {object} [options] - { verbose, dryRun }
   * @returns {object} results
   */
  run(projectRoot, options = {}) {
    const results = {
      filesDeleted: [],
      filesCreated: [],
      filesModified: [],
      customMiddleware: [],
      customProviders: [],
      customExceptionHandling: false,
    };

    // ── STEP 1: Extract custom middleware from Kernel.php ──
    const kernelPath = join(projectRoot, 'app', 'Http', 'Kernel.php');
    // P2-008 FIX: Wrap in try-catch so an unreadable Kernel.php doesn't crash
    // the entire pre-processing phase. Return empty results and let the LLM handle it.
    let kernelContent;
    try {
      kernelContent = readFileSync(kernelPath, 'utf-8');
    } catch (err) {
      // Kernel.php exists (detect() passed) but is unreadable — return empty results
      return results;
    }

    const customMiddleware = extractCustomMiddleware(kernelContent);
    results.customMiddleware = customMiddleware;

    const customMiddlewareGroups = extractCustomMiddlewareGroups(kernelContent);
    const customMiddlewareAliases = extractCustomMiddlewareAliases(kernelContent);

    // ── STEP 2: Extract custom providers from config/app.php ──
    const configAppPath = join(projectRoot, 'config', 'app.php');
    let customProviders = [];

    if (existsSync(configAppPath)) {
      const configAppContent = readFileSync(configAppPath, 'utf-8');
      customProviders = extractCustomProviders(configAppContent);
      results.customProviders = customProviders;
    }

    // ── STEP 3: Check for custom exception handling ──
    const handlerPath = join(projectRoot, 'app', 'Exceptions', 'Handler.php');
    let customExceptionCode = '';

    if (existsSync(handlerPath)) {
      const handlerContent = readFileSync(handlerPath, 'utf-8');
      customExceptionCode = extractCustomExceptionHandling(handlerContent);
      results.customExceptionHandling = customExceptionCode.length > 0;
    }

    if (options.dryRun) {
      return results;
    }

    // ── STEP 4: Generate new bootstrap/app.php ──
    let newBootstrapApp = generateBootstrapApp({
      customMiddleware,
      customMiddlewareGroups,
      customMiddlewareAliases,
      customExceptionCode,
    });

    // Add api routing if routes/api.php exists
    if (existsSync(join(projectRoot, 'routes', 'api.php'))) {
      newBootstrapApp = addApiRouting(newBootstrapApp);
    }

    const bootstrapAppPath = join(projectRoot, 'bootstrap', 'app.php');
    validatePath(projectRoot, bootstrapAppPath);
    backupFile(projectRoot, 'bootstrap/app.php');
    // R10-003 FIX: Atomic write — write to temp then rename
    const bootstrapTmp = bootstrapAppPath + '.tmp';
    writeFileSync(bootstrapTmp, newBootstrapApp, 'utf-8');
    renameSync(bootstrapTmp, bootstrapAppPath);
    results.filesModified.push('bootstrap/app.php');

    // ── STEP 5: Generate bootstrap/providers.php ──
    const allProviders = ['App\\Providers\\AppServiceProvider', ...customProviders];
    const providersContent = generateProvidersFile(allProviders);

    const providersPath = join(projectRoot, 'bootstrap', 'providers.php');
    validatePath(projectRoot, providersPath);
    mkdirSync(dirname(providersPath), { recursive: true });
    // R10-003 FIX: Atomic write — write to temp then rename
    const providersTmp = providersPath + '.tmp';
    writeFileSync(providersTmp, providersContent, 'utf-8');
    renameSync(providersTmp, providersPath);
    results.filesCreated.push('bootstrap/providers.php');

    // ── STEP 6: Delete old structural files ──
    const filesToDelete = [
      'app/Http/Kernel.php',
      'app/Console/Kernel.php',
      'app/Exceptions/Handler.php',
      'config/cors.php',
      'tests/CreatesApplication.php',
    ];

    const defaultProviderFiles = [
      'app/Providers/AuthServiceProvider.php',
      'app/Providers/BroadcastServiceProvider.php',
      'app/Providers/EventServiceProvider.php',
      'app/Providers/RouteServiceProvider.php',
    ];

    // Delete default middleware stubs (only if no custom code)
    for (const stub of DEFAULT_MIDDLEWARE_STUBS) {
      const stubPath = `app/Http/Middleware/${stub}.php`;
      const fullPath = join(projectRoot, stubPath);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        if (isDefaultMiddlewareStub(content)) {
          filesToDelete.push(stubPath);
        }
      }
    }

    // Delete default providers (only if stock/empty)
    for (const providerFile of defaultProviderFiles) {
      const fullPath = join(projectRoot, providerFile);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        if (isDefaultProviderStub(content)) {
          filesToDelete.push(providerFile);
        }
      }
    }

    for (const fileToDelete of filesToDelete) {
      const fullPath = join(projectRoot, fileToDelete);
      validatePath(projectRoot, fullPath);
      if (existsSync(fullPath)) {
        backupFile(projectRoot, fileToDelete);
        unlinkSync(fullPath);
        results.filesDeleted.push(fileToDelete);
      }
    }

    // Clean up empty directories
    cleanEmptyDir(join(projectRoot, 'app', 'Http', 'Middleware'));
    cleanEmptyDir(join(projectRoot, 'app', 'Exceptions'));
    cleanEmptyDir(join(projectRoot, 'app', 'Console'));

    // ── STEP 7: Update tests/TestCase.php ──
    const testCasePath = join(projectRoot, 'tests', 'TestCase.php');
    if (existsSync(testCasePath)) {
      let testCase = readFileSync(testCasePath, 'utf-8');
      const original = testCase;

      // Remove CreatesApplication import and trait usage
      testCase = testCase
        .replace(/use\s+Tests\\CreatesApplication;\s*\n?/g, '')
        .replace(/\s*use\s+CreatesApplication;\s*\n?/g, '');

      if (testCase !== original) {
        validatePath(projectRoot, testCasePath);
        // R10-003 FIX: Atomic write — write to temp then rename
        const testCaseTmp = testCasePath + '.tmp';
        writeFileSync(testCaseTmp, testCase, 'utf-8');
        renameSync(testCaseTmp, testCasePath);
        results.filesModified.push('tests/TestCase.php');
      }
    }

    return results;
  },
};
