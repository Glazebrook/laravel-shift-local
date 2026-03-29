/**
 * Reference Data — Loads and queries pre-built diff manifests
 *
 * Manifests are generated at build time by scripts/build-reference-diffs.js
 * and stored in data/reference-diffs/. This module provides query functions
 * for agents to access the data at runtime without network calls.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KNOWN_VERSIONS } from './state-manager.js';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data', 'reference-diffs');

// In-memory cache of loaded manifests
const manifestCache = new Map();

/**
 * Load the diff manifest for a version transition.
 * @param {string} fromVersion - e.g., "10"
 * @param {string} toVersion - e.g., "11"
 * @returns {object|null} The manifest, or null if no manifest exists
 */
export function loadManifest(fromVersion, toVersion) {
  const from = String(fromVersion).split('.')[0];
  const to = String(toVersion).split('.')[0];
  const cacheKey = `${from}-to-${to}`;

  if (manifestCache.has(cacheKey)) {
    return manifestCache.get(cacheKey);
  }

  const filePath = join(DATA_DIR, `${from}-to-${to}.json`);
  if (!existsSync(filePath)) {
    manifestCache.set(cacheKey, null);
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const manifest = JSON.parse(raw);
    manifestCache.set(cacheKey, manifest);
    return manifest;
  } catch {
    manifestCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Get all breaking changes for a version transition.
 * @param {string} fromVersion
 * @param {string} toVersion
 * @returns {Array} Breaking change objects, or empty array if no manifest
 */
export function getBreakingChanges(fromVersion, toVersion) {
  const manifest = loadManifest(fromVersion, toVersion);
  return manifest?.breakingChanges || [];
}

/**
 * Get composer dependency changes for a version transition.
 * @param {string} fromVersion
 * @param {string} toVersion
 * @returns {object|null} { requireUpdates, requireDevUpdates, additions, removals }
 */
export function getComposerChanges(fromVersion, toVersion) {
  const manifest = loadManifest(fromVersion, toVersion);
  return manifest?.composer || null;
}

/**
 * Get the expected skeleton diff for a specific file.
 * @param {string} fromVersion
 * @param {string} toVersion
 * @param {string} filePath - e.g., "config/app.php"
 * @returns {object|null} The change object for that file
 */
export function getFileChange(fromVersion, toVersion, filePath) {
  const manifest = loadManifest(fromVersion, toVersion);
  if (!manifest) return null;

  // Check added files
  const added = manifest.skeleton.filesAdded?.find(f => f.path === filePath);
  if (added) return { type: 'added', ...added };

  // Check removed files
  const removed = manifest.skeleton.filesRemoved?.find(f => f.path === filePath);
  if (removed) return { type: 'removed', ...removed };

  // Check modified files
  const modified = manifest.skeleton.filesModified?.find(f => f.path === filePath);
  if (modified) return { type: 'modified', ...modified };

  return null;
}

/**
 * For multi-version jumps (e.g., 8 -> 11), return the chain of manifests to apply.
 * @param {string} fromVersion
 * @param {string} toVersion
 * @returns {Array} Ordered array of manifests (some may be null if data is missing)
 */
export function getTransitionChain(fromVersion, toVersion) {
  const from = String(fromVersion).split('.')[0];
  const to = String(toVersion).split('.')[0];

  const fromIdx = KNOWN_VERSIONS.indexOf(from);
  const toIdx = KNOWN_VERSIONS.indexOf(to);

  if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) {
    return [];
  }

  const chain = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const stepFrom = KNOWN_VERSIONS[i];
    const stepTo = KNOWN_VERSIONS[i + 1];
    const manifest = loadManifest(stepFrom, stepTo);
    chain.push({
      from: stepFrom,
      to: stepTo,
      manifest, // may be null if data file is missing
    });
  }

  return chain;
}

/**
 * Get aggregated composer changes across a multi-version jump.
 * Later version changes override earlier ones for the same package.
 * @param {string} fromVersion
 * @param {string} toVersion
 * @returns {object} Merged composer changes
 */
export function getAggregatedComposerChanges(fromVersion, toVersion) {
  const chain = getTransitionChain(fromVersion, toVersion);

  const merged = {
    requireUpdates: {},
    requireDevUpdates: {},
    additions: {},
    removals: [],
  };

  for (const step of chain) {
    if (!step.manifest?.composer) continue;
    const c = step.manifest.composer;

    // Later versions override earlier ones
    for (const [pkg, versions] of Object.entries(c.requireUpdates || {})) {
      if (merged.requireUpdates[pkg]) {
        merged.requireUpdates[pkg] = { from: merged.requireUpdates[pkg].from, to: versions.to };
      } else {
        merged.requireUpdates[pkg] = { ...versions };
      }
    }

    for (const [pkg, versions] of Object.entries(c.requireDevUpdates || {})) {
      if (merged.requireDevUpdates[pkg]) {
        merged.requireDevUpdates[pkg] = { from: merged.requireDevUpdates[pkg].from, to: versions.to };
      } else {
        merged.requireDevUpdates[pkg] = { ...versions };
      }
    }

    Object.assign(merged.additions, c.additions || {});

    for (const pkg of c.removals || []) {
      if (!merged.removals.includes(pkg)) {
        merged.removals.push(pkg);
      }
    }
  }

  // Remove from removals any package that got re-added later
  merged.removals = merged.removals.filter(pkg =>
    !merged.additions[pkg] && !merged.requireUpdates[pkg]
  );

  return merged;
}

/**
 * Clear the in-memory manifest cache.
 * Useful for testing or after rebuilding manifests.
 */
export function clearCache() {
  manifestCache.clear();
}
