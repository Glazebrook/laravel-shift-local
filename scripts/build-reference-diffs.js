#!/usr/bin/env node

/**
 * Build Reference Diffs — Development-time script
 *
 * Clones Laravel Shift reference repos and generates version-to-version
 * diff manifests. NOT run during upgrades — output is pre-built JSON
 * shipped with the tool.
 *
 * Usage: node scripts/build-reference-diffs.js
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_BASE = 'https://github.com/laravel-shift';
const OUTPUT_DIR = resolve(import.meta.dirname, '..', 'data', 'reference-diffs');
const TEMP_DIR = resolve(import.meta.dirname, '..', '.tmp-reference-repos');

// Version suffixes to try cloning — we discover which exist
const VERSIONS_TO_TRY = ['8', '9', '10', '11', '12', '13'];

function log(msg) {
  console.log(`[build-reference-diffs] ${msg}`);
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 120_000, ...opts }).trim();
}

/**
 * Clone a reference repo, returning the local path or null if it doesn't exist.
 */
function cloneRepo(version) {
  const repoUrl = `${REPO_BASE}/laravel-${version}.x.git`;
  const localPath = join(TEMP_DIR, `laravel-${version}.x`);

  if (existsSync(localPath)) {
    log(`  Already cloned: laravel-${version}.x`);
    return localPath;
  }

  try {
    log(`  Cloning ${repoUrl}...`);
    exec(`git clone --depth 1 ${repoUrl} "${localPath}"`, { stdio: 'pipe' });
    return localPath;
  } catch {
    log(`  Repository laravel-${version}.x not found — skipping`);
    return null;
  }
}

/**
 * Parse a composer.json file into a structured object.
 */
function parseComposerJson(repoPath) {
  const composerPath = join(repoPath, 'composer.json');
  if (!existsSync(composerPath)) return null;
  try {
    return JSON.parse(readFileSync(composerPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Get all files in a repo (relative paths), excluding .git and vendor.
 */
function getRepoFiles(repoPath) {
  const files = new Set();

  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'vendor' || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else {
        files.add(rel);
      }
    }
  }

  walk(repoPath);
  return files;
}

/**
 * Generate a unified diff between two files using git diff --no-index.
 */
function diffFiles(fileA, fileB) {
  try {
    // git diff --no-index exits with 1 when files differ (not an error)
    return exec(`git diff --no-index --unified=3 "${fileA}" "${fileB}"`, { stdio: 'pipe' });
  } catch (err) {
    // Exit code 1 = files differ (expected), capture stdout
    if (err.stdout) return err.stdout.trim();
    return '';
  }
}

/**
 * Compute composer dependency changes between two composer.json files.
 */
function computeComposerChanges(fromComposer, toComposer) {
  if (!fromComposer || !toComposer) return null;

  const result = {
    requireUpdates: {},
    requireDevUpdates: {},
    additions: {},
    removals: [],
  };

  const fromReq = fromComposer.require || {};
  const toReq = toComposer.require || {};
  const fromDev = fromComposer['require-dev'] || {};
  const toDev = toComposer['require-dev'] || {};

  // Require updates and additions
  for (const [pkg, ver] of Object.entries(toReq)) {
    if (fromReq[pkg] && fromReq[pkg] !== ver) {
      result.requireUpdates[pkg] = { from: fromReq[pkg], to: ver };
    } else if (!fromReq[pkg]) {
      result.additions[pkg] = ver;
    }
  }

  // Require removals
  for (const pkg of Object.keys(fromReq)) {
    if (!toReq[pkg]) {
      result.removals.push(pkg);
    }
  }

  // Dev updates
  for (const [pkg, ver] of Object.entries(toDev)) {
    if (fromDev[pkg] && fromDev[pkg] !== ver) {
      result.requireDevUpdates[pkg] = { from: fromDev[pkg], to: ver };
    } else if (!fromDev[pkg]) {
      if (!result.additions[pkg]) result.additions[pkg] = ver;
    }
  }

  // Dev removals
  for (const pkg of Object.keys(fromDev)) {
    if (!toDev[pkg] && !result.removals.includes(pkg)) {
      result.removals.push(pkg);
    }
  }

  return result;
}

/**
 * Infer breaking changes from file diffs.
 */
function inferBreakingChanges(filesAdded, filesRemoved, filesModified) {
  const breaking = [];

  for (const file of filesRemoved) {
    breaking.push({
      category: 'structure',
      title: `${file.path} removed`,
      description: file.description || `File ${file.path} was removed from the skeleton`,
      affectedFiles: [file.path],
      automatable: true,
    });
  }

  for (const file of filesAdded) {
    if (file.path.includes('bootstrap/') || file.path.includes('config/')) {
      breaking.push({
        category: 'structure',
        title: `New file: ${file.path}`,
        description: file.description || `New file added to skeleton: ${file.path}`,
        affectedFiles: [file.path],
        automatable: true,
      });
    }
  }

  for (const file of filesModified) {
    if (file.breaking) {
      breaking.push({
        category: 'modification',
        title: `${file.path} modified`,
        description: file.description || `File ${file.path} was modified`,
        affectedFiles: [file.path],
        automatable: true,
      });
    }
  }

  return breaking;
}

/**
 * Describe a file change based on its path.
 */
function describeChange(filePath, type) {
  const descriptions = {
    'app/Http/Kernel.php': 'HTTP Kernel — middleware registration',
    'app/Console/Kernel.php': 'Console Kernel — command scheduling',
    'app/Exceptions/Handler.php': 'Exception Handler',
    'bootstrap/app.php': 'Application bootstrap configuration',
    'bootstrap/providers.php': 'Service providers registration',
    'config/app.php': 'Application configuration',
    'composer.json': 'Composer dependencies',
    'phpunit.xml': 'PHPUnit configuration',
    '.env.example': 'Environment variables template',
  };

  if (descriptions[filePath]) {
    return `${type === 'removed' ? 'Removed' : type === 'added' ? 'New' : 'Modified'}: ${descriptions[filePath]}`;
  }

  return `${type === 'removed' ? 'Removed' : type === 'added' ? 'New' : 'Modified'} file`;
}

/**
 * Determine if a file modification is likely breaking.
 */
function isLikelyBreaking(filePath, diff) {
  const breakingPaths = [
    'app/Http/Kernel.php',
    'app/Console/Kernel.php',
    'app/Exceptions/Handler.php',
    'bootstrap/app.php',
    'config/app.php',
    'composer.json',
  ];

  if (breakingPaths.includes(filePath)) return true;

  // Large diffs (>50 lines changed) in core files are likely breaking
  if (filePath.startsWith('config/') && diff && diff.split('\n').length > 50) return true;

  return false;
}

/**
 * Build a diff manifest between two version repos.
 */
function buildManifest(fromVersion, toVersion, fromPath, toPath) {
  log(`Building manifest: ${fromVersion} → ${toVersion}`);

  const fromFiles = getRepoFiles(fromPath);
  const toFiles = getRepoFiles(toPath);

  const filesAdded = [];
  const filesRemoved = [];
  const filesModified = [];

  // Files added in target
  for (const file of toFiles) {
    if (!fromFiles.has(file)) {
      let content = '';
      try {
        content = readFileSync(join(toPath, file), 'utf8');
        if (content.length > 10_000) content = content.substring(0, 10_000) + '\n... (truncated)';
      } catch { /* binary or unreadable */ }

      filesAdded.push({
        path: file,
        content,
        description: describeChange(file, 'added'),
      });
    }
  }

  // Files removed from source
  for (const file of fromFiles) {
    if (!toFiles.has(file)) {
      filesRemoved.push({
        path: file,
        description: describeChange(file, 'removed'),
        breaking: isLikelyBreaking(file, ''),
        migration: `Review if ${file} has custom code that needs to be migrated`,
      });
    }
  }

  // Files modified (present in both)
  for (const file of fromFiles) {
    if (!toFiles.has(file)) continue;

    const fromFile = join(fromPath, file);
    const toFile = join(toPath, file);

    let fromContent, toContent;
    try {
      fromContent = readFileSync(fromFile, 'utf8');
      toContent = readFileSync(toFile, 'utf8');
    } catch {
      continue; // Binary files — skip
    }

    if (fromContent === toContent) continue;

    const diff = diffFiles(fromFile, toFile);
    const breaking = isLikelyBreaking(file, diff);

    filesModified.push({
      path: file,
      diff: diff.length > 5000 ? diff.substring(0, 5000) + '\n... (truncated)' : diff,
      description: describeChange(file, 'modified'),
      breaking,
    });
  }

  // Composer changes
  const fromComposer = parseComposerJson(fromPath);
  const toComposer = parseComposerJson(toPath);
  const composerChanges = computeComposerChanges(fromComposer, toComposer);

  // Breaking changes summary
  const breakingChanges = inferBreakingChanges(filesAdded, filesRemoved, filesModified);

  return {
    from: `${fromVersion}.x`,
    to: `${toVersion}.x`,
    generated: new Date().toISOString(),
    sourceRepos: {
      from: `${REPO_BASE}/laravel-${fromVersion}.x`,
      to: `${REPO_BASE}/laravel-${toVersion}.x`,
    },
    skeleton: {
      filesAdded,
      filesRemoved,
      filesModified,
    },
    composer: composerChanges || {
      requireUpdates: {},
      requireDevUpdates: {},
      additions: {},
      removals: [],
    },
    breakingChanges,
  };
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  log('Starting reference diff build...');

  // Create directories
  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  // Clone all available repos
  log('Cloning reference repositories...');
  const clonedVersions = [];
  for (const version of VERSIONS_TO_TRY) {
    const path = cloneRepo(version);
    if (path) {
      clonedVersions.push({ version, path });
    }
  }

  log(`Cloned ${clonedVersions.length} repos: ${clonedVersions.map(v => v.version).join(', ')}`);

  if (clonedVersions.length < 2) {
    log('Need at least 2 repos to generate diffs. Exiting.');
    process.exit(1);
  }

  // Generate diffs for consecutive pairs
  let generated = 0;
  for (let i = 0; i < clonedVersions.length - 1; i++) {
    const from = clonedVersions[i];
    const to = clonedVersions[i + 1];

    const manifest = buildManifest(from.version, to.version, from.path, to.path);
    const outputPath = join(OUTPUT_DIR, `${from.version}-to-${to.version}.json`);
    writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf8');

    log(`  Written: ${from.version}-to-${to.version}.json`);
    log(`    Added: ${manifest.skeleton.filesAdded.length}, Removed: ${manifest.skeleton.filesRemoved.length}, Modified: ${manifest.skeleton.filesModified.length}`);
    log(`    Breaking changes: ${manifest.breakingChanges.length}`);
    generated++;
  }

  // Cleanup
  log('Cleaning up temp directories...');
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    log('Warning: Could not clean up temp directory. Remove manually: ' + TEMP_DIR);
  }

  log(`Done! Generated ${generated} diff manifest(s) in ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  // Cleanup on error
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
