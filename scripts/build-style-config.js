#!/usr/bin/env node

/**
 * Build Style Config — Development-time script
 *
 * Fetches Shift's Laravel coding style PHP CS Fixer config from GitHub gist
 * and saves it as a fallback for projects without their own formatter config.
 *
 * Usage: node scripts/build-style-config.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OUTPUT_DIR = resolve(import.meta.dirname, '..', 'data', 'shift-laravel-style');
const GIST_URL = 'https://gist.githubusercontent.com/laravel-shift/cab527923ed2a109dda047b97d53c200/raw/.php-cs-fixer.dist.php';

function log(msg) {
  console.log(`[build-style-config] ${msg}`);
}

async function main() {
  log('Fetching Shift Laravel coding style...');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  try {
    const response = await fetch(GIST_URL, {
      headers: { 'User-Agent': 'laravel-shift-local/1.0 (build script)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      log(`HTTP ${response.status} — using bundled fallback`);
      writeFallback();
      return;
    }

    const content = await response.text();
    const outputPath = join(OUTPUT_DIR, '.php-cs-fixer.dist.php');
    writeFileSync(outputPath, content, 'utf8');
    log(`Written: .php-cs-fixer.dist.php (${content.length} bytes)`);
  } catch (err) {
    log(`Fetch failed: ${err.message} — using bundled fallback`);
    writeFallback();
  }
}

function writeFallback() {
  const fallback = `<?php

use PhpCsFixer\\Config;
use PhpCsFixer\\Finder;

$finder = Finder::create()
    ->in([
        __DIR__ . '/app',
        __DIR__ . '/config',
        __DIR__ . '/database',
        __DIR__ . '/routes',
        __DIR__ . '/tests',
    ])
    ->name('*.php')
    ->notName('*.blade.php')
    ->ignoreDotFiles(true)
    ->ignoreVCS(true);

return (new Config())
    ->setFinder($finder)
    ->setRules([
        '@PSR12' => true,
        'array_syntax' => ['syntax' => 'short'],
        'ordered_imports' => ['sort_algorithm' => 'alpha'],
        'no_unused_imports' => true,
        'trailing_comma_in_multiline' => true,
        'single_quote' => true,
        'no_extra_blank_lines' => true,
        'blank_line_before_statement' => ['statements' => ['return']],
    ])
    ->setRiskyAllowed(true)
    ->setUsingCache(true);
`;
  const outputPath = join(OUTPUT_DIR, '.php-cs-fixer.dist.php');
  writeFileSync(outputPath, fallback, 'utf8');
  log('Written bundled fallback .php-cs-fixer.dist.php');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
