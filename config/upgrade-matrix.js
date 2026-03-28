/**
 * Upgrade Matrix - Breaking changes and hints per upgrade path
 * Covers Laravel 8 -> 13.x
 */

// REL-7 FIX: Import KNOWN_VERSIONS from state-manager (single source of truth)
import { KNOWN_VERSIONS } from '../src/state-manager.js';

export const UPGRADE_MATRIX = {

  // ── 8 → 9 ──────────────────────────────────────────────────────
  '8->9': {
    phpMin: '8.0',
    breaking: [
      'PHP 8.0 minimum (was 7.3)',
      'Flysystem 3.x — Storage method signatures changed',
      'Symfony 6.x components upgraded',
      'Model::$dates deprecated — use $casts instead',
      'Model::getDateFormat() changed',
      'castAndTransform method removed from BelongsToMany',
      'lang/ directory moved to resources/lang/ — still supported via symlink',
      'assertExactJson now order-sensitive',
      'Route::home() removed',
      'The Authenticatable contract now requires getAuthPasswordForReset()',
      'Blade::withDoubleEncoding() removed — always double-encodes now',
    ],
    hints: [
      'Run: composer require laravel/framework:^9.0',
      'Check Storage disk configurations for Flysystem 3 changes',
      'Replace $dates property with $casts array entries',
      'Update PHPUnit to ^9.0',
      'Review any custom filesystem adapters',
    ],
  },

  // ── 9 → 10 ─────────────────────────────────────────────────────
  '9->10': {
    phpMin: '8.1',
    breaking: [
      'PHP 8.1 minimum (was 8.0)',
      'All framework return types now declared — extend carefully',
      'Eloquent Model::updated_at no longer nullable by default',
      'Bus::dispatchToQueue() removed — use dispatch()->onQueue()',
      'RedisManager::parseConnection removed',
      'Filesystem::put() return type changed',
      'assertDeletedInDatabase() removed — use assertDatabaseMissing()',
      'Carbon 2.65+ required',
      'Deprecated Model setRawAttributes() changes',
    ],
    hints: [
      'PHP 8.1 enum support now available — consider migrating string constants',
      'Check any classes extending framework classes for return type conflicts',
      'Run: composer require laravel/framework:^10.0 phpunit/phpunit:^10.0',
      'Update laravel/pint, laravel/sail if used',
    ],
  },

  // ── 10 → 11 ────────────────────────────────────────────────────
  '10->11': {
    phpMin: '8.2',
    breaking: [
      'PHP 8.2 minimum (was 8.1)',
      'Slim app skeleton — app/Http/Kernel.php REMOVED (use bootstrap/app.php)',
      'app/Console/Kernel.php REMOVED (use routes/console.php)',
      'app/Exceptions/Handler.php REMOVED (use bootstrap/app.php ->withExceptions())',
      'Middleware registration moved to bootstrap/app.php',
      'Exception handling API changed completely',
      'RedirectIfAuthenticated now references route names not paths',
      'Health check endpoint added at /up by default',
      'APP_KEY must be 32+ characters',
      'Eloquent Model::$connection not respected in some join queries — fixed but check',
      'Removed deprecated Queue methods: bulk, pop',
      'Removed deprecated Auth::routes() — use starter kits',
      'Broadcasting routing moved to routes/channels.php',
    ],
    hints: [
      'MAJOR: New slim app skeleton changes where middleware/exceptions are registered',
      'bootstrap/app.php now handles: middleware, routing, exceptions',
      'Migrate Kernel.php middleware to bootstrap/app.php ->withMiddleware()',
      'Migrate Handler.php to bootstrap/app.php ->withExceptions()',
      'Routes should be in routes/web.php, routes/api.php, routes/console.php, routes/channels.php',
      'Run: composer require laravel/framework:^11.0',
      'Consider running: php artisan install:api for API scaffolding',
    ],
  },

  // ── 11 → 12 ────────────────────────────────────────────────────
  '11->12': {
    phpMin: '8.2',
    breaking: [
      'PHP 8.2 minimum maintained',
      'Schema::hasTable() / hasColumn() performance improvements — behaviour consistent',
      'Doctrine DBAL dependency removed — raw DB column inspection changed',
      'DatabaseTruncation trait refresh strategy changes',
      'Model broadcasting changes — channel name format updated',
      'assertModelMissing() improvements',
      'Pest 3 / PHPUnit 11 supported',
    ],
    hints: [
      'Mostly smooth upgrade from 11 — fewer breaking changes',
      'Check any code using Doctrine DBAL directly',
      'Update test helpers if using DatabaseTruncation',
      'Run: composer require laravel/framework:^12.0',
    ],
  },

  // ── 12 → 13 ────────────────────────────────────────────────────
  // FIX #24: Marked as speculative placeholder — Laravel 13 is not yet released.
  // The planner agent should be informed that this data is provisional.
  '12->13': {
    phpMin: '8.3',
    speculative: true, // Flag for consumers to know this is a placeholder
    breaking: [
      '[SPECULATIVE] PHP 8.3 minimum',
      '[SPECULATIVE] Livewire v3 compatibility — check if using Livewire',
      '[SPECULATIVE] Vite plugin updates may be required',
      '[SPECULATIVE] New concurrency helpers — non-breaking but check queue driver',
    ],
    hints: [
      'NOTE: Laravel 13 has not been released yet. These hints are speculative placeholders.',
      'Run: composer require laravel/framework:^13.0',
      'Check Vite/Mix configuration',
      'PHP 8.3 typed class constants now supported',
    ],
  },

  // L3 FIX: Composite entries (8->10, 8->11, 9->11, etc.) have been removed.
  // They were dead data — the planner always uses getCombinedMatrix() which
  // iterates through individual steps. Keeping them created a false impression
  // they were being used and risked going stale.
};

/**
 * Get all version pairs between from and to
 */
export function getUpgradePath(from, to) {
  // REL-7 FIX: Use KNOWN_VERSIONS from state-manager.js (single source of truth)
  const fromIdx = KNOWN_VERSIONS.indexOf(String(from).split('.')[0]);
  const toIdx = KNOWN_VERSIONS.indexOf(String(to).split('.')[0]);
  if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) return [];
  return KNOWN_VERSIONS.slice(fromIdx, toIdx + 1);
}

/**
 * Get combined hints/breaking for a multi-step path.
 * FIX #14: This is now the primary method used by the planner agent
 * instead of direct matrix lookup which returned placeholder strings
 * for composite upgrade paths.
 *
 * For single-step paths (e.g. 10->11), returns the direct entry.
 * For multi-step paths (e.g. 8->11), aggregates all intermediate entries
 * with version labels so the planner knows which changes apply where.
 */
export function getCombinedMatrix(from, to) {
  const path = getUpgradePath(from, to);

  // H6 FIX: Throw when the path is empty so callers don't silently proceed
  // with zero breaking-change guidance. This catches programmatic usage that
  // bypasses CLI version validation.
  if (path.length < 2) {
    throw new Error(
      `Cannot compute upgrade matrix: no valid path from version ${from} to ${to}. ` +
      `Known versions: ${KNOWN_VERSIONS.join(', ')}`
    );
  }

  // If it's a single-step path, return the direct entry
  if (path.length === 2) {
    const key = `${path[0]}->${path[1]}`;
    return UPGRADE_MATRIX[key] || { phpMin: null, breaking: [], hints: [] };
  }

  // Multi-step: aggregate all intermediate entries
  const combined = { phpMin: null, breaking: [], hints: [] };

  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}->${path[i + 1]}`;
    const m = UPGRADE_MATRIX[key];
    if (m) {
      combined.phpMin = m.phpMin;
      combined.breaking.push(...m.breaking.map(b => `[${path[i]}→${path[i + 1]}] ${b}`));
      combined.hints.push(...m.hints);
    }
  }

  // M10 FIX: Deduplicate hints. Multi-step upgrades often share hints
  // (e.g., "Run: composer require laravel/framework:^X"), wasting planner context.
  combined.hints = [...new Set(combined.hints)];

  return combined;
}
